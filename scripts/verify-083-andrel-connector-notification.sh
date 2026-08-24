#!/usr/bin/env bash
# Executes the REAL migrations 082 THEN 083 against a PostgreSQL cluster reproducing Supabase's
# inherited default privileges. Cluster destroyed on exit. Nothing here touches production.
set -euo pipefail
PGBIN=/opt/homebrew/opt/postgresql@17/bin
DATA=$(mktemp -d)/pg83; PORT=55503
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

-- The notification surface, in the shape the deployed table has, plus the migration-006 partial
-- unique index that IS the exact-once guarantee.
-- Supabase's auth.uid(); the RLS policies below are the deployed ones and reference it.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, type text NOT NULL, title text, body text, link text,
  data jsonb, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX notifications_user_type_dedupe_key_uniq
  ON public.notifications (user_id, type, (data->>'dedupeKey'))
  WHERE data->>'dedupeKey' IS NOT NULL AND data->>'dedupeKey' <> '';
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
-- Deployed posture: a member reads only their OWN notifications, and may only mark them read.
CREATE POLICY notifications_select_own ON public.notifications FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY notifications_update_own ON public.notifications FOR UPDATE TO authenticated
  USING (user_id = auth.uid());
-- DELIBERATELY LEFT UNSAFE. ALTER DEFAULT PRIVILEGES above already handed anon and authenticated
-- ALL on this table, and that is the realistic inherited state of a Supabase table that predates the
-- migration files. Revoking it here would mean the correction in 083 is never exercised — the
-- fixture would be testing a posture nobody has.
GRANT SELECT, UPDATE ON public.notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO service_role;
SQL


# Shared helpers, reused verbatim from the 082 harness so the two agree by construction.
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
  "${PSQL[@]}" -f "$DATA/twin.sql" >/dev/null 2>&1 && echo APPLIED || echo blocked
}

set -e

echo "── 1. APPLY 082 (prerequisite), then verify the pinned writer baseline ──"
PINNED=$(baseline); PINNED_OWNER=$(base_owner); PINNED_ACL=$(base_acl); PINNED_CDP=$(base_cdp)
mk_twin
"${PSQL[@]}" -f "$DATA/twin.sql" >/dev/null
chk "post-082 set_andrel_connector md5" "2509f15ab6b2a976355fb4329bec1704" \
  "$(q "SELECT md5(prosrc) FROM pg_proc WHERE proname='set_andrel_connector'")"
chk "post-082 length(prosrc)" "3277" "$(q "SELECT length(prosrc) FROM pg_proc WHERE proname='set_andrel_connector'")"

echo "── 2. NEGATIVE CONTROLS: 083 must refuse and roll back completely ──"
set +e
# No --single-transaction: 083 carries its own BEGIN;/COMMIT;. Nesting them lets the file's COMMIT
# land inside psql's wrapper, so work can commit before a later statement fails — which is exactly
# how an earlier run of this harness silently applied 083 while reporting "blocked".
try83(){ "${PSQL[@]}" -f supabase/migrations/083_andrel_connector_notification.sql >/dev/null 2>&1 && echo APPLIED || echo blocked; }
# Query by SIGNATURE, not by name: control (f) deliberately creates an overload, and a name-only
# lookup would read that overload's body instead of the writer's.
writer_unchanged(){
  chk "  $1 -> writer body still the post-082 one" "2509f15ab6b2a976355fb4329bec1704" \
    "$(q "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')")"
  chk "  $1 -> writer does not notify" "0" \
    "$(q "SELECT count(*) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)') AND prosrc LIKE '%INSERT INTO public.notifications%'")"
}
# 082 is idempotency-guarded and REFUSES to re-apply once its columns exist, so re-running the file
# restores nothing and every later control would silently test a drifted writer. Restore from the
# extracted function definition instead, and PROVE the restore worked.
awk '/^CREATE OR REPLACE FUNCTION public.set_andrel_connector\(/,/^\$fn\$;/' \
  supabase/migrations/082_andrel_connector.sql > "$DATA/writer082.sql"
