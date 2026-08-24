#!/usr/bin/env bash
# Executes the REAL migration 082 against a PostgreSQL cluster reproducing Supabase's inherited
# default privileges. Cluster destroyed on exit. Nothing here touches production.
set -euo pipefail
PGBIN=/opt/homebrew/opt/postgresql@17/bin
DATA=$(mktemp -d)/pg82; PORT=55497
export PGHOST=127.0.0.1 PGPORT=$PORT PGDATABASE=postgres
cleanup(){ "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c listen_addresses=127.0.0.1" -l "$DATA/log" -w start >/dev/null
PSQL=("$PGBIN/psql" -U postgres -v ON_ERROR_STOP=1 -X -q)
q(){ "${PSQL[@]}" -tAc "$1"; }
fail=0
chk(){ if [ "$2" = "$3" ]; then printf '  ok   %-64s %s\n' "$1" "$3"
       else printf '  FAIL %-64s expected=%s actual=%s\n' "$1" "$2" "$3"; fail=1; fi; }

"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text, avatar_url text, title text,
  exact_job_title text, company text, company_id uuid, role_type text, seniority text, location text,
  bio text, expertise text, interests text[], purposes text[], intro_preferences text[],
  mentorship_role text, open_to_mentorship boolean, open_to_business_solutions boolean,
  -- JSONB, exactly as production. Migration 041 created current_focus_areas jsonb; previous_roles
  -- stores an array of objects. An earlier fixture used text[] and therefore could never have
  -- reproduced the contract this migration pins.
  current_focus_areas jsonb NOT NULL DEFAULT '[]'::jsonb, previous_roles jsonb,
  account_status text DEFAULT 'active',
  profile_complete boolean DEFAULT true, is_admin boolean DEFAULT false, email text);
-- The real discovery predicate's SHAPE: 082 must not change who can see a row.
CREATE FUNCTION public.can_discover_profile(member_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = member_id AND p.profile_complete IS TRUE
                    AND p.account_status = 'active') $$;
CREATE VIEW public.public_profiles WITH (security_invoker = off, security_barrier = on) AS
  SELECT id, full_name, avatar_url, title, exact_job_title, company, company_id,
         role_type, seniority, location, bio, expertise, interests, purposes,
         intro_preferences, mentorship_role, open_to_mentorship,
         open_to_business_solutions, current_focus_areas, previous_roles
  FROM public.profiles WHERE public.can_discover_profile(id);
REVOKE ALL ON TABLE public.public_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.public_profiles TO authenticated;
GRANT ALL ON TABLE public.public_profiles TO service_role;   -- production ACL includes this
SQL

