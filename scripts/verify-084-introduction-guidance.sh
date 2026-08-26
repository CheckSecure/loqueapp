#!/usr/bin/env bash
# Verify migration 084 on a DISPOSABLE PostgreSQL cluster. Touches no production database.
#
# Proves, against a real server:
#   0. the checked-in file contains no INSERT/UPDATE/DELETE — no backfill is even expressible
#   1. it applies to a fixture that already holds profiles, and enrolls NOBODY
#   2. the preflight says READY before and ALREADY_APPLIED after
#   3. the post-apply audit says PASS
#   4. it is idempotent — a second application changes nothing
#   5. it REFUSES an environment where the profiles privacy posture has been lost (both directions)
#   6. it REFUSES if a browser role holds a column grant on the new columns
#   7. a forward-enrolled member is stamped, and every pre-existing member stays NULL
set -uo pipefail

PGBIN=/opt/homebrew/opt/postgresql@17/bin
[ -x "$PGBIN/initdb" ] || { echo "PostgreSQL 17 not found at $PGBIN"; exit 1; }
PORT=55514
DIR="$(mktemp -d)"
PASS=0; FAIL=0
cleanup() { "$PGBIN/pg_ctl" -D "$DIR/pg" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — expected [$3] got [$2]"; fi; }

PSQL="$PGBIN/psql -U postgres -X -q -h localhost -p $PORT -d postgres -v ON_ERROR_STOP=1"
Q()  { "$PGBIN/psql" -U postgres -X -q -A -t -h localhost -p $PORT -d postgres -c "$1" 2>&1; }
RUN(){ "$PGBIN/psql" -U postgres -X -q -h localhost -p $PORT -d postgres -v ON_ERROR_STOP=1 -f "$1" 2>&1; }

echo "── 0. the checked-in migration cannot backfill ──"
MIG=supabase/migrations/084_introduction_guidance_enrollment.sql
DML=$(grep -cEi '^[[:space:]]*(INSERT|UPDATE|DELETE)[[:space:]]' "$MIG" || true)
check "no INSERT/UPDATE/DELETE statement in the migration" "$DML" "0"
DEF=$(grep -cEi 'ADD COLUMN.*DEFAULT' "$MIG" || true)
check "no column DEFAULT (a default is a backfill by another name)" "$DEF" "0"

echo "── cluster ──"
"$PGBIN/initdb" -D "$DIR/pg" -U postgres --auth=trust --no-sync >/dev/null 2>&1 || { echo "initdb failed"; exit 1; }
"$PGBIN/pg_ctl" -D "$DIR/pg" -o "-p $PORT -c listen_addresses=localhost -c fsync=off" -l "$DIR/log" -w start >/dev/null 2>&1 \
  || { echo "pg_ctl start failed"; cat "$DIR/log"; exit 1; }
echo "  PostgreSQL $(Q 'SHOW server_version;') on port $PORT"

fixture() {
  $PSQL >/dev/null 2>&1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  email text,
  full_name text,
  account_status text DEFAULT 'active',
  profile_complete boolean DEFAULT false,
  onboarding_step integer DEFAULT 0,
  is_test_account boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
-- THE OBSERVED PRODUCTION POSTURE, reproduced exactly:
--   anon / authenticated : SELECT f, INSERT f, UPDATE f, DELETE f, TRUNCATE t, REFERENCES t, TRIGGER t
--   service_role         : all true
-- Supabase's default GRANT ALL left TRUNCATE/REFERENCES/TRIGGER behind; 055 and 058 revoked only
-- the value-bearing privileges. 084 is what removes the remainder.
GRANT ALL ON public.profiles TO anon, authenticated, service_role;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.profiles FROM PUBLIC, anon, authenticated;
-- five historical members, exactly the population that must never be enrolled
INSERT INTO public.profiles (id, email, full_name, profile_complete, onboarding_step) VALUES
  ('11111111-1111-1111-1111-111111111111','a@x.test','A', true,  2),
  ('22222222-2222-2222-2222-222222222222','b@x.test','B', true,  2),
  ('33333333-3333-3333-3333-333333333333','c@x.test','C', false, 1),
  ('44444444-4444-4444-4444-444444444444','d@x.test','D', true,  2),
  ('55555555-5555-5555-5555-555555555555','e@x.test','E', false, 0);
SQL
}

echo "── 1. preflight on a clean fixture ──"
fixture
PRE=$(RUN supabase/audits/084_preflight.sql)
echo "$PRE" | grep -q '"overall_verdict": "READY"' && ok "preflight says READY" || bad "preflight did not say READY: $(echo "$PRE" | tail -3)"

echo "── 2. apply ──"
OUT=$(RUN "$MIG")
if echo "$OUT" | grep -q '084 OK'; then ok "applied: $(echo "$OUT" | grep -o '084 OK.*')"; else bad "apply failed: $OUT"; fi

echo "── 3. nobody was enrolled ──"
check "profiles present"            "$(Q 'SELECT count(*) FROM public.profiles;')" "5"
check "members enrolled"            "$(Q 'SELECT count(*) FROM public.profiles WHERE intro_guidance_enrolled_at IS NOT NULL;')" "0"
check "members dismissed"           "$(Q 'SELECT count(*) FROM public.profiles WHERE intro_first_batch_explainer_dismissed_at IS NOT NULL;')" "0"
check "complete members enrolled"   "$(Q 'SELECT count(*) FROM public.profiles WHERE profile_complete AND intro_guidance_enrolled_at IS NOT NULL;')" "0"
check "enrolled column is nullable" "$(Q "SELECT attnotnull::text FROM pg_attribute WHERE attrelid='public.profiles'::regclass AND attname='intro_guidance_enrolled_at';")" "false"
check "enrolled column has no default" "$(Q "SELECT atthasdef::text FROM pg_attribute WHERE attrelid='public.profiles'::regclass AND attname='intro_guidance_enrolled_at';")" "false"
check "dismissed column has no default" "$(Q "SELECT atthasdef::text FROM pg_attribute WHERE attrelid='public.profiles'::regclass AND attname='intro_first_batch_explainer_dismissed_at';")" "false"
check "both columns are timestamptz" "$(Q "SELECT count(*) FROM pg_attribute WHERE attrelid='public.profiles'::regclass AND attname IN ('intro_guidance_enrolled_at','intro_first_batch_explainer_dismissed_at') AND format_type(atttypid,atttypmod)='timestamp with time zone';")" "2"

echo "── 4. post-apply audit ──"
POST=$(RUN supabase/audits/084_postapply.sql)
echo "$POST" | grep -q '"overall_verdict": "PASS"' && ok "post-apply says PASS" || bad "post-apply not PASS: $(echo "$POST" | tail -5)"
echo "$POST" | grep -q '"members_enrolled": 0' && ok "post-apply reports 0 enrolled" || bad "post-apply enrolled != 0"

echo "── 5. preflight now reports ALREADY_APPLIED ──"
PRE2=$(RUN supabase/audits/084_preflight.sql)
echo "$PRE2" | grep -q '"overall_verdict": "ALREADY_APPLIED"' && ok "preflight says ALREADY_APPLIED" || bad "preflight after apply: $(echo "$PRE2" | tail -3)"

echo "── 6. idempotent ──"
OUT2=$(RUN "$MIG")
if echo "$OUT2" | grep -q '084 OK'; then ok "second application succeeds"; else bad "not idempotent: $OUT2"; fi
check "still nobody enrolled after re-apply" "$(Q 'SELECT count(*) FROM public.profiles WHERE intro_guidance_enrolled_at IS NOT NULL;')" "0"
check "columns still 2 (no duplicates)" "$(Q "SELECT count(*) FROM pg_attribute WHERE attrelid='public.profiles'::regclass AND attname LIKE 'intro_%' AND NOT attisdropped;")" "2"

echo "── 7. ATOMIC ENROLLMENT — the trigger is the only authority ──"
check "trigger attached to public.profiles" "$(Q "SELECT count(*) FROM pg_trigger WHERE tgrelid='public.profiles'::regclass AND tgname='stamp_intro_guidance_enrollment' AND NOT tgisinternal;")" "1"
check "exactly ONE enrollment authority"    "$(Q "SELECT count(*) FROM pg_trigger WHERE tgrelid='public.profiles'::regclass AND NOT tgisinternal AND pg_get_triggerdef(oid) ILIKE '%intro_guidance_enroll%';")" "1"
# PostgreSQL stores SET search_path = '' as search_path="" — assert the POSTURE, not an encoding
check "trigger fn has an empty search_path" "$(Q "SELECT (array_to_string(proconfig,',') IN ('search_path=\"\"','search_path='))::text FROM pg_proc WHERE oid='public.tg_stamp_intro_guidance_enrollment()'::regprocedure;")" "true"
check "trigger fn is SECURITY INVOKER"      "$(Q "SELECT prosecdef::text FROM pg_proc WHERE oid='public.tg_stamp_intro_guidance_enrollment()'::regprocedure;")" "false"
check "anon cannot EXECUTE the trigger fn"  "$(Q "SELECT has_function_privilege('anon','public.tg_stamp_intro_guidance_enrollment()','EXECUTE')::text;")" "false"
check "authenticated cannot EXECUTE it"     "$(Q "SELECT has_function_privilege('authenticated','public.tg_stamp_intro_guidance_enrollment()','EXECUTE')::text;")" "false"

# (a) TRANSITION not-complete -> complete: enrolled, with NO application call anywhere
Q "UPDATE public.profiles SET profile_complete=true WHERE id='33333333-3333-3333-3333-333333333333';" >/dev/null
check "(a) transition to complete enrols"   "$(Q "SELECT (intro_guidance_enrolled_at IS NOT NULL)::text FROM public.profiles WHERE id='33333333-3333-3333-3333-333333333333';")" "true"

# (b) an ALREADY-complete historical profile, written again: never enrolled
Q "UPDATE public.profiles SET profile_complete=true, full_name='A2' WHERE id='11111111-1111-1111-1111-111111111111';" >/dev/null
check "(b) already-complete member NOT enrolled" "$(Q "SELECT (intro_guidance_enrolled_at IS NULL)::text FROM public.profiles WHERE id='11111111-1111-1111-1111-111111111111';")" "true"

# (c) an unrelated edit to an already-complete profile: still never enrolled
Q "UPDATE public.profiles SET full_name='A3' WHERE id='22222222-2222-2222-2222-222222222222';" >/dev/null
check "(c) unrelated edit does not enrol"   "$(Q "SELECT (intro_guidance_enrolled_at IS NULL)::text FROM public.profiles WHERE id='22222222-2222-2222-2222-222222222222';")" "true"

# (d) INSERT already-complete: enrolled in the same statement
Q "INSERT INTO public.profiles (id,email,full_name,profile_complete,onboarding_step) VALUES ('77777777-7777-7777-7777-777777777777','n@x.test','N',true,2);" >/dev/null
check "(d) INSERT complete enrols atomically" "$(Q "SELECT (intro_guidance_enrolled_at IS NOT NULL)::text FROM public.profiles WHERE id='77777777-7777-7777-7777-777777777777';")" "true"

# (e) INSERT incomplete then complete later: enrolled at the TRANSITION, not at insert
Q "INSERT INTO public.profiles (id,email,full_name,profile_complete) VALUES ('88888888-8888-8888-8888-888888888888','o@x.test','O',false);" >/dev/null
check "(e) INSERT incomplete does not enrol" "$(Q "SELECT (intro_guidance_enrolled_at IS NULL)::text FROM public.profiles WHERE id='88888888-8888-8888-8888-888888888888';")" "true"
Q "UPDATE public.profiles SET profile_complete=true WHERE id='88888888-8888-8888-8888-888888888888';" >/dev/null
check "(e) later transition enrols"          "$(Q "SELECT (intro_guidance_enrolled_at IS NOT NULL)::text FROM public.profiles WHERE id='88888888-8888-8888-8888-888888888888';")" "true"

# (f) REPEATING onboarding never resets the stamp or the dismissal
STAMP=$(Q "SELECT intro_guidance_enrolled_at FROM public.profiles WHERE id='88888888-8888-8888-8888-888888888888';")
Q "UPDATE public.profiles SET intro_first_batch_explainer_dismissed_at=now() WHERE id='88888888-8888-8888-8888-888888888888';" >/dev/null
Q "UPDATE public.profiles SET profile_complete=true, full_name='O2' WHERE id='88888888-8888-8888-8888-888888888888';" >/dev/null
check "(f) re-completing does not move the stamp" "$(Q "SELECT intro_guidance_enrolled_at FROM public.profiles WHERE id='88888888-8888-8888-8888-888888888888';")" "$STAMP"
check "(f) re-completing does not clear dismissal" "$(Q "SELECT (intro_first_batch_explainer_dismissed_at IS NOT NULL)::text FROM public.profiles WHERE id='88888888-8888-8888-8888-888888888888';")" "true"

# (g) an UPSERT (INSERT .. ON CONFLICT DO UPDATE) — the shape completeOnboarding uses
Q "ALTER TABLE public.profiles ADD CONSTRAINT profiles_email_key UNIQUE (email);" >/dev/null
Q "INSERT INTO public.profiles (id,email,full_name,profile_complete) VALUES ('99999999-9999-9999-9999-999999999999','c@x.test','C-up',true) ON CONFLICT (email) DO UPDATE SET profile_complete=EXCLUDED.profile_complete, full_name=EXCLUDED.full_name;" >/dev/null
check "(g) upsert onto member C (was incomplete) enrols" "$(Q "SELECT (intro_guidance_enrolled_at IS NOT NULL)::text FROM public.profiles WHERE email='c@x.test';")" "true"

check "historical members A/B/D/E still unenrolled" "$(Q "SELECT count(*) FROM public.profiles WHERE email IN ('a@x.test','b@x.test','d@x.test','e@x.test') AND intro_guidance_enrolled_at IS NULL;")" "4"
POST2=$(RUN supabase/audits/084_postapply.sql)
echo "$POST2" | grep -q '"members_enrolled": 0' && bad "post-apply still reports 0 enrolled after real enrollments" || ok "post-apply reflects real enrollments only"

echo "── 8. NEGATIVE: refuses a lost SELECT posture ──"
fixture
Q "GRANT SELECT ON public.profiles TO authenticated;" >/dev/null
OUT=$(RUN "$MIG" || true)
echo "$OUT" | grep -q 'DRIFT GUARD 084' && ok "refused: authenticated can SELECT profiles" || bad "did NOT refuse a lost 058 posture"
check "no column created by the refused run" "$(Q "SELECT count(*) FROM pg_attribute WHERE attrelid='public.profiles'::regclass AND attname='intro_guidance_enrolled_at' AND NOT attisdropped;")" "0"
PRE3=$(RUN supabase/audits/084_preflight.sql)
echo "$PRE3" | grep -q 'BLOCKER' && ok "preflight independently reports BLOCKER" || bad "preflight missed the lost posture"

echo "── 9. NEGATIVE: refuses a lost UPDATE posture ──"
fixture
Q "GRANT UPDATE ON public.profiles TO authenticated;" >/dev/null
OUT=$(RUN "$MIG" || true)
echo "$OUT" | grep -q 'DRIFT GUARD 084' && ok "refused: authenticated can UPDATE profiles" || bad "did NOT refuse a lost 055 posture"

echo "── 10. NEGATIVE: refuses a browser column grant ──"
fixture
Q "ALTER TABLE public.profiles ADD COLUMN intro_guidance_enrolled_at timestamptz NULL;" >/dev/null
Q "GRANT SELECT (intro_guidance_enrolled_at) ON public.profiles TO anon;" >/dev/null
OUT=$(RUN "$MIG" || true)
echo "$OUT" | grep -q 'MIGRATION 084' && ok "refused: anon holds a column grant" || bad "did NOT refuse a browser column grant: $(echo "$OUT" | tail -2)"

echo "── 11. NEGATIVE: refuses a missing role ──"
fixture
Q "DROP OWNED BY anon; DROP ROLE anon;" >/dev/null
OUT=$(RUN "$MIG" || true)
echo "$OUT" | grep -q 'DRIFT GUARD 084' && ok "refused: role anon absent" || bad "did NOT refuse a missing role"

echo "── 12. THE OBSERVED PRODUCTION ACL POSTURE ──"
fixture
PRIV(){ Q "SELECT has_table_privilege('$1','public.profiles','$2')::text;"; }
check "anon SELECT is false (055/058)"        "$(PRIV anon SELECT)"        "false"
check "anon INSERT is false"                  "$(PRIV anon INSERT)"        "false"
check "anon UPDATE is false"                  "$(PRIV anon UPDATE)"        "false"
check "anon DELETE is false"                  "$(PRIV anon DELETE)"        "false"
check "anon TRUNCATE is TRUE (inherited)"     "$(PRIV anon TRUNCATE)"      "true"
check "anon REFERENCES is TRUE (inherited)"   "$(PRIV anon REFERENCES)"    "true"
check "anon TRIGGER is TRUE (inherited)"      "$(PRIV anon TRIGGER)"       "true"
check "authenticated TRUNCATE is TRUE"        "$(PRIV authenticated TRUNCATE)" "true"
check "authenticated REFERENCES is TRUE"      "$(PRIV authenticated REFERENCES)" "true"
check "authenticated TRIGGER is TRUE"         "$(PRIV authenticated TRIGGER)"  "true"
check "service_role SELECT is true"           "$(PRIV service_role SELECT)" "true"
check "service_role DELETE is true"           "$(PRIV service_role DELETE)" "true"

echo "── 13. the OLD guard falsely rejected this exact posture ──"
# Reconstruct the previous guard verbatim and run it against the observed production grants. It
# refuses — which is the defect this correction fixes. Nothing is written either way.
cat > "$DIR/oldguard.sql" <<'OLD'
DO $g$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges g
     WHERE g.table_schema='public' AND g.table_name='profiles'
       AND g.grantee IN ('anon','authenticated','PUBLIC')
  ) THEN
    RAISE EXCEPTION 'OLD GUARD 084: column-level privilege granted to a browser role; refusing.';
  END IF;