cat >> "$DATA/writer082.sql" <<'ACL82'
REVOKE ALL ON FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) TO service_role;
ACL82
restore_writer(){ "${PSQL[@]}" -f "$DATA/writer082.sql" >/dev/null 2>&1; }
restore_writer
chk "restore_writer really restores the post-082 body" "2509f15ab6b2a976355fb4329bec1704" \
  "$(q "SELECT md5(prosrc) FROM pg_proc WHERE proname='set_andrel_connector'")"

# (a) the exact-once index is missing — the guarantee would silently degrade
"${PSQL[@]}" -c "DROP INDEX public.notifications_user_type_dedupe_key_uniq" >/dev/null 2>&1
chk "(a) dedupe unique index absent   -> REFUSED" "blocked" "$(try83)"; writer_unchanged "(a)"; restore_writer
"${PSQL[@]}" -c "CREATE UNIQUE INDEX notifications_user_type_dedupe_key_uniq
  ON public.notifications (user_id, type, (data->>'dedupeKey'))
  WHERE data->>'dedupeKey' IS NOT NULL AND data->>'dedupeKey' <> ''" >/dev/null 2>&1

# (b) the writer body has drifted
"${PSQL[@]}" -c "$(sed 's/self_award/self_award2/' "$DATA/writer082.sql")" >/dev/null 2>&1
chk "(b) writer body drifted          -> REFUSED" "blocked" "$(try83)"
chk "  (b) -> writer still not notifying" "0" \
  "$(q "SELECT count(*) FROM pg_proc WHERE proname='set_andrel_connector' AND prosrc LIKE '%INSERT INTO public.notifications%'")"
restore_writer
chk "  (b) -> restored" "2509f15ab6b2a976355fb4329bec1704" \
  "$(q "SELECT md5(prosrc) FROM pg_proc WHERE proname='set_andrel_connector'")"

# (c) SECURITY DEFINER removed
"${PSQL[@]}" -c "ALTER FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) SECURITY INVOKER" >/dev/null 2>&1
chk "(c) SECURITY DEFINER removed     -> REFUSED" "blocked" "$(try83)"; writer_unchanged "(c)"; restore_writer
"${PSQL[@]}" -c "ALTER FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) SECURITY DEFINER" >/dev/null 2>&1

# (d) empty search_path removed
"${PSQL[@]}" -c "ALTER FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) RESET search_path" >/dev/null 2>&1
chk "(d) empty search_path removed    -> REFUSED" "blocked" "$(try83)"; writer_unchanged "(d)"; restore_writer
"${PSQL[@]}" -c "ALTER FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) SET search_path = ''" >/dev/null 2>&1

# (e) a browser role can execute the writer
"${PSQL[@]}" -c "GRANT EXECUTE ON FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) TO authenticated" >/dev/null 2>&1
chk "(e) authenticated can execute    -> REFUSED" "blocked" "$(try83)"; writer_unchanged "(e)"; restore_writer
"${PSQL[@]}" -c "REVOKE ALL ON FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) FROM authenticated" >/dev/null 2>&1

# (f) an unexpected overload
"${PSQL[@]}" -c "CREATE FUNCTION public.set_andrel_connector(p_member_id uuid, p_admin_id uuid, p_enabled boolean) RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = '' AS \$\$ SELECT '{}'::jsonb \$\$;" >/dev/null 2>&1
chk "(f) unexpected overload          -> REFUSED" "blocked" "$(try83)"; writer_unchanged "(f)"; restore_writer
"${PSQL[@]}" -c "DROP FUNCTION public.set_andrel_connector(uuid, uuid, boolean)" >/dev/null 2>&1

# (h) a browser-applicable INSERT policy exists — 083 refuses rather than deleting someone's policy
"${PSQL[@]}" -c "CREATE POLICY notifications_insert_own ON public.notifications FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid())" >/dev/null 2>&1
chk "(h) browser INSERT policy exists -> REFUSED" "blocked" "$(try83)"; writer_unchanged "(h)"; restore_writer
chk "  (h) -> the policy was NOT deleted" "1" \
  "$(q "SELECT count(*) FROM pg_policies WHERE tablename='notifications' AND policyname='notifications_insert_own'")"
"${PSQL[@]}" -c "DROP POLICY notifications_insert_own ON public.notifications" >/dev/null 2>&1