echo "── 0. NEGATIVE CONTROLS: 082 must refuse and roll back completely ──"
set +e
nothing_left(){
  local n
  n=$(q "SELECT
      (SELECT count(*) FROM information_schema.columns WHERE table_name='profiles' AND column_name LIKE '%andrel_connector%')
    + (SELECT count(*) FROM pg_class WHERE relname='member_recognition_events')
    + (SELECT count(*) FROM pg_proc WHERE proname='set_andrel_connector')
    + (SELECT count(*) FROM pg_constraint WHERE conname='profiles_andrel_connector_consistent_chk')
    + (SELECT count(*) FROM pg_indexes WHERE indexname='profiles_andrel_connector_idx')")
  chk "  $1 -> nothing left behind" "0" "$n"
  chk "  $1 -> public_profiles has NOT gained the badge column" "0" \
    "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='public_profiles' AND column_name='is_andrel_connector'")"
}
# 082 refuses without the baseline, so every attempt supplies it the SAME way production will:
# read it from the preflight, hand it over as a session setting. baseline() re-reads it each time so
# a control that changes the view is genuinely testing a CHANGED contract against its OWN baseline
# only when we want it to.
baseline(){ q "SELECT md5(pg_get_viewdef(to_regclass('public.public_profiles'), true))"; }
base_owner(){ q "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.public_profiles'::regclass"; }
base_acl(){ q "SELECT coalesce(array_to_string(relacl::text[], ','), '(NONE)') FROM pg_class WHERE oid='public.public_profiles'::regclass"; }
base_cdp(){ q "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.can_discover_profile(uuid)')"; }
PINNED=""
restore_view(){
  "${PSQL[@]}" -c "DROP VIEW IF EXISTS public.public_profiles;
    CREATE VIEW public.public_profiles WITH (security_invoker = off, security_barrier = on) AS
    SELECT id, full_name, avatar_url, title, exact_job_title, company, company_id, role_type, seniority,
           location, bio, expertise, interests, purposes, intro_preferences, mentorship_role,
           open_to_mentorship, open_to_business_solutions, current_focus_areas, previous_roles
    FROM public.profiles WHERE public.can_discover_profile(id);
    REVOKE ALL ON TABLE public.public_profiles FROM PUBLIC, anon, authenticated;
    GRANT SELECT ON TABLE public.public_profiles TO authenticated;" >/dev/null 2>&1
}
restore_cdp(){
  "${PSQL[@]}" -c "CREATE OR REPLACE FUNCTION public.can_discover_profile(member_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS \$\$
    SELECT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = member_id AND p.profile_complete IS TRUE
                      AND p.account_status = 'active') \$\$;" >/dev/null 2>&1
}
# ─── THE GENERATED TWIN ───────────────────────────────────────────────────────────────────────
# The migration pins PRODUCTION's view md5, owner, ACL and can_discover_profile md5. A local fixture
# cannot reproduce those four values — md5 is not invertible, and the owner/ACL belong to the
# Supabase project. So the harness runs a TWIN of the real file in which ONLY those four literals are
# replaced by the fixture's own, and then proves the substitution touched nothing else.
#
# The COLUMN SIGNATURE is deliberately NOT substituted. The fixture is built to reproduce the exact
# production column contract, so that constant must match untouched — which is the check that proves
# the fixture is a faithful stand-in rather than a convenient one.
mk_twin(){
  local md5="${1:-$PINNED}" owner="${2:-$PINNED_OWNER}" acl="${3:-$PINNED_ACL}" cdp="${4:-$PINNED_CDP}"
  python3 - "$md5" "$owner" "$acl" "$cdp" > "$DATA/twin.sql" <<'PYEOF'
import re, sys
md5, owner, acl, cdp = sys.argv[1:5]
src = open('supabase/migrations/082_andrel_connector.sql').read()
out = src
for var, val in [('c_expect_md5', md5), ('c_expect_owner', owner), ('c_expect_acl', acl), ('c_expect_cdp', cdp)]:
    out, n = re.subn(rf"(  {var}\s+constant text := ')[^']*(';)", lambda m: m.group(1)+val+m.group(2), out, count=1)
    assert n == 1, var
# Prove the substitution changed exactly four lines, all of them baseline constants.
a, b = src.split('\n'), out.split('\n')
assert len(a) == len(b), 'twin changed the line count'
diff = [i for i, (x, y) in enumerate(zip(a, b)) if x != y]
# At most four, and EVERY changed line must be a baseline constant. Fewer than four is legitimate:
# a fixture value that already equals production's (the owner is 'postgres' in both) rewrites to
# itself. What must never happen is a changed line that is not a baseline.
assert len(diff) <= 4, f'twin changed {len(diff)} lines'
for i in diff:
    assert re.match(r"\s*c_expect_(md5|owner|acl|cdp)\s+constant text :=", a[i]), f'unexpected line changed: {a[i]}'
# The column contract is NOT substituted and must survive byte-identically.
assert "19:current_focus_areas:jsonb,20:previous_roles:jsonb" in out, 'column contract altered'
sys.stdout.write(out)
PYEOF
}
try(){
  mk_twin "$@" || { echo blocked; return; }
  "${PSQL[@]}" --single-transaction -f "$DATA/twin.sql" >/dev/null 2>&1 && echo APPLIED || echo blocked
}

# The audited baseline, captured exactly as production will capture it.
PINNED=$(baseline); PINNED_OWNER=$(base_owner); PINNED_ACL=$(base_acl); PINNED_CDP=$(base_cdp)
chk "baseline captured from the deployed view" "32" "$(printf '%s' "$PINNED" | wc -c | tr -d ' ')"

# (0) the migration is SELF-CONTAINED: no runtime setting, no client command, no placeholder.
# Comment lines are excluded: the file EXPLAINS why SET LOCAL is not used, and that sentence is
# the documentation, not a mechanism.
chk "(0) migration has no runtime setting" "0" \
  "$(grep -vE '^\s*--' supabase/migrations/082_andrel_connector.sql | grep -cE 'current_setting|SET LOCAL' || true)"
chk "  and no psql client command" "0" \
  "$(grep -cE '^\\\\[a-z]' supabase/migrations/082_andrel_connector.sql || true)"
chk "  and pins the production column contract verbatim" "1" \
  "$(grep -c '19:current_focus_areas:jsonb,20:previous_roles:jsonb' supabase/migrations/082_andrel_connector.sql || true)"

