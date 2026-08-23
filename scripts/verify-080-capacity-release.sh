#!/usr/bin/env bash
# Executes the REAL migration 080 against a PostgreSQL cluster reproducing Supabase's inherited
# default privileges. Cluster destroyed on exit. Nothing here touches production.
set -euo pipefail
PGBIN=/opt/homebrew/opt/postgresql@17/bin
DATA=$(mktemp -d)/pg80; PORT=55484
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
CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_status text DEFAULT 'active',
  profile_complete boolean DEFAULT true, is_test_account boolean DEFAULT false, matching_paused boolean DEFAULT false,
  is_admin boolean DEFAULT false, email text DEFAULT 'm@example.com', full_name text DEFAULT 'A Member');
CREATE TABLE public.blocked_users (user_id uuid, blocked_user_id uuid);
CREATE TABLE public.member_pairs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_b_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'reciprocal', status text NOT NULL DEFAULT 'active',
  recommend_count integer NOT NULL DEFAULT 0, first_recommended_at timestamptz,
  last_recommended_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_pairs_canonical_ck CHECK (user_a_id < user_b_id),
  CONSTRAINT member_pairs_unique UNIQUE (user_a_id, user_b_id));
CREATE TABLE public.recommendation_batches (batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL, batch_source text, state text NOT NULL,
  created_at timestamptz DEFAULT now(), generated_at timestamptz, displayed_at timestamptz,
  completed_at timestamptz);
CREATE TABLE public.intro_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL, target_user_id uuid NOT NULL, status text NOT NULL,
  pair_id uuid REFERENCES public.member_pairs(id) ON DELETE SET NULL,
  batch_id uuid, note text, match_reason text, expired_at timestamptz, is_admin_initiated boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_a_id uuid, user_b_id uuid,
  admin_facilitated boolean DEFAULT false, CONSTRAINT matches_pair_uniq UNIQUE (user_a_id, user_b_id));
CREATE TABLE public.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), match_id uuid UNIQUE);
CREATE TABLE public.meeting_credits (user_id uuid PRIMARY KEY, balance integer DEFAULT 0,
  free_credits integer DEFAULT 0, premium_credits integer DEFAULT 0);
CREATE TABLE public.introduction_email_outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intro_request_id uuid UNIQUE, member_id uuid, created_at timestamptz DEFAULT now());

-- batch_suggestions exists only so the real materialize_admin_pair body has a table to name.
CREATE TABLE public.batch_suggestions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid, member_id uuid, candidate_id uuid, rank integer, state text);

-- The 070 outbox trigger, verbatim in shape: AFTER INSERT OR UPDATE **OF status**.
CREATE FUNCTION public.tg_intro_request_visible_outbox() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $tg$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'suggested' THEN
      INSERT INTO public.introduction_email_outbox (intro_request_id, member_id)
      VALUES (NEW.id, NEW.requester_id) ON CONFLICT (intro_request_id) DO NOTHING;
    END IF; RETURN NULL;
  END IF;
  IF NEW.status = 'suggested' AND OLD.status IS DISTINCT FROM 'suggested' THEN
    INSERT INTO public.introduction_email_outbox (intro_request_id, member_id)
    VALUES (NEW.id, NEW.requester_id) ON CONFLICT (intro_request_id) DO NOTHING;
  END IF; RETURN NULL;
END; $tg$;
CREATE TRIGGER intro_requests_visible_outbox_aiu
  AFTER INSERT OR UPDATE OF status ON public.intro_requests
  FOR EACH ROW EXECUTE FUNCTION public.tg_intro_request_visible_outbox();
SQL