# (i) RLS disabled
"${PSQL[@]}" -c "ALTER TABLE public.notifications DISABLE ROW LEVEL SECURITY" >/dev/null 2>&1
chk "(i) notifications RLS disabled  -> REFUSED" "blocked" "$(try83)"; writer_unchanged "(i)"; restore_writer
"${PSQL[@]}" -c "ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY" >/dev/null 2>&1

# (j) service_role would lose a privilege the trusted writers need
"${PSQL[@]}" -c "REVOKE INSERT ON public.notifications FROM service_role" >/dev/null 2>&1
chk "(j) service_role cannot INSERT  -> REFUSED" "blocked" "$(try83)"; writer_unchanged "(j)"; restore_writer
"${PSQL[@]}" -c "GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO service_role" >/dev/null 2>&1

# (g) the notifications table is missing a column the insert needs
"${PSQL[@]}" -c "ALTER TABLE public.notifications DROP COLUMN link" >/dev/null 2>&1
chk "(g) notifications.link absent    -> REFUSED" "blocked" "$(try83)"; writer_unchanged "(g)"; restore_writer
"${PSQL[@]}" -c "ALTER TABLE public.notifications ADD COLUMN link text" >/dev/null 2>&1
set -e

echo "── 2b. inherited grants are PLANNED REMEDIATIONS, not blockers ──"
# A BLOCKER must always mean "do not apply". The inherited over-grants are the REASON to apply, so
# they belong in planned_remediations and must leave the verdict at PASS.
PRE0=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/083_preflight.sql 2>&1 || true)
chk "preflight runs with no ERROR" "0" "$(printf '%s' "$PRE0" | grep -cE '(ERROR|FATAL):' || true)"
chk "authenticated DOES hold INSERT (inherited)" "t" "$(q "SELECT has_table_privilege('authenticated','public.notifications','INSERT')")"
chk "  verdict is PASS anyway" "1" "$(printf '%s' "$PRE0" | grep -c '"overall_verdict": "PASS"' || true)"
chk "  blocker_count is 0" "1" "$(printf '%s' "$PRE0" | grep -c '"blocker_count": 0' || true)"
chk "  the inherited grants appear as planned remediations" "1" \
  "$(printf '%s' "$PRE0" | grep -c 'REVOKE_INSERT_FROM_authenticated' || true)"
chk "  including the anon read" "1" "$(printf '%s' "$PRE0" | grep -c 'REVOKE_SELECT_FROM_anon' || true)"
chk "  and the UPDATE narrowing" "1" "$(printf '%s' "$PRE0" | grep -c 'NARROW_UPDATE_TO_read_at_FOR_authenticated' || true)"
chk "  the exact transition is reported" "1" "$(printf '%s' "$PRE0" | grep -c '"expected_after_083"' || true)"

echo "  -- but a TRUE blocker still blocks --"
"${PSQL[@]}" -c "CREATE POLICY tmp_ins ON public.notifications FOR INSERT TO authenticated WITH CHECK (true)" >/dev/null 2>&1
B1=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/083_preflight.sql 2>&1 || true)
chk "browser INSERT policy -> BLOCKER" "1" "$(printf '%s' "$B1" | grep -c '"overall_verdict": "BLOCKER"' || true)"
chk "  named" "1" "$(printf '%s' "$B1" | grep -c 'BROWSER_INSERT_OR_ALL_POLICY' || true)"
"${PSQL[@]}" -c "DROP POLICY tmp_ins ON public.notifications" >/dev/null 2>&1

"${PSQL[@]}" -c "GRANT UPDATE (title) ON public.notifications TO authenticated" >/dev/null 2>&1
B2=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/083_preflight.sql 2>&1 || true)
chk "a privilege OUTSIDE the correction set -> BLOCKER" "1" "$(printf '%s' "$B2" | grep -c '"overall_verdict": "BLOCKER"' || true)"
chk "  named" "1" "$(printf '%s' "$B2" | grep -c 'UNEXPECTED_BROWSER_COLUMN_GRANT' || true)"
chk "  and 083 itself refuses it" "blocked" "$(try83)"
"${PSQL[@]}" -c "REVOKE UPDATE (title) ON public.notifications FROM authenticated" >/dev/null 2>&1