# (a) view BODY changes but it is still a security-barrier view — the case a marker check misses
"${PSQL[@]}" -c "CREATE OR REPLACE VIEW public.public_profiles WITH (security_invoker = off, security_barrier = on) AS
  SELECT id, full_name, avatar_url, title, exact_job_title, company, company_id, role_type, seniority,
         location, bio, expertise, interests, purposes, intro_preferences, mentorship_role,
         open_to_mentorship, open_to_business_solutions, current_focus_areas, previous_roles
  FROM public.profiles WHERE public.can_discover_profile(id) OR true;" >/dev/null 2>&1
chk "(a) view body loosened (still barrier) -> REFUSED" "blocked" "$(try)"; nothing_left "(a)"
"${PSQL[@]}" -c "CREATE OR REPLACE VIEW public.public_profiles WITH (security_invoker = off, security_barrier = on) AS
  SELECT id, full_name, avatar_url, title, exact_job_title, company, company_id, role_type, seniority,
         location, bio, expertise, interests, purposes, intro_preferences, mentorship_role,
         open_to_mentorship, open_to_business_solutions, current_focus_areas, previous_roles
  FROM public.profiles WHERE public.can_discover_profile(id);" >/dev/null 2>&1

# (b) a column is REORDERED — md5 differs, and the ordered contract catches it independently
"${PSQL[@]}" -c "DROP VIEW public.public_profiles;
  CREATE VIEW public.public_profiles WITH (security_invoker = off, security_barrier = on) AS
  SELECT id, avatar_url, full_name, title, exact_job_title, company, company_id, role_type, seniority,
         location, bio, expertise, interests, purposes, intro_preferences, mentorship_role,
         open_to_mentorship, open_to_business_solutions, current_focus_areas, previous_roles
  FROM public.profiles WHERE public.can_discover_profile(id);
  REVOKE ALL ON TABLE public.public_profiles FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON TABLE public.public_profiles TO authenticated;" >/dev/null 2>&1
chk "(b) a column REORDERED               -> REFUSED" "blocked" "$(try "$(baseline)")"; nothing_left "(b)"

# (c) a column is REMOVED
"${PSQL[@]}" -c "DROP VIEW public.public_profiles;
  CREATE VIEW public.public_profiles WITH (security_invoker = off, security_barrier = on) AS
  SELECT id, full_name, avatar_url, title, exact_job_title, company, company_id, role_type, seniority,
         location, bio, expertise, interests, purposes, intro_preferences, mentorship_role,
         open_to_mentorship, open_to_business_solutions, current_focus_areas
  FROM public.profiles WHERE public.can_discover_profile(id);
  REVOKE ALL ON TABLE public.public_profiles FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON TABLE public.public_profiles TO authenticated;" >/dev/null 2>&1
chk "(c) a column REMOVED                 -> REFUSED" "blocked" "$(try "$(baseline)")"; nothing_left "(c)"

# (d) a column changes TYPE
"${PSQL[@]}" -c "DROP VIEW public.public_profiles;
  CREATE VIEW public.public_profiles WITH (security_invoker = off, security_barrier = on) AS
  SELECT id, full_name, avatar_url, title, exact_job_title, company, company_id, role_type, seniority,
         location, bio, expertise::varchar AS expertise, interests, purposes, intro_preferences,
         mentorship_role, open_to_mentorship, open_to_business_solutions, current_focus_areas, previous_roles
  FROM public.profiles WHERE public.can_discover_profile(id);
  REVOKE ALL ON TABLE public.public_profiles FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON TABLE public.public_profiles TO authenticated;" >/dev/null 2>&1
chk "(d) a column TYPE changed            -> REFUSED" "blocked" "$(try "$(baseline)")"; nothing_left "(d)"
restore_view

# (e) a GRANT changes — anon gains read
"${PSQL[@]}" -c "GRANT SELECT ON TABLE public.public_profiles TO anon" >/dev/null 2>&1
chk "(e) anon granted SELECT on the view  -> REFUSED" "blocked" "$(try)"; nothing_left "(e)"
"${PSQL[@]}" -c "REVOKE ALL ON TABLE public.public_profiles FROM anon" >/dev/null 2>&1

# (f) the OWNER changes
"${PSQL[@]}" -c "CREATE ROLE other_owner NOLOGIN; GRANT other_owner TO postgres;
  ALTER VIEW public.public_profiles OWNER TO other_owner" >/dev/null 2>&1
OWNER_NOW=$(q "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.public_profiles'::regclass")
chk "  owner really did change" "other_owner" "$OWNER_NOW"
# The owner change alone does not move the definition, so this proves the OWNER post-condition fires.
chk "(f) view OWNER changed               -> REFUSED" "blocked" "$(try)"
nothing_left "(f)"
"${PSQL[@]}" -c "ALTER VIEW public.public_profiles OWNER TO postgres" >/dev/null 2>&1