# The REAL neighbouring lifecycle functions, extracted verbatim from their own migrations. These
# are what make sections 12-14 an end-to-end proof rather than a re-implementation: expiry, pass and
# mutual finalization are the deployed bodies, not stand-ins.
extract(){ awk -v fn="$2" '
    $0 ~ "^CREATE OR REPLACE FUNCTION public\\." fn "\\(" {p=1}
    p {print}
    p && /^\$[A-Za-z_]*\$;[[:space:]]*$/ {exit}' "$1"; }
{ extract supabase/migrations/063_unified_introduction_capacity.sql create_reciprocal_suggestion
  extract supabase/migrations/063_unified_introduction_capacity.sql place_batch_rows
  extract supabase/migrations/063_unified_introduction_capacity.sql promote_queued_rows
  extract supabase/migrations/064_materialize_admin_pair.sql       materialize_admin_pair
  extract supabase/migrations/066_expire_intro_pair.sql            expire_intro_pair
  extract supabase/migrations/050_member_pairs.sql                 pass_reciprocal_pair
  extract supabase/migrations/067_finalize_mutual_match_atomic.sql consume_credits_and_create_match
  extract supabase/migrations/067_finalize_mutual_match_atomic.sql finalize_mutual_match_atomic
} > "$DATA/neighbours.sql"

# The deployed ACL posture the guard asserts. Supabase's ALTER DEFAULT PRIVILEGES (reproduced above)
# grants EXECUTE to anon/authenticated at CREATE time, so these REVOKEs are what production actually
# has — restating them here is the fixture matching reality, not the fixture being lenient.
cat > "$DATA/acl.sql" <<'ACL'
REVOKE ALL ON FUNCTION public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.place_batch_rows(uuid, text, jsonb, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_batch_rows(uuid, text, jsonb, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.promote_queued_rows(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_queued_rows(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.expire_intro_pair(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_intro_pair(uuid, integer) TO service_role;
ACL

restore_pristine(){
  "${PSQL[@]}" -c "DROP FUNCTION IF EXISTS public.promote_queued_rows(uuid, integer);
                   DROP FUNCTION IF EXISTS public.place_batch_rows(uuid, jsonb, text, uuid, integer);
                   DROP FUNCTION IF EXISTS public.place_batch_rows(uuid, text, jsonb, uuid, numeric);
                   DROP FUNCTION IF EXISTS public.place_batch_rows(uuid, text, jsonb, uuid, integer);
                   DROP FUNCTION IF EXISTS public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer);" >/dev/null 2>&1 || true
  "${PSQL[@]}" -f "$DATA/neighbours.sql" >/dev/null
  "${PSQL[@]}" -f "$DATA/acl.sql" >/dev/null
}
restore_pristine
for fn in create_reciprocal_suggestion place_batch_rows promote_queued_rows materialize_admin_pair \
          expire_intro_pair pass_reciprocal_pair finalize_mutual_match_atomic; do
  [ "$(q "SELECT count(*) FROM pg_proc WHERE proname='$fn'")" = "1" ] || { echo "FIXTURE: $fn missing"; exit 1; }
done

# The fixture must carry the AUDITED PRODUCTION BODIES, or every negative control below is vacuous.
echo "── FIXTURE: bodies match the audited production identities ──"
while IFS='|' read -r fn md5 len; do
  chk "fixture $fn md5"    "$md5" "$(q "SELECT md5(prosrc) FROM pg_proc WHERE proname='$fn'")"
  chk "fixture $fn length" "$len" "$(q "SELECT length(prosrc) FROM pg_proc WHERE proname='$fn'")"
done <<'IDS'
create_reciprocal_suggestion|8d62f30d84f079c1dcc4aa22848dba9d|6103
place_batch_rows|2eca64f2e35735feb6ca45212488885d|11413
promote_queued_rows|690f0f6aead9a4831073e32af8d53e1f|6090
materialize_admin_pair|d64aa2aa8627089cd82cbcbc586ddca1|22015
expire_intro_pair|c786da9312cf962eb06ec6463ceecfd8|5146
IDS

# delete_user_account's intro_requests statement, transcribed from migration 075 line-for-line. It
# is the exact shape section 14 must survive: EVERY row for a member removed in ONE statement.
"${PSQL[@]}" -c "CREATE FUNCTION public.delete_member_intro_rows(v_uid uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS \$\$ BEGIN
  DELETE FROM public.intro_requests WHERE requester_id = v_uid OR target_user_id = v_uid;
  END \$\$;" >/dev/null

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# 0. NEGATIVE CONTROLS — every one of these MUST be refused, and must leave nothing behind.
#    The fixture now carries the audited production bodies verbatim, so each control perturbs
#    exactly ONE property and nothing else. A control that passes here would mean the guard is
#    decorative.
# ═══════════════════════════════════════════════════════════════════════════════════════════════
echo "── 0. NEGATIVE CONTROLS: 080 must refuse and roll back completely ──"
# A control deliberately breaks the fixture, so psql WILL error here. set -e would kill the
# harness at exactly the moment the assertion mattered — the lesson from the last harness.
set +e

# Objects 080 creates. After a refusal NONE of them may exist — the migration is one transaction.
assert_nothing_left(){
  local label="$1"
  local n
  n=$(q "SELECT
      (SELECT count(*) FROM information_schema.columns WHERE table_name='intro_requests' AND column_name IN ('responds_to_id','capacity_released_at'))
    + (SELECT count(*) FROM pg_proc WHERE proname IN ('express_intro_interest','release_intro_capacity'))
    + (SELECT count(*) FROM pg_class WHERE relname='introduction_capacity_review')
    + (SELECT count(*) FROM pg_indexes WHERE indexname IN ('intro_requests_capacity_live_idx','intro_requests_responds_to_idx','intro_requests_one_expression_per_card_uniq'))
    + (SELECT count(*) FROM pg_constraint WHERE conname='intro_requests_released_requires_pair_chk')")
  chk "  $label -> nothing left behind" "0" "$n"
}
try_080(){ "${PSQL[@]}" -f supabase/migrations/080_introduction_capacity_release.sql >/dev/null 2>&1 && echo APPLIED || echo blocked; }

# (a) correct name, all broad markers intact, ONE meaningful statement changed.
sed -e "s/RETURN 'capacity';/RETURN 'capacity'; -- drifted out of band/" "$DATA/neighbours.sql" > "$DATA/drift_a.sql"
"${PSQL[@]}" -f "$DATA/drift_a.sql" >/dev/null; "${PSQL[@]}" -f "$DATA/acl.sql" >/dev/null
chk "(a) body edited, markers intact  -> REFUSED" "blocked" "$(try_080)"
chk "  (a) markers alone would NOT have caught it" "1" \
  "$(q "SELECT (strpos(prosrc,'c_max_visible')>0 AND strpos(prosrc,'capacity')>0 AND strpos(prosrc,'pg_advisory_xact_lock')>0)::int FROM pg_proc WHERE proname='create_reciprocal_suggestion'")"
assert_nothing_left "(a)"; restore_pristine

# (b) an unexpected overload of a writer name.
"${PSQL[@]}" -c "CREATE FUNCTION public.promote_queued_rows(p_member_id uuid, p_extra integer) RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = '' AS \$\$ SELECT '{}'::jsonb \$\$;" >/dev/null
chk "(b) unexpected overload          -> REFUSED" "blocked" "$(try_080)"
assert_nothing_left "(b)"; restore_pristine

# (c) a parameter NAME differs (types and order identical, so the signature still resolves).
"${PSQL[@]}" -c "DROP FUNCTION public.place_batch_rows(uuid, text, jsonb, uuid, integer)" >/dev/null
sed -e "s/^  p_member_id uuid,/  p_member uuid,/" "$DATA/neighbours.sql" > "$DATA/drift_c.sql"
"${PSQL[@]}" -f "$DATA/drift_c.sql" >/dev/null 2>&1; "${PSQL[@]}" -f "$DATA/acl.sql" >/dev/null 2>&1
chk "(c) parameter NAME differs       -> REFUSED" "blocked" "$(try_080)"
assert_nothing_left "(c)"; restore_pristine

# (d) a parameter TYPE differs.
"${PSQL[@]}" -c "DROP FUNCTION public.place_batch_rows(uuid, text, jsonb, uuid, integer)" >/dev/null
sed -e "s/^  p_cooldown_days integer DEFAULT 30$/  p_cooldown_days numeric DEFAULT 30/" "$DATA/neighbours.sql" > "$DATA/drift_d.sql"
"${PSQL[@]}" -f "$DATA/drift_d.sql" >/dev/null 2>&1; "${PSQL[@]}" -f "$DATA/acl.sql" >/dev/null 2>&1
chk "(d) parameter TYPE differs       -> REFUSED" "blocked" "$(try_080)"
assert_nothing_left "(d)"; restore_pristine

# (e) parameter ORDER differs.
"${PSQL[@]}" -c "DROP FUNCTION public.place_batch_rows(uuid, text, jsonb, uuid, integer)" >/dev/null
"${PSQL[@]}" -c "CREATE FUNCTION public.place_batch_rows(p_member_id uuid, p_rows jsonb, p_source text,
  p_reciprocal_batch_id uuid DEFAULT NULL, p_cooldown_days integer DEFAULT 30) RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = '' AS \$\$ SELECT '{}'::jsonb \$\$;" >/dev/null
chk "(e) parameter ORDER differs      -> REFUSED" "blocked" "$(try_080)"
assert_nothing_left "(e)"
"${PSQL[@]}" -c "DROP FUNCTION public.place_batch_rows(uuid, jsonb, text, uuid, integer)" >/dev/null; restore_pristine

# (f) SECURITY DEFINER removed (prosrc untouched, so only the posture check can catch it).
"${PSQL[@]}" -c "ALTER FUNCTION public.promote_queued_rows(uuid) SECURITY INVOKER" >/dev/null
chk "(f) SECURITY DEFINER removed     -> REFUSED" "blocked" "$(try_080)"
assert_nothing_left "(f)"; restore_pristine

# (g) empty search_path removed (prosrc untouched).
"${PSQL[@]}" -c "ALTER FUNCTION public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer) RESET search_path" >/dev/null
chk "(g) empty search_path removed    -> REFUSED" "blocked" "$(try_080)"
assert_nothing_left "(g)"; restore_pristine

# (h) a browser role can execute a writer (the migration-067 defect).
"${PSQL[@]}" -c "GRANT EXECUTE ON FUNCTION public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer) TO authenticated" >/dev/null
chk "(h) authenticated can execute    -> REFUSED" "blocked" "$(try_080)"
assert_nothing_left "(h)"; restore_pristine

# (i) expire_intro_pair differs — 080 does not replace it, but it must refuse to run beside a
#     changed copy, because the 14-day delayed-mutual behaviour is what makes release safe.
sed -e "s/'nothing_open'/'nothing_open_v2'/" "$DATA/neighbours.sql" > "$DATA/drift_i.sql"
"${PSQL[@]}" -f "$DATA/drift_i.sql" >/dev/null; "${PSQL[@]}" -f "$DATA/acl.sql" >/dev/null
chk "(i) expire_intro_pair differs    -> REFUSED" "blocked" "$(try_080)"
assert_nothing_left "(i)"; restore_pristine

# (j) PUBLIC can execute.
"${PSQL[@]}" -c "GRANT EXECUTE ON FUNCTION public.promote_queued_rows(uuid) TO PUBLIC" >/dev/null
chk "(j) PUBLIC can execute           -> REFUSED" "blocked" "$(try_080)"
assert_nothing_left "(j)"; restore_pristine

# (k) a writer is absent entirely.
"${PSQL[@]}" -c "DROP FUNCTION public.promote_queued_rows(uuid)" >/dev/null
chk "(k) writer absent                -> REFUSED" "blocked" "$(try_080)"
assert_nothing_left "(k)"; restore_pristine

set -e
chk "the fixture is pristine again before the real apply" "5" \
  "$(q "SELECT count(*) FROM pg_proc WHERE proname IN ('create_reciprocal_suggestion','place_batch_rows','promote_queued_rows','materialize_admin_pair','expire_intro_pair')")"

echo "── 0b. PREFLIGHT audit on the pristine fixture ──"
PRE=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/080_preflight.sql 2>&1 || true)
chk "preflight runs with no ERROR" "0" "$(printf '%s' "$PRE" | grep -cE '(ERROR|FATAL):' || true)"
chk "preflight overall verdict on the audited fixture" "1" "$(printf '%s' "$PRE" | grep -c '"overall_verdict": "PASS"' || true)"
chk "  and every protected function PASSes" "5" "$(printf '%s' "$PRE" | grep -c '"verdict": "PASS"' || true)"
chk "preflight reports zero blockers" "1" "$(printf '%s' "$PRE" | grep -c '"blocker_count": 0' || true)"
chk "preflight resolves all five protected functions" "5" \
  "$(printf '%s' "$PRE" | grep -c '"signatures_deployed_for_name": 1' || true)"
chk "preflight sees columns NOT yet added" "1" "$(printf '%s' "$PRE" | grep -c '"columns_already_added": false' || true)"
# The distinction that caused the length confusion, now emitted side by side.
chk "preflight emits body_chars AND body_octets" "1" \
  "$(printf '%s' "$PRE" | grep -q '"body_chars_deployed": 22015' && printf '%s' "$PRE" | grep -q '"body_octets_deployed": 22193' && echo 1 || echo 0)"
# And it must BLOCK on a perturbed fixture, or its PASS means nothing.
"${PSQL[@]}" -c "ALTER FUNCTION public.promote_queued_rows(uuid) SECURITY INVOKER" >/dev/null
PRE2=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/080_preflight.sql 2>&1 || true)
chk "preflight BLOCKS a perturbed fixture" "1" "$(printf '%s' "$PRE2" | grep -c '"overall_verdict": "BLOCKER"' || true)"
chk "  and names the exact reason" "1" "$(printf '%s' "$PRE2" | grep -c 'NOT_SECURITY_DEFINER' || true)"
restore_pristine

echo "── 1. APPLY 080 on the PRISTINE fixture (the positive control) ──"
# Without this the eleven refusals above prove nothing: a guard that never admits anything would
# pass every negative control. This is what makes the battery non-vacuous — and it is exactly the
# check that caught a malformed RAISE which had been failing the DO block at COMPILE time, so every
# control was being "refused" for the wrong reason.
chk "audited fixture is ADMITTED (controls are not vacuous)" "APPLIED" "$(try_080)"
POST=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/080_postapply.sql 2>&1 || true)
chk "post-apply overall verdict immediately after apply" "1" "$(printf '%s' "$POST" | grep -c '"overall_verdict": "PASS"' || true)"
for z in rows_with_responds_to_id rows_released expressions_carrying_pair_id_DEFECT orphaned_correlations; do
  chk "  $z is zero on a fresh apply" "1" "$(printf '%s' "$POST" | grep -c "\"$z\": 0" || true)"
done
chk "  expire_intro_pair unchanged by 080" "1" "$(printf '%s' "$POST" | grep -c '"unchanged": true' || true)"
chk "  expire_intro_pair md5 still the audited one" "1" \
  "$(printf '%s' "$POST" | grep -c '"deployed_md5": "c786da9312cf962eb06ec6463ceecfd8"' || true)"
chk "  all seven functions PASS" "7" "$(printf '%s' "$POST" | grep -c '"verdict": "PASS"' || true)"
chk "re-applying is BLOCKED (already released-aware)" "blocked" \
  "$("${PSQL[@]}" -f supabase/migrations/080_introduction_capacity_release.sql >/dev/null 2>&1 && echo APPLIED || echo blocked)"

echo "── 2. schema + ACL ──"
for c in responds_to_id capacity_released_at; do
  chk "column $c exists" "1" "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='intro_requests' AND column_name='$c'")"