"${PSQL[@]}" -c "CREATE FUNCTION public.tg_notif() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NEW; END \$\$;
  CREATE TRIGGER tmp_notif_trg BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.tg_notif();" >/dev/null 2>&1
B3=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/083_preflight.sql 2>&1 || true)
chk "an unexpected TRIGGER -> BLOCKER" "1" "$(printf '%s' "$B3" | grep -c 'UNEXPECTED_TRIGGER_ON_NOTIFICATIONS' || true)"
chk "  and 083 itself refuses it" "blocked" "$(try83)"
"${PSQL[@]}" -c "DROP TRIGGER tmp_notif_trg ON public.notifications; DROP FUNCTION public.tg_notif()" >/dev/null 2>&1
PRE0=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/083_preflight.sql 2>&1 || true)
chk "verdict returns to PASS once the true blockers are gone" "1" \
  "$(printf '%s' "$PRE0" | grep -c '"overall_verdict": "PASS"' || true)"

echo "── 3. APPLY 083 on the pristine fixture (the positive control) ──"
APPLY_RC=0
APPLY_OUT=$("${PSQL[@]}" -f supabase/migrations/083_andrel_connector_notification.sql 2>&1) || APPLY_RC=$?
[ $APPLY_RC -eq 0 ] || printf "  APPLY ERROR:\n%s\n" "$(printf '%s' "$APPLY_OUT" | grep -E 'ERROR|CONTEXT' | head -4)"
chk "audited fixture is ADMITTED (controls are not vacuous)" "0" "$APPLY_RC"
chk "re-applying is BLOCKED" "blocked" "$(try83)"
chk "nobody was notified during apply" "0" "$(q "SELECT count(*) FROM public.notifications")"
chk "no badge was awarded during apply" "0" "$(q "SELECT count(*) FROM public.profiles WHERE is_andrel_connector")"
chk "the writer kept its signature" "p_member_id uuid, p_admin_id uuid, p_enabled boolean, p_reason text" \
  "$(q "SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname='set_andrel_connector'")"
chk "  and its result type" "jsonb" "$(q "SELECT pg_get_function_result(oid) FROM pg_proc WHERE proname='set_andrel_connector'")"
chk "  and is still SECURITY DEFINER with an empty search_path" "true|true" \
  "$(q "SELECT prosecdef::text||'|'||('search_path=\"\"' = ANY(proconfig))::text FROM pg_proc WHERE proname='set_andrel_connector'")"
for r in anon authenticated; do
  chk "  $r still cannot execute it" "f" \
    "$(q "SELECT has_function_privilege('$r', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='set_andrel_connector'")"
done
chk "  no overload was created" "1" \
  "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='set_andrel_connector'")"

echo "  -- the narrow privilege correction --"
for v in INSERT DELETE TRUNCATE; do
  for r in anon authenticated; do
    chk "  $r can no longer $v" "f" "$(q "SELECT has_table_privilege('$r','public.notifications','$v')")"
  done
done
chk "  PUBLIC holds no write grant" "0" \
  "$(q "SELECT count(*) FROM pg_class c, unnest(coalesce(c.relacl, ARRAY[]::aclitem[])) a WHERE c.oid='public.notifications'::regclass AND a::text LIKE '=%' AND split_part(a::text,'/',1) ~ '[aw]'")"
chk "  the bell can still READ" "t" "$(q "SELECT has_table_privilege('authenticated','public.notifications','SELECT')")"
chk "  mark-as-read still works (read_at)" "t" \
  "$(q "SELECT has_column_privilege('authenticated','public.notifications','read_at','UPDATE')")"
for c in title body link data type user_id created_at; do
  chk "  a member cannot rewrite $c" "f" \
    "$(q "SELECT has_column_privilege('authenticated','public.notifications','$c','UPDATE')")"
done
for v in SELECT INSERT UPDATE; do
  chk "  service_role kept $v" "t" "$(q "SELECT has_table_privilege('service_role','public.notifications','$v')")"
done
chk "  the member SELECT policy is intact" "1" \
  "$(q "SELECT count(*) FROM pg_policies WHERE tablename='notifications' AND cmd='SELECT' AND qual LIKE '%auth.uid()%'")"