# (g) a view SECURITY OPTION changes
"${PSQL[@]}" -c "ALTER VIEW public.public_profiles SET (security_barrier = off)" >/dev/null 2>&1
chk "(g) security_barrier turned off      -> REFUSED" "blocked" "$(try)"; nothing_left "(g)"
"${PSQL[@]}" -c "ALTER VIEW public.public_profiles SET (security_barrier = on)" >/dev/null 2>&1
"${PSQL[@]}" -c "ALTER VIEW public.public_profiles SET (security_invoker = on)" >/dev/null 2>&1
chk "(h) security_invoker turned on       -> REFUSED" "blocked" "$(try)"; nothing_left "(h)"
"${PSQL[@]}" -c "ALTER VIEW public.public_profiles RESET (security_invoker)" >/dev/null 2>&1

# (i) can_discover_profile CHANGES
"${PSQL[@]}" -c "CREATE OR REPLACE FUNCTION public.can_discover_profile(member_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS \$\$ SELECT true \$\$;" >/dev/null 2>&1
chk "(i) discovery predicate CHANGED      -> REFUSED" "blocked" "$(try)"; nothing_left "(i)"
restore_cdp

# (j) an unexpected OVERLOAD of the discovery predicate
"${PSQL[@]}" -c "CREATE FUNCTION public.can_discover_profile(member_id uuid, x integer) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS \$\$ SELECT false \$\$;" >/dev/null 2>&1
chk "(j) discovery predicate OVERLOADED   -> REFUSED" "blocked" "$(try)"; nothing_left "(j)"
"${PSQL[@]}" -c "DROP FUNCTION public.can_discover_profile(uuid, integer)" >/dev/null 2>&1

# (k) the discovery predicate loses its hardening
"${PSQL[@]}" -c "ALTER FUNCTION public.can_discover_profile(uuid) SECURITY INVOKER" >/dev/null 2>&1
chk "(k) discovery predicate not DEFINER  -> REFUSED" "blocked" "$(try)"; nothing_left "(k)"
"${PSQL[@]}" -c "ALTER FUNCTION public.can_discover_profile(uuid) SECURITY DEFINER" >/dev/null 2>&1
"${PSQL[@]}" -c "ALTER FUNCTION public.can_discover_profile(uuid) RESET search_path" >/dev/null 2>&1
chk "(l) discovery predicate search_path  -> REFUSED" "blocked" "$(try)"; nothing_left "(l)"
"${PSQL[@]}" -c "ALTER FUNCTION public.can_discover_profile(uuid) SET search_path = ''" >/dev/null 2>&1

# (m) the ADMINISTRATOR prerequisite fails — the preflight must BLOCK, since the feature would be
#     unusable. 082 itself still applies: the rollout order is what depends on this, not the DDL.
chk "(m) no eligible administrator -> preflight BLOCKS" "1" \
  "$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/082_preflight.sql 2>&1 | grep -c 'NO_ELIGIBLE_ADMINISTRATOR' || true)"
set -e
set -e

echo "── 1. APPLY 082 on the pristine fixture (the positive control) ──"
PINNED=$(baseline); PINNED_OWNER=$(base_owner); PINNED_ACL=$(base_acl); PINNED_CDP=$(base_cdp)
mk_twin
APPLY_RC=0
APPLY_OUT=$("${PSQL[@]}" --single-transaction -f "$DATA/twin.sql" 2>&1) || APPLY_RC=$?
[ $APPLY_RC -eq 0 ] || printf "  APPLY ERROR:\n%s\n" "$(printf "%s" "$APPLY_OUT" | grep -E "ERROR|DETAIL|CONTEXT" | head -5)"
chk "audited fixture is ADMITTED (controls are not vacuous)" "0" "$APPLY_RC"
chk "re-applying is BLOCKED" "blocked" "$(try "$(baseline)")"

echo "── 2. schema, defaults and consistency ──"
for c in is_andrel_connector andrel_connector_awarded_at andrel_connector_awarded_by; do
  chk "column $c exists" "1" "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='profiles' AND column_name='$c'")"
done
chk "boolean is NOT NULL with default false" "NO|false" \
  "$(q "SELECT is_nullable||'|'||column_default FROM information_schema.columns WHERE table_name='profiles' AND column_name='is_andrel_connector'")"
M1=$(q "INSERT INTO public.profiles(email) VALUES ('m1@t.io') RETURNING id")
M2=$(q "INSERT INTO public.profiles(email) VALUES ('m2@t.io') RETURNING id")
AD=$(q "INSERT INTO public.profiles(email,is_admin) VALUES ('admin@t.io',true) RETURNING id")
NOTAD=$(q "INSERT INTO public.profiles(email) VALUES ('nope@t.io') RETURNING id")
chk "every existing member is unbadged (no backfill)" "0" \
  "$(q "SELECT count(*) FROM public.profiles WHERE is_andrel_connector")"