done
chk "no FK on responds_to_id" "0" \
  "$(q "SELECT count(*) FROM pg_constraint WHERE conrelid='public.intro_requests'::regclass AND contype='f' AND conname LIKE '%responds%'")"
chk "released rows must be paired (local CHECK)" "rejected" \
  "$("${PSQL[@]}" -c "INSERT INTO public.intro_requests(requester_id,target_user_id,status,capacity_released_at) VALUES (gen_random_uuid(),gen_random_uuid(),'suggested',now())" >/dev/null 2>&1 && echo ACCEPTED || echo rejected)"
chk "CHECK does NOT pin status (later transitions must work)" "0" \
  "$(q "SELECT count(*) FROM pg_constraint WHERE conname='intro_requests_released_requires_pair_chk' AND pg_get_constraintdef(oid) LIKE '%suggested%'")"
for f in release_intro_capacity express_intro_interest; do
  chk "$f: empty search_path" "t" "$(q "SELECT 'search_path=\"\"' = ANY(proconfig) FROM pg_proc WHERE proname='$f'")"
  chk "$f: PUBLIC cannot execute" "0" \
    "$(q "SELECT count(*) FROM pg_proc p, unnest(coalesce(p.proacl,ARRAY[]::aclitem[])) a WHERE p.proname='$f' AND a::text LIKE '=%'")"
  for r in anon authenticated; do
    chk "$f: $r cannot execute" "f" "$(q "SELECT has_function_privilege('$r', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='$f'")"
  done
  chk "$f: service_role CAN execute" "t" "$(q "SELECT has_function_privilege('service_role', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='$f'")"
done
for r in anon authenticated; do
  chk "$r cannot write intro_requests" "f" "$(q "SELECT has_table_privilege('$r','public.intro_requests','UPDATE')")"
done
chk "all four writers now honour capacity_released_at" "4" \
  "$(q "SELECT count(*) FROM pg_proc WHERE proname IN ('create_reciprocal_suggestion','place_batch_rows','promote_queued_rows','materialize_admin_pair') AND prosrc LIKE '%capacity_released_at IS NULL%'")"
# 080's own REVOKE/GRANT statements name each writer by SIGNATURE. If a signature is wrong the
# statement raises 42883 and the migration rolls back — but only if the fixture carries the REAL
# signature. This asserts each named signature resolves to exactly one deployed function, and that
# no accidental overload was created alongside it.
for sig in "public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer)" \
           "public.place_batch_rows(uuid, text, jsonb, uuid, integer)" \
           "public.promote_queued_rows(uuid)" \
           "public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer)"; do
  nm="${sig%%(*}"; nm="${nm#public.}"
  chk "080 grants the REAL $nm signature" "1" "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='$nm'")"
  chk "  and that signature resolves" "t" "$(q "SELECT has_function_privilege('service_role','$sig','EXECUTE')")"
done
chk "expire_intro_pair NOT modified by 080" "0" \
  "$(grep -c 'FUNCTION public.expire_intro_pair' supabase/migrations/080_introduction_capacity_release.sql || true)"

echo "── 3. correlation + idempotency ──"
A=$(q "INSERT INTO public.profiles DEFAULT VALUES RETURNING id")
B=$(q "INSERT INTO public.profiles DEFAULT VALUES RETURNING id")
C_OTHER=$(q "INSERT INTO public.profiles DEFAULT VALUES RETURNING id")
LO=$(q "SELECT least('$A'::uuid,'$B'::uuid)"); HI=$(q "SELECT greatest('$A'::uuid,'$B'::uuid)")
P=$(q "INSERT INTO public.member_pairs(user_a_id,user_b_id) VALUES ('$LO','$HI') RETURNING id")
CA=$(q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id,created_at) VALUES ('$A','$B','suggested','$P', now()-interval '10 days') RETURNING id")
CB=$(q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id,created_at) VALUES ('$B','$A','suggested','$P', now()-interval '10 days') RETURNING id")
chk "express: created" "created" "$(q "SELECT out_state FROM public.express_intro_interest('$CA','$A','$B',NULL)")"
chk "express: idempotent on the SAME card" "already_expressed" "$(q "SELECT out_state FROM public.express_intro_interest('$CA','$A','$B',NULL)")"
chk "repeated clicks return the SAME row id" "1" \
  "$(q "SELECT count(DISTINCT out_intro_request_id) FROM public.express_intro_interest('$CA','$A','$B',NULL)")"
chk "exactly one expression exists" "1" "$(q "SELECT count(*) FROM public.intro_requests WHERE responds_to_id='$CA'")"
# pair_id is deliberately NULL on the expression: 066 classifies a pair from pair_id, and the
# answered card stays 'suggested', so stamping it would leave the pair permanently unexpirable.
chk "expression does NOT carry pair_id (066 expiry preserved)" "1" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE responds_to_id='$CA' AND pair_id IS NULL")"
chk "expression is born 'pending'" "pending" "$(q "SELECT status FROM public.intro_requests WHERE responds_to_id='$CA'")"

echo "  -- the hardened gate matrix: every refusal writes NOTHING --"
EXPR_N=$(q "SELECT count(*) FROM public.intro_requests WHERE responds_to_id IS NOT NULL")
FOREIGN=$(q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id) VALUES ('$B','$A','suggested','$P') RETURNING id")
chk "forged card owned by ANOTHER member" "not_owner"  "$(q "SELECT out_detail FROM public.express_intro_interest('$FOREIGN','$A','$B',NULL)")"
chk "card paired with the WRONG target"   "target_mismatch" "$(q "SELECT out_detail FROM public.express_intro_interest('$CA','$A','$C_OTHER',NULL)")"
chk "card id that does not exist"         "card_missing"    "$(q "SELECT out_detail FROM public.express_intro_interest(gen_random_uuid(),'$A','$B',NULL)")"
chk "NULL card id"                        "missing_argument" "$(q "SELECT out_detail FROM public.express_intro_interest(NULL,'$A','$B',NULL)")"
chk "self-pair"                           "self_pair"       "$(q "SELECT out_detail FROM public.express_intro_interest('$CA','$A','$A',NULL)")"
EXPRROW=$(q "SELECT id FROM public.intro_requests WHERE responds_to_id='$CA'")
chk "an EXPRESSION row is not answerable as a card" "card_not_suggested" \
  "$(q "SELECT out_detail FROM public.express_intro_interest('$EXPRROW','$A','$B',NULL)")"
PAIRLESS=$(q "INSERT INTO public.intro_requests(requester_id,target_user_id,status) VALUES ('$A','$C_OTHER','suggested') RETURNING id")
chk "LEGACY pairless card cannot enter the lifecycle" "card_has_no_pair" \
  "$(q "SELECT out_detail FROM public.express_intro_interest('$PAIRLESS','$A','$C_OTHER',NULL)")"
TERMINAL=$(q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id) VALUES ('$A','$B','passed','$P') RETURNING id")
chk "terminal card refused" "card_not_suggested" \
  "$(q "SELECT out_detail FROM public.express_intro_interest('$TERMINAL','$A','$B',NULL)")"
"${PSQL[@]}" -c "UPDATE public.member_pairs SET status='expired' WHERE id='$P'" >/dev/null
chk "card whose PAIR is no longer active refused" "pair_not_active" \
  "$(q "SELECT out_detail FROM public.express_intro_interest('$FOREIGN','$B','$A',NULL)")"
"${PSQL[@]}" -c "UPDATE public.member_pairs SET status='active' WHERE id='$P'" >/dev/null
"${PSQL[@]}" -c "UPDATE public.profiles SET account_status='deactivated' WHERE id='$A'" >/dev/null
chk "INELIGIBLE target refused" "target_ineligible" \
  "$(q "SELECT out_detail FROM public.express_intro_interest('$FOREIGN','$B','$A',NULL)")"
"${PSQL[@]}" -c "UPDATE public.profiles SET account_status='active' WHERE id='$A'" >/dev/null
chk "NO refusal created an expression" "$EXPR_N" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE responds_to_id IS NOT NULL")"
"${PSQL[@]}" -c "DELETE FROM public.intro_requests WHERE id IN ('$TERMINAL','$PAIRLESS')" >/dev/null

echo "  -- reversed direction is a different card and cannot be satisfied by A's expression --"
chk "B's card has no expression answering it" "0" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE responds_to_id='$CB'")"
chk "and B's own expression is a separate row" "created" \
  "$(q "SELECT out_state FROM public.express_intro_interest('$FOREIGN','$B','$A',NULL)")"
chk "two distinct correlated expressions now exist" "2" \
  "$(q "SELECT count(DISTINCT responds_to_id) FROM public.intro_requests WHERE responds_to_id IN ('$CA','$FOREIGN')")"
"${PSQL[@]}" -c "DELETE FROM public.intro_requests WHERE responds_to_id='$FOREIGN'; DELETE FROM public.intro_requests WHERE id='$FOREIGN'" >/dev/null

echo "  -- concurrent expression on one card converges --"
CC=$(q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id) VALUES ('$A','$B','suggested','$P') RETURNING id")
for i in 1 2 3 4 5 6; do ("$PGBIN/psql" -U postgres -X -q -c "SELECT public.express_intro_interest('$CC','$A','$B',NULL)" >/dev/null 2>&1 || true) & done; wait
chk "6 concurrent expressions -> 1 row" "1" "$(q "SELECT count(*) FROM public.intro_requests WHERE responds_to_id='$CC'")"
"${PSQL[@]}" -c "DELETE FROM public.intro_requests WHERE id='$CC' OR responds_to_id='$CC'" >/dev/null

echo "── 4. the 72-hour clock ──"
chk "no release before 72h" "f" "$(q "SELECT public.release_intro_capacity('$CA')")"
"${PSQL[@]}" -c "UPDATE public.intro_requests SET created_at = now() - interval '80 hours' WHERE responds_to_id='$CA'" >/dev/null
chk "release AFTER 72h" "t" "$(q "SELECT public.release_intro_capacity('$CA')")"
chk "idempotent second release" "f" "$(q "SELECT public.release_intro_capacity('$CA')")"
chk "A's row released" "1" "$(q "SELECT count(*) FROM public.intro_requests WHERE id='$CA' AND capacity_released_at IS NOT NULL")"
chk "B's row NOT released" "0" "$(q "SELECT count(*) FROM public.intro_requests WHERE id='$CB' AND capacity_released_at IS NOT NULL")"
chk "B's row cannot be released (B never expressed)" "f" "$(q "SELECT public.release_intro_capacity('$CB')")"
chk "status untouched by the release" "suggested" "$(q "SELECT status FROM public.intro_requests WHERE id='$CA'")"

echo "── 5. a STALE expression cannot release a later card ──"
C2=$(q "INSERT INTO public.profiles DEFAULT VALUES RETURNING id")
L2=$(q "SELECT least('$A'::uuid,'$C2'::uuid)"); H2=$(q "SELECT greatest('$A'::uuid,'$C2'::uuid)")
P2=$(q "INSERT INTO public.member_pairs(user_a_id,user_b_id) VALUES ('$L2','$H2') RETURNING id")
OLDC=$(q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id,created_at) VALUES ('$A','$C2','expired','$P2', now()-interval '90 days') RETURNING id")
# Shaped exactly as express_intro_interest writes one: correlated, and NOT pair_id-bearing.
"${PSQL[@]}" -c "INSERT INTO public.intro_requests(requester_id,target_user_id,status,responds_to_id,created_at) VALUES ('$A','$C2','pending','$OLDC', now()-interval '89 days')" >/dev/null
NEWC=$(q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id,created_at) VALUES ('$A','$C2','suggested','$P2', now()-interval '1 hour') RETURNING id")
chk "old expression does NOT release the new card" "f" "$(q "SELECT public.release_intro_capacity('$NEWC')")"
chk "new card still counts" "0" "$(q "SELECT count(*) FROM public.intro_requests WHERE id='$NEWC' AND capacity_released_at IS NOT NULL")"

echo "── 6. capacity writers ignore released rows ──"
chk "A holds 2 suggested rows" "2" "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$A' AND status='suggested'")"
chk "but only 1 counts against capacity" "1" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$A' AND status='suggested' AND capacity_released_at IS NULL")"