chk "  the member UPDATE policy is intact" "1" \
  "$(q "SELECT count(*) FROM pg_policies WHERE tablename='notifications' AND cmd='UPDATE' AND qual LIKE '%auth.uid()%'")"
chk "  a trusted service_role INSERT still succeeds" "ok" \
  "$("${PSQL[@]}" -c "SET LOCAL ROLE service_role; INSERT INTO public.notifications(user_id,type,title,body) VALUES (gen_random_uuid(),'new_batch','t','b')" >/dev/null 2>&1 && echo ok || echo BLOCKED)"
"${PSQL[@]}" -c "DELETE FROM public.notifications WHERE type='new_batch'" >/dev/null

echo "── 4. exact-once, in one transaction ──"
M1=$(q "INSERT INTO public.profiles(email) VALUES ('n1@t.io') RETURNING id")
M2=$(q "INSERT INTO public.profiles(email) VALUES ('n2@t.io') RETURNING id")
AD=$(q "INSERT INTO public.profiles(email,is_admin) VALUES ('admin@t.io',true) RETURNING id")

chk "award" "awarded" "$(q "SELECT public.set_andrel_connector('$M1','$AD',true,'note')->>'outcome'")"
chk "  one recognition event" "1" "$(q "SELECT count(*) FROM public.member_recognition_events WHERE member_id='$M1'")"
chk "  one notification" "1" "$(q "SELECT count(*) FROM public.notifications WHERE user_id='$M1'")"
chk "  keyed to that recognition event" "1" \
  "$(q "SELECT count(*) FROM public.notifications n JOIN public.member_recognition_events e ON e.id::text = n.data->>'dedupeKey' WHERE n.user_id='$M1' AND e.member_id='$M1' AND e.action='awarded'")"
chk "  exact title" "You've been recognized as an Andrel Connector" "$(q "SELECT title FROM public.notifications WHERE user_id='$M1'")"
chk "  exact body" "Thank you for thoughtfully helping grow the Andrel community by inviting engaged professionals." \
  "$(q "SELECT body FROM public.notifications WHERE user_id='$M1'")"
chk "  links to the member's own profile" "/dashboard/profile" "$(q "SELECT link FROM public.notifications WHERE user_id='$M1'")"
chk "  type" "andrel_connector_awarded" "$(q "SELECT type FROM public.notifications WHERE user_id='$M1'")"
chk "  carries NO admin reason" "0" "$(q "SELECT count(*) FROM public.notifications WHERE user_id='$M1' AND data::text LIKE '%note%'")"
chk "  carries NO referral or invitee detail" "0" \
  "$(q "SELECT count(*) FROM public.notifications WHERE user_id='$M1' AND (data::text ~* 'referral|invit|count|admin_id')")"
chk "  never claims the award was automatic" "0" \
  "$(q "SELECT count(*) FROM public.notifications WHERE user_id='$M1' AND (title||body) ~* 'automat'")"
chk "  says Andrel Connector" "1" "$(q "SELECT count(*) FROM public.notifications WHERE user_id='$M1' AND title LIKE '%Andrel Connector%'")"

chk "retry after success is a no-op" "unchanged" "$(q "SELECT public.set_andrel_connector('$M1','$AD',true,NULL)->>'outcome'")"
chk "  still one notification" "1" "$(q "SELECT count(*) FROM public.notifications WHERE user_id='$M1'")"

echo "  -- six concurrent awards --"
for i in 1 2 3 4 5 6; do ("$PGBIN/psql" -U postgres -X -q -c "SELECT public.set_andrel_connector('$M2','$AD',true,NULL)" >/dev/null 2>&1 || true) & done; wait
chk "6 concurrent awards -> ONE badge transition" "1" "$(q "SELECT count(*) FROM public.member_recognition_events WHERE member_id='$M2' AND action='awarded'")"
chk "  -> ONE notification" "1" "$(q "SELECT count(*) FROM public.notifications WHERE user_id='$M2'")"