chk "inconsistent state is REJECTED by the CHECK" "rejected" \
  "$("${PSQL[@]}" -c "UPDATE public.profiles SET is_andrel_connector=true WHERE id='$M1'" >/dev/null 2>&1 && echo ACCEPTED || echo rejected)"
chk "  and a badge with no admin is rejected too" "rejected" \
  "$("${PSQL[@]}" -c "UPDATE public.profiles SET is_andrel_connector=true, andrel_connector_awarded_at=now() WHERE id='$M1'" >/dev/null 2>&1 && echo ACCEPTED || echo rejected)"

echo "── 3. authorization ──"
chk "a NON-admin cannot award" "not_an_administrator" \
  "$(q "SELECT public.set_andrel_connector('$M1','$NOTAD',true,NULL)->>'detail'")"
chk "  and nothing was written" "0" "$(q "SELECT count(*) FROM public.member_recognition_events")"
chk "an admin cannot award to themselves" "self_award" \
  "$(q "SELECT public.set_andrel_connector('$AD','$AD',true,NULL)->>'detail'")"
chk "an unknown member is refused" "member_not_found" \
  "$(q "SELECT public.set_andrel_connector(gen_random_uuid(),'$AD',true,NULL)->>'detail'")"
chk "still nothing written" "0" "$(q "SELECT count(*) FROM public.member_recognition_events")"

echo "── 4. award / remove / idempotency ──"
chk "award" "awarded" "$(q "SELECT public.set_andrel_connector('$M1','$AD',true,'thoughtful connector')->>'outcome'")"
chk "  all three fields set consistently" "1" \
  "$(q "SELECT count(*) FROM public.profiles WHERE id='$M1' AND is_andrel_connector AND andrel_connector_awarded_at IS NOT NULL AND andrel_connector_awarded_by='$AD'")"
chk "  exactly one audit row" "1" "$(q "SELECT count(*) FROM public.member_recognition_events WHERE member_id='$M1'")"
chk "  recording the action and the admin" "awarded|$AD" \
  "$(q "SELECT action||'|'||admin_id FROM public.member_recognition_events WHERE member_id='$M1'")"
chk "  and the internal reason" "thoughtful connector" \
  "$(q "SELECT reason FROM public.member_recognition_events WHERE member_id='$M1'")"
chk "re-award is idempotent" "unchanged" "$(q "SELECT public.set_andrel_connector('$M1','$AD',true,NULL)->>'outcome'")"
chk "  writing NO second audit row" "1" "$(q "SELECT count(*) FROM public.member_recognition_events WHERE member_id='$M1'")"
echo "  -- concurrent double submission --"
for i in 1 2 3 4 5 6; do ("$PGBIN/psql" -U postgres -X -q -c "SELECT public.set_andrel_connector('$M2','$AD',true,NULL)" >/dev/null 2>&1 || true) & done; wait
chk "6 concurrent awards -> exactly ONE audit row" "1" "$(q "SELECT count(*) FROM public.member_recognition_events WHERE member_id='$M2'")"
chk "removal" "removed" "$(q "SELECT public.set_andrel_connector('$M1','$AD',false,'no longer active')->>'outcome'")"
chk "  active fields cleared" "1" \
  "$(q "SELECT count(*) FROM public.profiles WHERE id='$M1' AND NOT is_andrel_connector AND andrel_connector_awarded_at IS NULL AND andrel_connector_awarded_by IS NULL")"
chk "  history PRESERVED (both events)" "2" "$(q "SELECT count(*) FROM public.member_recognition_events WHERE member_id='$M1'")"
chk "re-removal is idempotent" "unchanged" "$(q "SELECT public.set_andrel_connector('$M1','$AD',false,NULL)->>'outcome'")"
chk "  still two events" "2" "$(q "SELECT count(*) FROM public.member_recognition_events WHERE member_id='$M1'")"

echo "── 5. the audit is append-only ──"
chk "UPDATE refused" "rejected" \
  "$("${PSQL[@]}" -c "UPDATE public.member_recognition_events SET reason='x'" >/dev/null 2>&1 && echo ACCEPTED || echo rejected)"
chk "DELETE refused" "rejected" \
  "$("${PSQL[@]}" -c "DELETE FROM public.member_recognition_events" >/dev/null 2>&1 && echo ACCEPTED || echo rejected)"
chk "TRUNCATE refused" "rejected" \
  "$("${PSQL[@]}" -c "TRUNCATE public.member_recognition_events" >/dev/null 2>&1 && echo ACCEPTED || echo rejected)"