echo "── 7. outbox: a release enqueues NOTHING ──"
BEFORE=$(q "SELECT count(*) FROM public.introduction_email_outbox")
"${PSQL[@]}" -c "UPDATE public.intro_requests SET capacity_released_at = now() WHERE id='$CB' AND pair_id IS NOT NULL" >/dev/null
chk "capacity-only UPDATE enqueued nothing" "$BEFORE" "$(q "SELECT count(*) FROM public.introduction_email_outbox")"
chk "the trigger is still UPDATE OF status" "1" \
  "$(q "SELECT count(*) FROM pg_trigger WHERE tgname='intro_requests_visible_outbox_aiu' AND pg_get_triggerdef(oid) LIKE '%UPDATE OF status%'")"
# A FRESH row: CB already had an outbox entry from its own INSERT, and ON CONFLICT DO NOTHING
# correctly deduped it — so re-transitioning CB proves nothing. This row is born 'queued' (no
# outbox event) and then becomes visible, which is the transition that must still enqueue.
FRESH=$(q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id) VALUES ('$A','$B','queued','$P') RETURNING id")
chk "a queued row enqueued nothing on insert" "$BEFORE" "$(q "SELECT count(*) FROM public.introduction_email_outbox")"
"${PSQL[@]}" -c "UPDATE public.intro_requests SET status='suggested' WHERE id='$FRESH'" >/dev/null
chk "queued -> suggested STILL enqueues (legitimate notification intact)" "$((BEFORE+1))" \
  "$(q "SELECT count(*) FROM public.introduction_email_outbox")"