echo "  -- removal --"
chk "removal" "removed" "$(q "SELECT public.set_andrel_connector('$M1','$AD',false,'stepping back')->>'outcome'")"
chk "  creates NO notification" "1" "$(q "SELECT count(*) FROM public.notifications WHERE user_id='$M1'")"
chk "  does NOT delete the prior one" "1" \
  "$(q "SELECT count(*) FROM public.notifications WHERE user_id='$M1' AND type='andrel_connector_awarded'")"
chk "  the audit keeps both events" "2" "$(q "SELECT count(*) FROM public.member_recognition_events WHERE member_id='$M1'")"

echo "  -- genuine re-award notifies again, keyed to the NEW event --"
chk "re-award" "awarded" "$(q "SELECT public.set_andrel_connector('$M1','$AD',true,NULL)->>'outcome'")"
chk "  a SECOND notification exists" "2" "$(q "SELECT count(*) FROM public.notifications WHERE user_id='$M1'")"
chk "  each keyed to a distinct award event" "2" \
  "$(q "SELECT count(DISTINCT data->>'dedupeKey') FROM public.notifications WHERE user_id='$M1'")"
chk "  and both keys are real award events" "2" \
  "$(q "SELECT count(*) FROM public.notifications n JOIN public.member_recognition_events e ON e.id::text = n.data->>'dedupeKey' WHERE n.user_id='$M1' AND e.action='awarded'")"

echo "  -- a failed award notifies nobody --"
M3=$(q "INSERT INTO public.profiles(email) VALUES ('n3@t.io') RETURNING id")
NOTAD=$(q "INSERT INTO public.profiles(email) VALUES ('nope@t.io') RETURNING id")
chk "non-admin refused" "not_an_administrator" "$(q "SELECT public.set_andrel_connector('$M3','$NOTAD',true,NULL)->>'detail'")"
chk "  no badge, no event, no notification" "0|0|0" \
  "$(q "SELECT (SELECT count(*) FROM public.profiles WHERE id='$M3' AND is_andrel_connector)::text||'|'||(SELECT count(*) FROM public.member_recognition_events WHERE member_id='$M3')::text||'|'||(SELECT count(*) FROM public.notifications WHERE user_id='$M3')::text")"
chk "oversized reason refused" "reason_too_long" "$(q "SELECT public.set_andrel_connector('$M3','$AD',true,repeat('x',501))->>'detail'")"
chk "  still nothing written" "0|0|0" \
  "$(q "SELECT (SELECT count(*) FROM public.profiles WHERE id='$M3' AND is_andrel_connector)::text||'|'||(SELECT count(*) FROM public.member_recognition_events WHERE member_id='$M3')::text||'|'||(SELECT count(*) FROM public.notifications WHERE user_id='$M3')::text")"

echo "  -- a ROLLED-BACK award rolls back all three together --"
"${PSQL[@]}" -c "BEGIN; SELECT public.set_andrel_connector('$M3','$AD',true,NULL); ROLLBACK;" >/dev/null
chk "badge rolled back" "0" "$(q "SELECT count(*) FROM public.profiles WHERE id='$M3' AND is_andrel_connector")"
chk "audit event rolled back" "0" "$(q "SELECT count(*) FROM public.member_recognition_events WHERE member_id='$M3'")"
chk "notification rolled back" "0" "$(q "SELECT count(*) FROM public.notifications WHERE user_id='$M3'")"
chk "no notification exists without a completed award" "0" \
  "$(q "SELECT count(*) FROM public.notifications n WHERE n.type='andrel_connector_awarded'
        AND NOT EXISTS (SELECT 1 FROM public.member_recognition_events e
                         WHERE e.id::text = n.data->>'dedupeKey' AND e.member_id = n.user_id AND e.action='awarded')")"

echo "── 5. the browser cannot reach any of it ──"
chk "notifications RLS is on" "t" "$(q "SELECT relrowsecurity FROM pg_class WHERE oid='public.notifications'::regclass")"
chk "a member may SELECT only their own (policy predicate)" "1" \
  "$(q "SELECT count(*) FROM pg_policies WHERE tablename='notifications' AND cmd='SELECT' AND qual LIKE '%auth.uid()%'")"