for r in anon authenticated; do
  for v in SELECT INSERT UPDATE DELETE; do
    chk "$r cannot $v the audit" "f" "$(q "SELECT has_table_privilege('$r','public.member_recognition_events','$v')")"
  done
done
chk "RLS enabled with zero policies" "true|0" \
  "$(q "SELECT relrowsecurity::text||'|'||(SELECT count(*) FROM pg_policies WHERE tablename='member_recognition_events') FROM pg_class WHERE relname='member_recognition_events'")"

echo "── 6. privacy ──"
chk "public_profiles exposes the boolean" "1" \
  "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='public_profiles' AND column_name='is_andrel_connector'")"
for c in andrel_connector_awarded_at andrel_connector_awarded_by; do
  chk "  and NOT $c" "0" "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='public_profiles' AND column_name='$c'")"
done
chk "the view is still a security_barrier definer view" "t" \
  "$(q "SELECT EXISTS (SELECT 1 FROM pg_options_to_table(c.reloptions) o WHERE o.option_name='security_barrier' AND lower(o.option_value) IN ('true','on','1'))
             AND NOT EXISTS (SELECT 1 FROM pg_options_to_table(c.reloptions) o WHERE o.option_name='security_invoker' AND lower(o.option_value) IN ('true','on','1'))
        FROM pg_class c WHERE c.relname='public_profiles'")"
chk "row visibility still decided by can_discover_profile" "1" \
  "$(q "SELECT count(*) FROM pg_views WHERE viewname='public_profiles' AND definition LIKE '%can_discover_profile%'")"
# An UNDISCOVERABLE badged member must not leak the badge.
HID=$(q "INSERT INTO public.profiles(email,profile_complete) VALUES ('hidden@t.io',false) RETURNING id")
q "SELECT public.set_andrel_connector('$HID','$AD',true,NULL)" >/dev/null
chk "a badged but UNDISCOVERABLE profile is absent from the view" "0" \
  "$(q "SELECT count(*) FROM public.public_profiles WHERE id='$HID'")"
chk "  even though the base row does hold the badge" "1" \
  "$(q "SELECT count(*) FROM public.profiles WHERE id='$HID' AND is_andrel_connector")"
chk "authenticated cannot write the badge columns" "f" \
  "$(q "SELECT has_column_privilege('authenticated','public.profiles','is_andrel_connector','UPDATE')")"