chk "and the new event names that row" "1" \
  "$(q "SELECT count(*) FROM public.introduction_email_outbox WHERE intro_request_id='$FRESH'")"
"${PSQL[@]}" -c "DELETE FROM public.introduction_email_outbox WHERE intro_request_id='$FRESH'; DELETE FROM public.intro_requests WHERE id='$FRESH'" >/dev/null
"${PSQL[@]}" -c "UPDATE public.intro_requests SET capacity_released_at=NULL WHERE id='$CB'" >/dev/null

echo "── 8. terminal transitions still work AFTER release ──"
chk "a released row can be passed" "ok" \
  "$("${PSQL[@]}" -c "UPDATE public.intro_requests SET status='passed' WHERE id='$CA'" >/dev/null 2>&1 && echo ok || echo REJECTED)"
chk "and expired" "ok" \
  "$("${PSQL[@]}" -c "UPDATE public.intro_requests SET status='expired' WHERE id='$CA'" >/dev/null 2>&1 && echo ok || echo REJECTED)"
chk "released+terminal rows never count as capacity" "0" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE id='$CA' AND status='suggested' AND capacity_released_at IS NULL")"

echo "── 9. races under the canonical locks ──"
"${PSQL[@]}" -c "UPDATE public.intro_requests SET status='suggested', capacity_released_at=NULL WHERE id='$CA'" >/dev/null
for i in 1 2 3 4 5 6; do ("$PGBIN/psql" -U postgres -X -q -c "SELECT public.release_intro_capacity('$CA')" >/dev/null 2>&1 || true) & done; wait
chk "6 concurrent releases -> exactly one released row" "1" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE id='$CA' AND capacity_released_at IS NOT NULL")"
"${PSQL[@]}" -c "UPDATE public.intro_requests SET capacity_released_at=NULL, status='passed' WHERE id='$CA'" >/dev/null
chk "release loses to a pass that already landed" "f" "$(q "SELECT public.release_intro_capacity('$CA')")"
"${PSQL[@]}" -c "UPDATE public.intro_requests SET status='expired' WHERE id='$CA'" >/dev/null
chk "release loses to an expiry that already landed" "f" "$(q "SELECT public.release_intro_capacity('$CA')")"