chk "a member may UPDATE only their own (mark read)" "1" \
  "$(q "SELECT count(*) FROM pg_policies WHERE tablename='notifications' AND cmd='UPDATE' AND qual LIKE '%auth.uid()%'")"
chk "no INSERT policy exists for a browser role" "0" \
  "$(q "SELECT count(*) FROM pg_policies WHERE tablename='notifications' AND cmd='INSERT'")"
chk "authenticated cannot INSERT" "f" "$(q "SELECT has_table_privilege('authenticated','public.notifications','INSERT')")"
chk "anon can no longer SELECT" "f" "$(q "SELECT has_table_privilege('anon','public.notifications','SELECT')")"
# Table-wide UPDATE is now false BY DESIGN — the grant is column-scoped to read_at, which is
# exactly the legitimate member ability and nothing more.
chk "authenticated has NO table-wide UPDATE" "f" "$(q "SELECT has_table_privilege('authenticated','public.notifications','UPDATE')")"
chk "  but CAN still mark read" "t" "$(q "SELECT has_column_privilege('authenticated','public.notifications','read_at','UPDATE')")"
# title, body, link, type and the key are literals in the writer — nothing is a parameter.
chk "title/body/link/type are literals, not parameters" "0" \
  "$(q "SELECT count(*) FROM pg_proc WHERE oid=to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')
        AND prosrc ~ 'p_(title|body|link|type|dedupe)'")"
chk "the dedupe key is the audit event id, not an argument" "1" \
  "$(q "SELECT count(*) FROM pg_proc WHERE oid=to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')
        AND prosrc LIKE '%''dedupeKey'', v_event_id::text%'")"
chk "the link is a literal path" "1" \
  "$(q "SELECT count(*) FROM pg_proc WHERE oid=to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')
        AND prosrc LIKE '%''/dashboard/profile''%'")"

echo "── 6. the audits execute against a real catalog ──"
POST=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/083_postapply.sql 2>&1 || true)
chk "083_postapply runs with no ERROR" "0" "$(printf '%s' "$POST" | grep -cE '(ERROR|FATAL):' || true)"
chk "  verdict" "1" "$(printf '%s' "$POST" | grep -c '"overall_verdict": "PASS"' || true)"
chk "  writer notifies" "1" "$(printf '%s' "$POST" | grep -c '"notifies": true' || true)"
chk "  signature unchanged" "1" "$(printf '%s' "$POST" | grep -c '"signature_unchanged": true' || true)"
chk "  no orphan notification" "1" "$(printf '%s' "$POST" | grep -c '"orphan_notifications_DEFECT": 0' || true)"
chk "  no duplicate notification" "1" "$(printf '%s' "$POST" | grep -c '"duplicate_notifications_DEFECT": 0' || true)"
chk "  no private metadata leaked" "1" "$(printf '%s' "$POST" | grep -c '"notifications_leaking_private_metadata_DEFECT": 0' || true)"
chk "  no INSERT policy for a browser role" "1" "$(printf '%s' "$POST" | grep -c '"insert_policy_count": 0' || true)"
PRE=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/083_preflight.sql 2>&1 || true)
chk "083_preflight runs with no ERROR" "0" "$(printf '%s' "$PRE" | grep -cE '(ERROR|FATAL):' || true)"
chk "  and now correctly BLOCKS (083 applied)" "1" "$(printf '%s' "$PRE" | grep -c '"overall_verdict": "BLOCKER"' || true)"
chk "  reporting already_notifies" "1" "$(printf '%s' "$PRE" | grep -c '"already_notifies": true' || true)"

echo "── 7. the post-083 posture, proved role by role ──"
for v in SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER; do
  chk "anon holds no $v" "f" "$(q "SELECT has_table_privilege('anon','public.notifications','$v')")"
done
chk "PUBLIC holds nothing at all" "0" \
  "$(q "SELECT count(*) FROM pg_class c, unnest(coalesce(c.relacl, ARRAY[]::aclitem[])) a WHERE c.oid='public.notifications'::regclass AND a::text LIKE '=%'")"
chk "authenticated keeps SELECT" "t" "$(q "SELECT has_table_privilege('authenticated','public.notifications','SELECT')")"
for v in INSERT DELETE TRUNCATE REFERENCES TRIGGER; do
  chk "  and holds no $v" "f" "$(q "SELECT has_table_privilege('authenticated','public.notifications','$v')")"