for r in anon authenticated; do
  chk "$r cannot execute set_andrel_connector" "f" \
    "$(q "SELECT has_function_privilege('$r', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='set_andrel_connector'")"
done
chk "service_role CAN execute it" "t" \
  "$(q "SELECT has_function_privilege('service_role', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='set_andrel_connector'")"
chk "writer has an empty search_path" "t" \
  "$(q "SELECT 'search_path=\"\"' = ANY(proconfig) FROM pg_proc WHERE proname='set_andrel_connector'")"
chk "writer is SECURITY DEFINER" "t" "$(q "SELECT prosecdef FROM pg_proc WHERE proname='set_andrel_connector'")"
chk "writer not executable by PUBLIC" "0" \
  "$(q "SELECT count(*) FROM pg_proc p, unnest(coalesce(p.proacl,ARRAY[]::aclitem[])) a WHERE p.proname='set_andrel_connector' AND a::text LIKE '=%'")"

echo "── 7. audits execute against a real catalog ──"
for a in preflight postapply; do
  OUT=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/082_$a.sql 2>&1 || true)
  chk "082_$a runs with no ERROR" "0" "$(printf '%s' "$OUT" | grep -cE '(ERROR|FATAL):' || true)"
  [ "$(printf '%s' "$OUT" | grep -cE '(ERROR|FATAL):' || true)" = "0" ] || printf '    %s\n' "$(printf '%s' "$OUT" | grep -E '(ERROR|LINE|HINT)' | head -3)"
done
# The post-apply audit pins production's can_discover_profile md5 too, which the fixture cannot
# reproduce. Same twin discipline: substitute ONLY that literal and prove nothing else moved.
python3 - "$(base_cdp)" > "$DATA/postapply_twin.sql" <<'PYEOF'
import sys
cdp = sys.argv[1]
src = open('supabase/audits/082_postapply.sql').read()
out = src.replace('43624624c629e2d67978db0e9745ae1c', cdp)
a, b = src.split('\n'), out.split('\n')
diff = [i for i, (x, y) in enumerate(zip(a, b)) if x != y]
assert all('43624624c629e2d67978db0e9745ae1c' in a[i] for i in diff), 'twin changed a non-baseline line'
sys.stdout.write(out)
PYEOF
POST=$("$PGBIN/psql" -U postgres -X -q -f "$DATA/postapply_twin.sql" 2>&1 || true)
chk "  post-apply verdict" "1" "$(printf '%s' "$POST" | grep -c '"overall_verdict": "PASS"' || true)"
chk "  appended ONLY the boolean" "1" "$(printf '%s' "$POST" | grep -c '"appended_only_the_boolean": true' || true)"
chk "  both JSONB fields kept their ordinals and types" "1" \
  "$(printf '%s' "$POST" | grep -c '19:current_focus_areas:jsonb,20:previous_roles:jsonb,21:is_andrel_connector:boolean' || true)"
chk "  discovery predicate unchanged" "1" "$(printf '%s' "$POST" | grep -c '"unchanged": true' || true)"
chk "  no inconsistent badge rows" "1" "$(printf '%s' "$POST" | grep -c '"inconsistent_badge_rows_DEFECT": 0' || true)"
chk "  private columns absent from the member view" "1" \
  "$(printf '%s' "$POST" | grep -c '"private_columns_exposed_DEFECT": 0' || true)"

echo "── 8. no badge state can expand discoverability ──"
# A blocked / incomplete / deactivated member must stay invisible whether badged or not, and the
# badge must never be what makes a row appear.
VIS0=$(q "SELECT count(*) FROM public.public_profiles")
for state in "profile_complete=false" "account_status='deactivated'"; do
  T=$(q "INSERT INTO public.profiles(email) VALUES ('vis_$RANDOM@t.io') RETURNING id")
  q "SELECT public.set_andrel_connector('$T','$AD',true,NULL)" >/dev/null
  chk "badged member is visible while discoverable" "1" "$(q "SELECT count(*) FROM public.public_profiles WHERE id='$T'")"
  "${PSQL[@]}" -c "UPDATE public.profiles SET $state WHERE id='$T'" >/dev/null
  chk "  once undiscoverable ($state) the badge does NOT keep it visible" "0" \
    "$(q "SELECT count(*) FROM public.public_profiles WHERE id='$T'")"
  chk "  and the base row still holds the badge" "1" "$(q "SELECT count(*) FROM public.profiles WHERE id='$T' AND is_andrel_connector")"
done
chk "the visible population did not grow because of any badge" "$VIS0" "$(q "SELECT count(*) FROM public.public_profiles")"

echo "── 9. the private reason ──"
R1=$(q "INSERT INTO public.profiles(email) VALUES ('r1@t.io') RETURNING id")
chk "a blank reason is stored as NULL" "awarded" "$(q "SELECT public.set_andrel_connector('$R1','$AD',true,'   ')->>'outcome'")"
chk "  reason IS NULL" "1" "$(q "SELECT count(*) FROM public.member_recognition_events WHERE member_id='$R1' AND reason IS NULL")"
q "SELECT public.set_andrel_connector('$R1','$AD',false,NULL)" >/dev/null
chk "a reason is TRIMMED" "trimmed note" \
  "$(q "SELECT public.set_andrel_connector('$R1','$AD',true,'   trimmed note   ')->>'outcome'" >/dev/null; q "SELECT reason FROM public.member_recognition_events WHERE member_id='$R1' AND action='awarded' ORDER BY created_at DESC LIMIT 1")"
q "SELECT public.set_andrel_connector('$R1','$AD',false,NULL)" >/dev/null
chk "an OVERSIZED reason is refused safely" "reason_too_long" \
  "$(q "SELECT public.set_andrel_connector('$R1','$AD',true,repeat('x',501))->>'detail'")"
chk "  and nothing was written for it" "0" \
  "$(q "SELECT count(*) FROM public.profiles WHERE id='$R1' AND is_andrel_connector")"
chk "the column itself is bounded too" "rejected" \
  "$("${PSQL[@]}" -c "INSERT INTO public.member_recognition_events(member_id,action,admin_id,reason) VALUES ('$R1','awarded','$AD',repeat('y',501))" >/dev/null 2>&1 && echo ACCEPTED || echo rejected)"
chk "no member-facing view exposes the reason" "0" \
  "$(q "SELECT count(*) FROM pg_views v JOIN information_schema.columns c ON c.table_schema=v.schemaname AND c.table_name=v.viewname WHERE v.schemaname='public' AND c.column_name='reason'")"

# These controls run AFTER the positive control, so the badge objects legitimately exist. What must
# hold here is narrower and just as important: the refusal left the VIEW alone.
view_untouched(){
  chk "  $1 -> the view did NOT gain the badge column" "0" \
    "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='public_profiles' AND column_name='is_andrel_connector'")"
}