END
$g$;
OLD
OUT=$(RUN "$DIR/oldguard.sql" 2>&1 || true)
echo "$OUT" | grep -q 'OLD GUARD 084' && ok "the OLD guard refuses the real production posture (the defect)" || bad "old guard did not refuse: $OUT"
OLDREF=$(Q "SELECT count(*) FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='profiles' AND grantee IN ('anon','authenticated') AND privilege_type='REFERENCES';")
[ "$OLDREF" -gt 0 ] && ok "  and what it tripped on was REFERENCES ($OLDREF column rows), which exposes nothing" || bad "expected REFERENCES column rows"
NEWVAL=$(Q "SELECT count(*) FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='profiles' AND grantee IN ('anon','authenticated','PUBLIC') AND privilege_type IN ('SELECT','INSERT','UPDATE');")
check "  the CORRECTED guard sees zero value-bearing column grants" "$NEWVAL" "0"

echo "── 14. corrected 084 applies to that posture ──"
OUT=$(RUN "$MIG")
echo "$OUT" | grep -q '084 OK' && ok "applied: $(echo "$OUT" | grep -o '084 OK.*' | head -c 90)…" || bad "apply failed: $OUT"

echo "── 15. browser roles lose TRUNCATE / REFERENCES / TRIGGER ──"
for r in anon authenticated; do
  for p in TRUNCATE REFERENCES TRIGGER; do
    check "  $r $p revoked" "$(PRIV $r $p)" "false"
  done