echo "── 10. legacy pairless rows are never releasable ──"
LEG=$(q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,created_at) VALUES ('$A','$B','suggested', now()-interval '30 days') RETURNING id")
"${PSQL[@]}" -c "INSERT INTO public.intro_requests(requester_id,target_user_id,status,responds_to_id,created_at) VALUES ('$A','$B','pending','$LEG', now()-interval '29 days')" >/dev/null
chk "pairless row cannot be released" "f" "$(q "SELECT public.release_intro_capacity('$LEG')")"
chk "and it appears in the operator review view" "1" \
  "$(q "SELECT count(*) FROM public.introduction_capacity_review WHERE review_kind='legacy_pairless_hidden' AND intro_request_id='$LEG'")"
chk "the review view is service_role only" "f" "$(q "SELECT has_table_privilege('authenticated','public.introduction_capacity_review','SELECT')")"

echo "── 11. ineligible owners surfaced, not mutated ──"
"${PSQL[@]}" -c "UPDATE public.profiles SET account_status='deactivated' WHERE id='$B'" >/dev/null
chk "ineligible owner's open card is listed" "1" \
  "$(q "SELECT count(*) FROM public.introduction_capacity_review WHERE review_kind='ineligible_owner' AND intro_request_id='$CB'")"
chk "and 080 mutated no row (card still suggested)" "suggested" "$(q "SELECT status FROM public.intro_requests WHERE id='$CB'")"
"${PSQL[@]}" -c "UPDATE public.profiles SET account_status='active' WHERE id='$B'" >/dev/null

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# 12. END TO END: DELAYED MUTUAL COMPLETION AFTER A RELEASE
#     Real create_reciprocal_suggestion (replaced by 080), real express_intro_interest, real
#     release_intro_capacity, real finalize_mutual_match_atomic + consume_credits_and_create_match.
# ═══════════════════════════════════════════════════════════════════════════════════════════════
echo "── 12. delayed mutual completion after release ──"
M1=$(q "INSERT INTO public.profiles(email) VALUES ('m1@example.com') RETURNING id")
M2=$(q "INSERT INTO public.profiles(email) VALUES ('m2@example.com') RETURNING id")
D1=$(q "INSERT INTO public.profiles(email) VALUES ('d1@example.com') RETURNING id")
FILL=$(q "INSERT INTO public.profiles(email) VALUES ('fill@example.com') RETURNING id")
"${PSQL[@]}" -c "INSERT INTO public.meeting_credits(user_id,free_credits,balance) VALUES ('$M1',1,1),('$M2',1,1),('$D1',1,1)" >/dev/null

chk "the REAL create_reciprocal_suggestion places the pair" "created" \
  "$(q "SELECT public.create_reciprocal_suggestion('$M1','$M2','reciprocal',NULL,30,2)")"
PM=$(q "SELECT id FROM public.member_pairs WHERE user_a_id=least('$M1'::uuid,'$M2'::uuid) AND user_b_id=greatest('$M1'::uuid,'$M2'::uuid)")
CM1=$(q "SELECT id FROM public.intro_requests WHERE pair_id='$PM' AND requester_id='$M1'")
CM2=$(q "SELECT id FROM public.intro_requests WHERE pair_id='$PM' AND requester_id='$M2'")

# Fill M1 to the visible cap so CAPACITY, not eligibility, is what refuses the next introduction.
chk "second card placed (M1 now at the visible cap)" "created" \
  "$(q "SELECT public.create_reciprocal_suggestion('$M1','$FILL','reciprocal',NULL,30,2)")"
chk "M1 is at the visible cap" "2" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$M1' AND status='suggested' AND capacity_released_at IS NULL")"
chk "so a further introduction is refused for CAPACITY" "capacity" \
  "$(q "SELECT public.create_reciprocal_suggestion('$M1','$D1','reciprocal',NULL,30,2)")"

chk "A expresses interest on that exact card" "created" \
  "$(q "SELECT out_state FROM public.express_intro_interest('$CM1','$M1','$M2',NULL)")"
EM1=$(q "SELECT id FROM public.intro_requests WHERE responds_to_id='$CM1'")
"${PSQL[@]}" -c "UPDATE public.intro_requests SET status='approved' WHERE id='$EM1'" >/dev/null
chk "the expression is correlated to THAT card" "1" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE id='$EM1' AND responds_to_id='$CM1'")"