done
chk "authenticated can UPDATE read_at" "t" "$(q "SELECT has_column_privilege('authenticated','public.notifications','read_at','UPDATE')")"
chk "  and NO other column" "0" \
  "$(q "SELECT count(*) FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name='notifications'
        AND c.column_name <> 'read_at' AND has_column_privilege('authenticated','public.notifications', c.column_name,'UPDATE')")"
chk "  and cannot INSERT any column" "0" \
  "$(q "SELECT count(*) FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name='notifications'
        AND has_column_privilege('authenticated','public.notifications', c.column_name,'INSERT')")"
for v in SELECT INSERT UPDATE; do
  chk "service_role keeps $v" "t" "$(q "SELECT has_table_privilege('service_role','public.notifications','$v')")"
done
chk "member SELECT policy intact" "1" "$(q "SELECT count(*) FROM pg_policies WHERE tablename='notifications' AND cmd='SELECT'")"
chk "member UPDATE policy intact" "1" "$(q "SELECT count(*) FROM pg_policies WHERE tablename='notifications' AND cmd='UPDATE'")"
chk "RLS still enabled" "t" "$(q "SELECT relrowsecurity FROM pg_class WHERE oid='public.notifications'::regclass")"

echo "  -- an anonymous session cannot read, even if RLS were later misconfigured --"
"${PSQL[@]}" -c "ALTER TABLE public.notifications DISABLE ROW LEVEL SECURITY" >/dev/null
chk "with RLS OFF, anon STILL cannot read (the grant is gone)" "denied" \
  "$("$PGBIN/psql" -U postgres -X -q -c "SET ROLE anon; SELECT count(*) FROM public.notifications" >/dev/null 2>&1 && echo READ || echo denied)"
"${PSQL[@]}" -c "ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY" >/dev/null

echo "  -- the bell still works --"
chk "authenticated can still run the bell's read query" "ok" \
  "$("$PGBIN/psql" -U postgres -X -q -c "SET ROLE authenticated; SELECT id, type, title, body, link, read_at FROM public.notifications LIMIT 1" >/dev/null 2>&1 && echo ok || echo BLOCKED)"
chk "authenticated can still mark read" "ok" \
  "$("$PGBIN/psql" -U postgres -X -q -c "SET ROLE authenticated; UPDATE public.notifications SET read_at = now()" >/dev/null 2>&1 && echo ok || echo BLOCKED)"
chk "authenticated CANNOT rewrite the title" "denied" \
  "$("$PGBIN/psql" -U postgres -X -q -c "SET ROLE authenticated; UPDATE public.notifications SET title = 'forged'" >/dev/null 2>&1 && echo WROTE || echo denied)"
chk "authenticated CANNOT rewrite the dedupe key" "denied" \
  "$("$PGBIN/psql" -U postgres -X -q -c "SET ROLE authenticated; UPDATE public.notifications SET data = '{}'::jsonb" >/dev/null 2>&1 && echo WROTE || echo denied)"
chk "authenticated CANNOT insert a notification" "denied" \
  "$("$PGBIN/psql" -U postgres -X -q -c "SET ROLE authenticated; INSERT INTO public.notifications(user_id,type,title,body) VALUES (gen_random_uuid(),'new_batch','x','y')" >/dev/null 2>&1 && echo WROTE || echo denied)"
chk "authenticated CANNOT delete one" "denied" \
  "$("$PGBIN/psql" -U postgres -X -q -c "SET ROLE authenticated; DELETE FROM public.notifications" >/dev/null 2>&1 && echo DELETED || echo denied)"
chk "service_role CAN still insert" "ok" \
  "$("$PGBIN/psql" -U postgres -X -q -c "SET ROLE service_role; INSERT INTO public.notifications(user_id,type,title,body) VALUES (gen_random_uuid(),'new_batch','x','y')" >/dev/null 2>&1 && echo ok || echo BLOCKED)"
"${PSQL[@]}" -c "DELETE FROM public.notifications WHERE type='new_batch'" >/dev/null

echo
[ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "FAILURES PRESENT"; exit 1; }