done
check "PUBLIC holds no privilege at all" "$(Q "SELECT count(*) FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a WHERE c.oid='public.profiles'::regclass AND a.grantee=0;")" "0"

echo "── 16. and gain NO read/write access ──"
for r in anon authenticated; do
  for p in SELECT INSERT UPDATE DELETE; do
    check "  $r $p still false" "$(PRIV $r $p)" "false"
  done
done
check "no value-bearing column grant on the new columns" "$(Q "SELECT count(*) FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='profiles' AND column_name IN ('intro_guidance_enrolled_at','intro_first_batch_explainer_dismissed_at') AND grantee IN ('anon','authenticated','PUBLIC') AND privilege_type IN ('SELECT','INSERT','UPDATE');")" "0"

echo "── 17. service_role continues working ──"
for p in SELECT INSERT UPDATE DELETE; do check "  service_role $p retained" "$(PRIV service_role $p)" "true"; done
check "service_role can read the new columns"  "$(Q "SELECT has_column_privilege('service_role','public.profiles','intro_guidance_enrolled_at','SELECT')::text;")" "true"
check "service_role can write the new columns" "$(Q "SELECT has_column_privilege('service_role','public.profiles','intro_first_batch_explainer_dismissed_at','UPDATE')::text;")" "true"
# a real write, as the application would do it
Q "INSERT INTO public.profiles (id,email,full_name,profile_complete) VALUES ('aaaa0000-0000-0000-0000-00000000aaaa','svc@x.test','Svc',true);" >/dev/null
check "service_role INSERT actually works"  "$(Q "SELECT count(*) FROM public.profiles WHERE id='aaaa0000-0000-0000-0000-00000000aaaa';")" "1"
Q "UPDATE public.profiles SET intro_first_batch_explainer_dismissed_at=now() WHERE id='aaaa0000-0000-0000-0000-00000000aaaa';" >/dev/null
check "service_role UPDATE of a new column works" "$(Q "SELECT (intro_first_batch_explainer_dismissed_at IS NOT NULL)::text FROM public.profiles WHERE id='aaaa0000-0000-0000-0000-00000000aaaa';")" "true"
Q "DELETE FROM public.profiles WHERE id='aaaa0000-0000-0000-0000-00000000aaaa';" >/dev/null
check "service_role DELETE works" "$(Q "SELECT count(*) FROM public.profiles WHERE id='aaaa0000-0000-0000-0000-00000000aaaa';")" "0"