chk "not releasable yet (under 72h)" "f" "$(q "SELECT public.release_intro_capacity('$CM1')")"
"${PSQL[@]}" -c "UPDATE public.intro_requests SET created_at = now() - interval '73 hours' WHERE id='$EM1'" >/dev/null
chk "releasable 72h after the EXPRESSION's created_at" "t" "$(q "SELECT public.release_intro_capacity('$CM1')")"
chk "only A's card released" "1" "$(q "SELECT count(*) FROM public.intro_requests WHERE id='$CM1' AND capacity_released_at IS NOT NULL")"
chk "B's actionable card NOT released" "0" "$(q "SELECT count(*) FROM public.intro_requests WHERE id='$CM2' AND capacity_released_at IS NOT NULL")"
chk "B's card still actionable in the 14-day window" "suggested" "$(q "SELECT status FROM public.intro_requests WHERE id='$CM2'")"
chk "A's card status untouched (still answerable)" "suggested" "$(q "SELECT status FROM public.intro_requests WHERE id='$CM1'")"

chk "A can now receive a REPLACEMENT introduction" "created" \
  "$(q "SELECT public.create_reciprocal_suggestion('$M1','$D1','reciprocal',NULL,30,2)")"
CREP=$(q "SELECT id FROM public.intro_requests WHERE requester_id='$M1' AND target_user_id='$D1' AND status='suggested'")

OB0=$(q "SELECT count(*) FROM public.introduction_email_outbox")
chk "B later expresses interest on B's own card" "created" \
  "$(q "SELECT out_state FROM public.express_intro_interest('$CM2','$M2','$M1',NULL)")"
EM2=$(q "SELECT id FROM public.intro_requests WHERE responds_to_id='$CM2'")
"${PSQL[@]}" -c "UPDATE public.intro_requests SET status='approved' WHERE id='$EM2'" >/dev/null
chk "expressing interest enqueued NO outbox event" "$OB0" "$(q "SELECT count(*) FROM public.introduction_email_outbox")"

chk "the pair finalizes" "finalized" \
  "$(q "SELECT public.finalize_mutual_match_atomic('$M2','$M1',false)->>'outcome'")"
chk "exactly ONE match" "1" \
  "$(q "SELECT count(*) FROM public.matches WHERE (user_a_id='$M1' AND user_b_id='$M2') OR (user_a_id='$M2' AND user_b_id='$M1')")"
chk "exactly ONE conversation" "1" \
  "$(q "SELECT count(*) FROM public.conversations c JOIN public.matches m ON m.id=c.match_id WHERE m.user_a_id IN ('$M1','$M2') AND m.user_b_id IN ('$M1','$M2')")"
chk "A charged exactly one free credit" "0" "$(q "SELECT free_credits FROM public.meeting_credits WHERE user_id='$M1'")"
chk "B charged exactly one free credit" "0" "$(q "SELECT free_credits FROM public.meeting_credits WHERE user_id='$M2'")"
chk "finalization is idempotent" "already_matched" \
  "$(q "SELECT public.finalize_mutual_match_atomic('$M2','$M1',false)->>'outcome'")"
chk "still exactly one match after the retry" "1" \
  "$(q "SELECT count(*) FROM public.matches WHERE (user_a_id='$M1' AND user_b_id='$M2') OR (user_a_id='$M2' AND user_b_id='$M1')")"
chk "and no further credit was taken" "0" "$(q "SELECT free_credits FROM public.meeting_credits WHERE user_id='$M1'")"
chk "no duplicate outbox event from finalization" "$OB0" "$(q "SELECT count(*) FROM public.introduction_email_outbox")"
chk "A's REPLACEMENT card survives intact" "suggested" "$(q "SELECT status FROM public.intro_requests WHERE id='$CREP'")"
chk "and it was never released" "0" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE id='$CREP' AND capacity_released_at IS NOT NULL")"

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# 13. THE COMPETING TERMINAL CASE: B PASSES INSIDE THE 14-DAY WINDOW
# ═══════════════════════════════════════════════════════════════════════════════════════════════
echo "── 13. B passes after A's capacity was released ──"
N1=$(q "INSERT INTO public.profiles(email) VALUES ('n1@example.com') RETURNING id")
N2=$(q "INSERT INTO public.profiles(email) VALUES ('n2@example.com') RETURNING id")
"${PSQL[@]}" -c "INSERT INTO public.meeting_credits(user_id,free_credits,balance) VALUES ('$N1',1,1),('$N2',1,1)" >/dev/null
chk "pair placed" "created" "$(q "SELECT public.create_reciprocal_suggestion('$N1','$N2','reciprocal',NULL,30,2)")"
PN=$(q "SELECT id FROM public.member_pairs WHERE user_a_id=least('$N1'::uuid,'$N2'::uuid) AND user_b_id=greatest('$N1'::uuid,'$N2'::uuid)")
CN1=$(q "SELECT id FROM public.intro_requests WHERE pair_id='$PN' AND requester_id='$N1'")
CN2=$(q "SELECT id FROM public.intro_requests WHERE pair_id='$PN' AND requester_id='$N2'")
q "SELECT out_state FROM public.express_intro_interest('$CN1','$N1','$N2',NULL)" >/dev/null
EN1=$(q "SELECT id FROM public.intro_requests WHERE responds_to_id='$CN1'")
"${PSQL[@]}" -c "UPDATE public.intro_requests SET status='approved', created_at=now()-interval '80 hours' WHERE id='$EN1'" >/dev/null
chk "A's capacity released" "t" "$(q "SELECT public.release_intro_capacity('$CN1')")"
RECOMMENDED_AT=$(q "SELECT last_recommended_at FROM public.member_pairs WHERE id='$PN'")

chk "B passes" "passed" "$(q "SELECT public.pass_reciprocal_pair('$PN','$N2')")"
chk "B's own row records the pass" "passed" "$(q "SELECT status FROM public.intro_requests WHERE id='$CN2'")"
chk "A's card closed NEUTRALLY (no decline leaked)" "expired" \
  "$(q "SELECT status FROM public.intro_requests WHERE id='$CN1'")"
chk "the pair is terminal" "passed" "$(q "SELECT status FROM public.member_pairs WHERE id='$PN'")"
chk "A's waiting state disappears" "0" \
  "$(q "SELECT count(*) FROM public.intro_requests e JOIN public.intro_requests c ON c.id = e.responds_to_id WHERE e.requester_id='$N1' AND e.responds_to_id IS NOT NULL AND e.status IN ('pending','approved') AND c.status='suggested' AND c.pair_id IS NOT NULL")"
chk "no match was created" "0" \
  "$(q "SELECT count(*) FROM public.matches WHERE user_a_id IN ('$N1','$N2') AND user_b_id IN ('$N1','$N2')")"