echo "── 10. the JSONB contract is pinned exactly, not loosely ──"
# These are the controls the production blocker demanded: the two columns are JSONB and only JSONB.
chk "the fixture reproduces the production column contract UNSUBSTITUTED" "1" \
  "$(q "SELECT (string_agg(a.attnum::text||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod), ',' ORDER BY a.attnum)
        = '1:id:uuid,2:full_name:text,3:avatar_url:text,4:title:text,5:exact_job_title:text,6:company:text,7:company_id:uuid,8:role_type:text,9:seniority:text,10:location:text,11:bio:text,12:expertise:text,13:interests:text[],14:purposes:text[],15:intro_preferences:text[],16:mentorship_role:text,17:open_to_mentorship:boolean,18:open_to_business_solutions:boolean,19:current_focus_areas:jsonb,20:previous_roles:jsonb,21:is_andrel_connector:boolean')::int
        FROM pg_attribute a WHERE a.attrelid='public.public_profiles'::regclass AND a.attnum>0 AND NOT a.attisdropped")"
chk "the migration never casts either JSONB column" "0" \
  "$(grep -cE 'current_focus_areas::|previous_roles::|to_jsonb\(current_focus_areas|current_focus_areas.*text\[\]|previous_roles.*text\[\]' supabase/migrations/082_andrel_connector.sql || true)"
chk "  and never alters their type" "0" \
  "$(grep -cE 'ALTER COLUMN (current_focus_areas|previous_roles)' supabase/migrations/082_andrel_connector.sql || true)"

set +e
# JSONB -> text[] must be REFUSED
"${PSQL[@]}" -c "DROP VIEW public.public_profiles;
  CREATE VIEW public.public_profiles WITH (security_invoker = off, security_barrier = on) AS
  SELECT id, full_name, avatar_url, title, exact_job_title, company, company_id, role_type, seniority,
         location, bio, expertise, interests, purposes, intro_preferences, mentorship_role,
         open_to_mentorship, open_to_business_solutions,
         ARRAY(SELECT jsonb_array_elements_text(current_focus_areas)) AS current_focus_areas,
         ARRAY[]::text[] AS previous_roles
  FROM public.profiles WHERE public.can_discover_profile(id);
  REVOKE ALL ON TABLE public.public_profiles FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON TABLE public.public_profiles TO authenticated;
  GRANT ALL ON TABLE public.public_profiles TO service_role;" >/dev/null 2>&1
chk "(n) JSONB changed to text[]          -> REFUSED" "blocked" "$(try "$(baseline)" "$(base_owner)" "$(base_acl)")"
view_untouched "(n)"

# a CAST that preserves jsonb-ness but changes the expression must still be refused
"${PSQL[@]}" -c "DROP VIEW public.public_profiles;
  CREATE VIEW public.public_profiles WITH (security_invoker = off, security_barrier = on) AS
  SELECT id, full_name, avatar_url, title, exact_job_title, company, company_id, role_type, seniority,
         location, bio, expertise, interests, purposes, intro_preferences, mentorship_role,
         open_to_mentorship, open_to_business_solutions,
         COALESCE(current_focus_areas, '[]'::jsonb) AS current_focus_areas,
         COALESCE(previous_roles, '[]'::jsonb) AS previous_roles
  FROM public.profiles WHERE public.can_discover_profile(id);
  REVOKE ALL ON TABLE public.public_profiles FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON TABLE public.public_profiles TO authenticated;
  GRANT ALL ON TABLE public.public_profiles TO service_role;" >/dev/null 2>&1
chk "(o) a JSONB field wrapped in an expression -> REFUSED" "blocked" "$(try "$(baseline)" "$(base_owner)" "$(base_acl)")"
view_untouched "(o)"

# reordering the two JSONB fields must be refused
"${PSQL[@]}" -c "DROP VIEW public.public_profiles;
  CREATE VIEW public.public_profiles WITH (security_invoker = off, security_barrier = on) AS
  SELECT id, full_name, avatar_url, title, exact_job_title, company, company_id, role_type, seniority,
         location, bio, expertise, interests, purposes, intro_preferences, mentorship_role,
         open_to_mentorship, open_to_business_solutions, previous_roles, current_focus_areas
  FROM public.profiles WHERE public.can_discover_profile(id);
  REVOKE ALL ON TABLE public.public_profiles FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON TABLE public.public_profiles TO authenticated;
  GRANT ALL ON TABLE public.public_profiles TO service_role;" >/dev/null 2>&1
chk "(p) the two JSONB fields REORDERED   -> REFUSED" "blocked" "$(try "$(baseline)" "$(base_owner)" "$(base_acl)")"
view_untouched "(p)"
set -e

echo
[ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "FAILURES PRESENT"; exit 1; }