echo "── 18. zero historical profiles enrolled, and repeat application is safe ──"
check "profiles present" "$(Q 'SELECT count(*) FROM public.profiles;')" "5"
check "members enrolled" "$(Q 'SELECT count(*) FROM public.profiles WHERE intro_guidance_enrolled_at IS NOT NULL;')" "0"
OUT2=$(RUN "$MIG")
echo "$OUT2" | grep -q '084 OK' && ok "second application succeeds (idempotent revoke)" || bad "not idempotent: $OUT2"
check "still zero enrolled after re-apply" "$(Q 'SELECT count(*) FROM public.profiles WHERE intro_guidance_enrolled_at IS NOT NULL;')" "0"
check "browser roles still hold nothing" "$(Q "SELECT count(*) FROM (SELECT has_table_privilege(r,'public.profiles',p) AS h FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p) z WHERE h;")" "0"
POST=$(RUN supabase/audits/084_postapply.sql)
echo "$POST" | grep -q '"overall_verdict": "PASS"' && ok "post-apply PASSes on the corrected posture" || bad "post-apply: $(echo "$POST" | grep -A2 overall_verdict)"

echo "── 19. preflight reports the inherited posture as expected, not a blocker ──"
fixture
PRE=$(RUN supabase/audits/084_preflight.sql)
echo "$PRE" | grep -q '"overall_verdict": "READY"' && ok "preflight says READY despite TRUNCATE/REFERENCES/TRIGGER" || bad "preflight: $(echo "$PRE" | grep overall_verdict)"
echo "$PRE" | grep -q '"will_be_revoked_by_084": true' && ok "  and reports them as what 084 corrects" || bad "missing the correction note"
echo "$PRE" | grep -q '"TRUNCATE": true' && ok "  the inherited TRUNCATE is visible in the report" || bad "TRUNCATE not reported"

echo
printf '══ %d passed, %d failed ══\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