chk "no conversation was created" "0" \
  "$(q "SELECT count(*) FROM public.conversations c JOIN public.matches m ON m.id=c.match_id WHERE m.user_a_id IN ('$N1','$N2')")"
chk "no credit was debited from A" "1" "$(q "SELECT free_credits FROM public.meeting_credits WHERE user_id='$N1'")"
chk "no credit was debited from B" "1" "$(q "SELECT free_credits FROM public.meeting_credits WHERE user_id='$N2'")"
chk "the 30-day cooldown clock is untouched" "$RECOMMENDED_AT" \
  "$(q "SELECT last_recommended_at FROM public.member_pairs WHERE id='$PN'")"
chk "so the pair cannot be re-recommended now" "exists_active" \
  "$(q "SELECT public.create_reciprocal_suggestion('$N1','$N2','reciprocal',NULL,30,2)")"
chk "a released+closed row never counts as capacity" "0" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE id='$CN1' AND status='suggested' AND capacity_released_at IS NULL")"
chk "and a terminal lifecycle can never be released again" "f" "$(q "SELECT public.release_intro_capacity('$CN1')")"

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# 14. INTEGRITY WITHOUT A FOREIGN KEY: DELETION, ORPHANS, TRUNCATION
# ═══════════════════════════════════════════════════════════════════════════════════════════════
echo "── 14. deletion / orphan / truncation rehearsal ──"
chk "no orphaned correlation exists yet" "0" \
  "$(q "SELECT count(*) FROM public.introduction_capacity_review WHERE review_kind='orphan_responds_to'")"

K1=$(q "INSERT INTO public.profiles(email) VALUES ('k1@example.com') RETURNING id")
K2=$(q "INSERT INTO public.profiles(email) VALUES ('k2@example.com') RETURNING id")
q "SELECT public.create_reciprocal_suggestion('$K1','$K2','reciprocal',NULL,30,2)" >/dev/null
PK=$(q "SELECT id FROM public.member_pairs WHERE user_a_id=least('$K1'::uuid,'$K2'::uuid) AND user_b_id=greatest('$K1'::uuid,'$K2'::uuid)")
CK1=$(q "SELECT id FROM public.intro_requests WHERE pair_id='$PK' AND requester_id='$K1'")
q "SELECT out_state FROM public.express_intro_interest('$CK1','$K1','$K2',NULL)" >/dev/null

chk "delete_user_account's intro_requests statement succeeds" "ok" \
  "$("${PSQL[@]}" -c "SELECT public.delete_member_intro_rows('$K2')" >/dev/null 2>&1 && echo ok || echo ERRORED)"
chk "card and correlated expression both gone" "0" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id IN ('$K1','$K2') OR target_user_id IN ('$K1','$K2')")"
chk "and no orphan was produced" "0" \
  "$(q "SELECT count(*) FROM public.introduction_capacity_review WHERE review_kind='orphan_responds_to'")"

echo "  -- a forced orphan is inert AND counted --"
GHOST=$(q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id,created_at) VALUES ('$A','$B','suggested','$P', now()-interval '9 days') RETURNING id")
ORPH=$(q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,responds_to_id,created_at) VALUES ('$A','$B','pending','$GHOST', now()-interval '8 days') RETURNING id")
"${PSQL[@]}" -c "DELETE FROM public.intro_requests WHERE id='$GHOST'" >/dev/null
chk "the orphan is surfaced by the standing audit" "1" \
  "$(q "SELECT count(*) FROM public.introduction_capacity_review WHERE review_kind='orphan_responds_to' AND intro_request_id='$ORPH'")"
chk "releasing the vanished card is a no-op" "f" "$(q "SELECT public.release_intro_capacity('$GHOST')")"
LIVE=$(q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id,created_at) VALUES ('$A','$B','suggested','$P', now()-interval '9 days') RETURNING id")
chk "and it cannot release ANY other card" "f" "$(q "SELECT public.release_intro_capacity('$LIVE')")"
chk "an orphan renders nothing in the waiting surface" "0" \
  "$(q "SELECT count(*) FROM public.intro_requests e JOIN public.intro_requests c ON c.id = e.responds_to_id WHERE e.id='$ORPH' AND c.status='suggested'")"
"${PSQL[@]}" -c "DELETE FROM public.intro_requests WHERE id IN ('$ORPH','$LIVE')" >/dev/null

chk "a BULK multi-row delete across correlated rows succeeds" "ok" \
  "$("${PSQL[@]}" -c "BEGIN; DELETE FROM public.intro_requests WHERE responds_to_id IS NOT NULL OR status='suggested'; ROLLBACK;" >/dev/null 2>&1 && echo ok || echo ERRORED)"
chk "TRUNCATE is unaffected (no FK participates)" "ok" \
  "$("${PSQL[@]}" -c "BEGIN; TRUNCATE public.intro_requests CASCADE; ROLLBACK;" >/dev/null 2>&1 && echo ok || echo ERRORED)"
chk "still no foreign key referencing responds_to_id" "0" \
  "$(q "SELECT count(*) FROM pg_constraint WHERE conrelid='public.intro_requests'::regclass AND contype='f'::\"char\" AND pg_get_constraintdef(oid) LIKE '%responds_to_id%'")"

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# 15. THE AUDITS THEMSELVES EXECUTE AGAINST A REAL CATALOG
#     pglast validates syntax, not catalogs. rb.id parsed perfectly and failed in production with
#     42703. The only thing that catches an undefined column is running it.
# ═══════════════════════════════════════════════════════════════════════════════════════════════
echo "── 15. preflight / post-apply audits execute ──"
PF=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/080_postapply.sql 2>&1 || true)
chk "post-apply audit runs with no ERROR" "0" "$(printf '%s' "$PF" | grep -cE '(ERROR|FATAL):' || true)"
chk "  and reports no accidental overloads" "1" "$(printf '%s' "$PF" | grep -c '"no_accidental_overloads": true' || true)"
chk "  and no expression carries pair_id" "1" "$(printf '%s' "$PF" | grep -c '"expressions_carrying_pair_id_DEFECT": 0' || true)"
chk "  and no released row lacks a correlated expression" "1" \
  "$(printf '%s' "$PF" | grep -c '"released_with_no_correlated_expression_DEFECT": 0' || true)"
chk "  and no member is above the visible cap" "1" "$(printf '%s' "$PF" | grep -c '"members_above_visible_cap_DEFECT": 0' || true)"
chk "  and no released row is unpaired" "1" "$(printf '%s' "$PF" | grep -c '"released_but_unpaired_DEFECT": 0' || true)"

echo
[ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "FAILURES PRESENT"; exit 1; }
