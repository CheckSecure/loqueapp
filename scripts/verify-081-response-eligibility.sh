#!/usr/bin/env bash
# Executes the REAL migrations 080 THEN 081 against a PostgreSQL cluster reproducing Supabase's
# inherited default privileges. Cluster destroyed on exit. Nothing here touches production.
set -euo pipefail
PGBIN=/opt/homebrew/opt/postgresql@17/bin
DATA=$(mktemp -d)/pg81; PORT=55491
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


echo "── 1. APPLY 080 (the prerequisite), then verify the post-080 baselines ──"
"${PSQL[@]}" -f supabase/migrations/080_introduction_capacity_release.sql >/dev/null
while IFS='|' read -r fn md5 len; do
  chk "post-080 $fn md5" "$md5" "$(q "SELECT md5(prosrc) FROM pg_proc WHERE proname='$fn'")"
  chk "post-080 $fn length(prosrc)" "$len" "$(q "SELECT length(prosrc) FROM pg_proc WHERE proname='$fn'")"
done <<'IDS'
create_reciprocal_suggestion|e86e1dde486a4da9c72883b42e0fb391|6187
place_batch_rows|64512aa7d77c56a251239cf329527b1b|11449
promote_queued_rows|bf31f1ce0df71c432e098e7e1b6311dd|6132
materialize_admin_pair|a2f2fbd5e3c5c63993b2a59849fe7c6b|22087
IDS

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# 2. NEGATIVE CONTROLS — 081 must refuse and roll back completely
# ═══════════════════════════════════════════════════════════════════════════════════════════════
echo "── 2. NEGATIVE CONTROLS ──"
set +e
assert_nothing_left(){
  local n
  n=$(q "SELECT
      (SELECT count(*) FROM information_schema.columns WHERE table_name='intro_requests' AND column_name='release_id')
    + (SELECT count(*) FROM pg_proc WHERE proname='count_unresolved_introductions')
    + (SELECT count(*) FROM pg_indexes WHERE indexname='intro_requests_unresolved_idx')
    + (SELECT count(*) FROM pg_proc p JOIN pg_namespace nn ON nn.oid=p.pronamespace
        WHERE nn.nspname='public' AND p.proname='create_reciprocal_suggestion'
          AND pg_get_function_identity_arguments(p.oid) LIKE '%p_release_id%')")
  chk "  $1 -> nothing left behind" "0" "$n"
  # the DROP must roll back too: the ORIGINAL 6-arg signature must still be there
  chk "  $1 -> original writer signature intact" "1" \
    "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace nn ON nn.oid=p.pronamespace WHERE nn.nspname='public' AND p.proname='create_reciprocal_suggestion'")"
}
try_081(){ "${PSQL[@]}" -f supabase/migrations/081_response_eligibility.sql >/dev/null 2>&1 && echo APPLIED || echo blocked; }
# 080 is idempotency-guarded and REFUSES to re-apply once its columns exist, so re-running the file
# restores nothing. Restore from the post-080 definitions extracted out of it instead, plus the ACLs
# and the column artifacts a CASCADE drop would have taken with it.
{ extract supabase/migrations/080_introduction_capacity_release.sql create_reciprocal_suggestion
  extract supabase/migrations/080_introduction_capacity_release.sql place_batch_rows
  extract supabase/migrations/080_introduction_capacity_release.sql promote_queued_rows
  extract supabase/migrations/080_introduction_capacity_release.sql materialize_admin_pair
} > "$DATA/post080.sql"
restore_080(){
  "${PSQL[@]}" -f "$DATA/post080.sql" >/dev/null 2>&1
  "${PSQL[@]}" -f "$DATA/acl.sql" >/dev/null 2>&1
  "${PSQL[@]}" -c "ALTER TABLE public.intro_requests ADD COLUMN IF NOT EXISTS responds_to_id uuid;
    ALTER TABLE public.intro_requests ADD COLUMN IF NOT EXISTS capacity_released_at timestamptz;
    ALTER TABLE public.intro_requests DROP CONSTRAINT IF EXISTS intro_requests_released_requires_pair_chk;
    ALTER TABLE public.intro_requests ADD CONSTRAINT intro_requests_released_requires_pair_chk
      CHECK (capacity_released_at IS NULL OR pair_id IS NOT NULL);
    CREATE INDEX IF NOT EXISTS intro_requests_capacity_live_idx ON public.intro_requests (requester_id)
      WHERE status = 'suggested' AND capacity_released_at IS NULL;
    CREATE INDEX IF NOT EXISTS intro_requests_responds_to_idx ON public.intro_requests (responds_to_id)
      WHERE responds_to_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS intro_requests_one_expression_per_card_uniq
      ON public.intro_requests (responds_to_id)
      WHERE responds_to_id IS NOT NULL AND status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending');" >/dev/null 2>&1
}
# Prove the restore actually restores, or every negative control below is meaningless.
restore_080
chk "restore_080 really restores the post-080 body" "e86e1dde486a4da9c72883b42e0fb391" \
  "$(q "SELECT md5(prosrc) FROM pg_proc WHERE proname='create_reciprocal_suggestion'")"

# (a) a post-080 body edited, all markers intact
"${PSQL[@]}" -c "$(awk '/^CREATE OR REPLACE FUNCTION public.promote_queued_rows\(/,/^\$fn\$;/' supabase/migrations/080_introduction_capacity_release.sql | sed "s/'deferred_capacity'/'deferred_capacity2'/")" >/dev/null 2>&1
"${PSQL[@]}" -f "$DATA/acl.sql" >/dev/null 2>&1
chk "(a) post-080 body edited      -> REFUSED" "blocked" "$(try_081)"; assert_nothing_left "(a)"; restore_080

# (b) SECURITY DEFINER removed
"${PSQL[@]}" -c "ALTER FUNCTION public.place_batch_rows(uuid, text, jsonb, uuid, integer) SECURITY INVOKER" >/dev/null 2>&1
chk "(b) SECURITY DEFINER removed  -> REFUSED" "blocked" "$(try_081)"; assert_nothing_left "(b)"; restore_080

# (c) empty search_path removed
"${PSQL[@]}" -c "ALTER FUNCTION public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer) RESET search_path" >/dev/null 2>&1
chk "(c) empty search_path removed -> REFUSED" "blocked" "$(try_081)"; assert_nothing_left "(c)"; restore_080

# (d) a browser role can execute
"${PSQL[@]}" -c "GRANT EXECUTE ON FUNCTION public.promote_queued_rows(uuid) TO authenticated" >/dev/null 2>&1
chk "(d) authenticated can execute -> REFUSED" "blocked" "$(try_081)"; assert_nothing_left "(d)"; restore_080

# (e) an unexpected overload
"${PSQL[@]}" -c "CREATE FUNCTION public.promote_queued_rows(p_member_id uuid, x integer) RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = '' AS \$\$ SELECT '{}'::jsonb \$\$;" >/dev/null 2>&1
chk "(e) unexpected overload       -> REFUSED" "blocked" "$(try_081)"; assert_nothing_left "(e)"
"${PSQL[@]}" -c "DROP FUNCTION public.promote_queued_rows(uuid, integer)" >/dev/null 2>&1; restore_080

# (f) expire_intro_pair drifted
"${PSQL[@]}" -c "$(awk '/^CREATE OR REPLACE FUNCTION public.expire_intro_pair\(/,/^\$\$;/' supabase/migrations/066_expire_intro_pair.sql | sed "s/'nothing_open'/'nothing_open_v9'/")" >/dev/null 2>&1
chk "(f) expire_intro_pair drifted -> REFUSED" "blocked" "$(try_081)"; assert_nothing_left "(f)"
"${PSQL[@]}" -c "$(awk '/^CREATE OR REPLACE FUNCTION public.expire_intro_pair\(/,/^\$\$;/' supabase/migrations/066_expire_intro_pair.sql)" >/dev/null 2>&1
"${PSQL[@]}" -f "$DATA/acl.sql" >/dev/null 2>&1; restore_080

# (g) 080 not applied at all
"${PSQL[@]}" -c "ALTER TABLE public.intro_requests DROP COLUMN capacity_released_at CASCADE" >/dev/null 2>&1
chk "(g) 080 not applied           -> REFUSED" "blocked" "$(try_081)"
"${PSQL[@]}" -c "ALTER TABLE public.intro_requests ADD COLUMN capacity_released_at timestamptz" >/dev/null 2>&1
restore_080
set -e

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# 2b. THE PREFLIGHT MUST RUN BEFORE 081 EXISTS
#     Production returned 42703 here: PostgreSQL resolves every column reference while PARSING, so
#     `WHERE release_id IS NOT NULL` fails on a pre-081 database however it is wrapped. pglast could
#     never have caught it — it validates syntax, not catalogs. Only executing it against a real
#     pre-081 cluster does.
# ═══════════════════════════════════════════════════════════════════════════════════════════════
echo "── 2b. preflight executes on a PRE-081 database ──"
PRE0=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/081_preflight.sql 2>&1 || true)
chk "no ERROR or FATAL of any kind" "0" "$(printf '%s' "$PRE0" | grep -cE '(ERROR|FATAL):' || true)"
chk "  specifically no 42703 undefined_column" "0" "$(printf '%s' "$PRE0" | grep -ci '42703\|does not exist' || true)"
chk "overall_verdict is PASS" "1" "$(printf '%s' "$PRE0" | grep -c '"overall_verdict": "PASS"' || true)"
chk "blocker_count is 0" "1" "$(printf '%s' "$PRE0" | grep -c '"blocker_count": 0' || true)"
chk "release_id_already_added is false" "1" "$(printf '%s' "$PRE0" | grep -c '"release_id_already_added": false' || true)"
chk "rows_with_release_id is 0" "1" "$(printf '%s' "$PRE0" | grep -c '"rows_with_release_id": 0' || true)"
chk "predicate_already_present is false" "1" "$(printf '%s' "$PRE0" | grep -c '"predicate_already_present": false' || true)"
chk "migration_080_applied is true" "1" "$(printf '%s' "$PRE0" | grep -c '"migration_080_applied": true' || true)"
chk "all five post-080 bodies verify" "5" "$(printf '%s' "$PRE0" | grep -c '"verdict": "PASS"' || true)"

# NEGATIVE CONTROL. Without this the check above proves nothing: a preflight that happened to avoid
# the column for an unrelated reason would pass just as well. This is the EXACT expression that
# failed in production, run against the same pre-081 cluster.
NEG=$("$PGBIN/psql" -U postgres -X -q -c "SELECT count(*) FROM public.intro_requests WHERE release_id IS NOT NULL" 2>&1 || true)
chk "the OLD direct reference still raises 42703 here" "1" \
  "$(printf '%s' "$NEG" | grep -ci 'column "release_id" does not exist' || true)"
# ...and a CASE guard does NOT save it — the whole point of the fix.
NEG2=$("$PGBIN/psql" -U postgres -X -q -c "SELECT CASE WHEN false THEN (SELECT count(*) FROM public.intro_requests WHERE release_id IS NOT NULL) ELSE 0 END" 2>&1 || true)
chk "  and wrapping it in CASE does NOT save it" "1" \
  "$(printf '%s' "$NEG2" | grep -ci 'column "release_id" does not exist' || true)"
# The replacement expression, by contrast, parses fine right now.
POSX=$("$PGBIN/psql" -U postgres -X -q -tA -c "SELECT count(*) FROM public.intro_requests t WHERE to_jsonb(t) ->> 'release_id' IS NOT NULL" 2>&1 || true)
chk "  while the to_jsonb form parses and returns 0" "0" "$(printf '%s' "$POSX" | grep -cE '(ERROR|FATAL):' || true)"
chk "  returning exactly zero" "0" "$(printf '%s' "$POSX" | tr -d '[:space:]')"

echo "── 3. APPLY 081 on the pristine post-080 fixture (the positive control) ──"
APPLY_RC=0
APPLY_OUT=$("${PSQL[@]}" -f supabase/migrations/081_response_eligibility.sql 2>&1) || APPLY_RC=$?
[ $APPLY_RC -eq 0 ] || printf "  APPLY ERROR:\n%s\n" "$(printf "%s" "$APPLY_OUT" | grep -E "ERROR|DETAIL|CONTEXT" | head -6)"
chk "audited fixture is ADMITTED (controls are not vacuous)" "0" "$APPLY_RC"
chk "re-applying is BLOCKED" "blocked" "$(try_081)"
chk "release_id column added, nullable, unbackfilled" "0" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE release_id IS NOT NULL")"
chk "count_unresolved_introductions: empty search_path" "t" \
  "$(q "SELECT 'search_path=\"\"' = ANY(proconfig) FROM pg_proc WHERE proname='count_unresolved_introductions'")"
for r in anon authenticated; do
  chk "predicate: $r cannot execute" "f" \
    "$(q "SELECT has_function_privilege('$r', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='count_unresolved_introductions'")"
done
chk "reciprocal writer now takes p_release_id" "1" \
  "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='create_reciprocal_suggestion' AND pg_get_function_identity_arguments(p.oid) LIKE '%p_release_id uuid%'")"
chk "and no overload was left behind" "1" \
  "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='create_reciprocal_suggestion'")"
for r in anon authenticated; do
  chk "new writer signature: $r cannot execute" "f" \
    "$(q "SELECT has_function_privilege('$r', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='create_reciprocal_suggestion'")"
done
chk "all four writers reference the ONE predicate" "4" \
  "$(q "SELECT count(*) FROM pg_proc WHERE proname IN ('create_reciprocal_suggestion','place_batch_rows','promote_queued_rows','materialize_admin_pair') AND prosrc LIKE '%count_unresolved_introductions%'")"
chk "admin materialization gate precedes its first INSERT (atomic refusal)" "t" \
  "$(q "SELECT strpos(prosrc,'12b) RESPONSE ELIGIBILITY') < strpos(prosrc,'INSERT INTO public.intro_requests') FROM pg_proc WHERE proname='materialize_admin_pair'")"
chk "expire_intro_pair still untouched" "c786da9312cf962eb06ec6463ceecfd8" \
  "$(q "SELECT md5(prosrc) FROM pg_proc WHERE proname='expire_intro_pair'")"

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# 4. THE PREDICATE — what counts, and what deliberately does not
# ═══════════════════════════════════════════════════════════════════════════════════════════════
echo "── 4. the authoritative predicate ──"
mk(){ q "INSERT INTO public.profiles(email) VALUES ('$1@t.io') RETURNING id"; }
pair(){ q "INSERT INTO public.member_pairs(user_a_id,user_b_id) VALUES (least('$1'::uuid,'$2'::uuid),greatest('$1'::uuid,'$2'::uuid)) RETURNING id"; }
card(){ q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id) VALUES ('$1','$2','suggested','$3') RETURNING id"; }
u(){ q "SELECT public.count_unresolved_introductions('$1', ${2:-NULL}, ${3:-NULL})"; }

P1=$(mk p1); P2=$(mk p2)
PR=$(pair "$P1" "$P2"); C1=$(card "$P1" "$P2" "$PR")
chk "an unanswered suggested card counts" "1" "$(u "$P1")"
chk "  and the counterparty is unaffected" "0" "$(u "$P2")"

"${PSQL[@]}" -c "INSERT INTO public.intro_requests(requester_id,target_user_id,status,responds_to_id) VALUES ('$P1','$P2','pending','$C1')" >/dev/null
chk "a CORRELATED expression resolves it" "0" "$(u "$P1")"
"${PSQL[@]}" -c "DELETE FROM public.intro_requests WHERE responds_to_id='$C1'" >/dev/null
"${PSQL[@]}" -c "INSERT INTO public.intro_requests(requester_id,target_user_id,status) VALUES ('$P1','$P2','approved')" >/dev/null
chk "a LEGACY expression resolves it (pre-080 semantics preserved)" "0" "$(u "$P1")"
"${PSQL[@]}" -c "DELETE FROM public.intro_requests WHERE requester_id='$P1' AND status='approved'" >/dev/null
chk "  back to unresolved once withdrawn" "1" "$(u "$P1")"

"${PSQL[@]}" -c "UPDATE public.intro_requests SET capacity_released_at=now() WHERE id='$C1'" >/dev/null
chk "capacity_released alone does NOT resolve it (still answerable)" "1" "$(u "$P1")"
"${PSQL[@]}" -c "INSERT INTO public.intro_requests(requester_id,target_user_id,status,responds_to_id) VALUES ('$P1','$P2','approved','$C1')" >/dev/null
chk "a RELEASED card whose author expressed IS resolved" "0" "$(u "$P1")"
"${PSQL[@]}" -c "DELETE FROM public.intro_requests WHERE responds_to_id='$C1'; UPDATE public.intro_requests SET capacity_released_at=NULL WHERE id='$C1'" >/dev/null

"${PSQL[@]}" -c "UPDATE public.intro_requests SET status='queued' WHERE id='$C1'" >/dev/null
chk "a QUEUED row is not actionable" "0" "$(u "$P1")"
for st in passed expired archived hidden_permanent; do
  "${PSQL[@]}" -c "UPDATE public.intro_requests SET status='$st' WHERE id='$C1'" >/dev/null
  chk "  terminal '$st' does not count" "0" "$(u "$P1")"
done
"${PSQL[@]}" -c "UPDATE public.intro_requests SET status='suggested' WHERE id='$C1'" >/dev/null

"${PSQL[@]}" -c "UPDATE public.profiles SET account_status='deactivated' WHERE id='$P2'" >/dev/null
chk "an INACTIVE target cannot block the member (the audit's trap)" "0" "$(u "$P1")"
"${PSQL[@]}" -c "UPDATE public.profiles SET account_status='active' WHERE id='$P2'" >/dev/null

"${PSQL[@]}" -c "INSERT INTO public.intro_requests(requester_id,target_user_id,status) VALUES ('$P2','$P1','pending')" >/dev/null
chk "INCOMING interest does not control eligibility" "0" "$(u "$P1")"
"${PSQL[@]}" -c "UPDATE public.intro_requests SET status='declined' WHERE requester_id='$P2' AND target_user_id='$P1'" >/dev/null
chk "  and declining it does not re-trap the member" "1" "$(u "$P1")"
"${PSQL[@]}" -c "DELETE FROM public.intro_requests WHERE requester_id='$P2' AND target_user_id='$P1'" >/dev/null

"${PSQL[@]}" -c "INSERT INTO public.matches(user_a_id,user_b_id) VALUES ('$P1','$P2')" >/dev/null
chk "an already-MATCHED pair does not count" "0" "$(u "$P1")"
"${PSQL[@]}" -c "DELETE FROM public.matches WHERE user_a_id='$P1'" >/dev/null

RID=$(q "SELECT gen_random_uuid()")
"${PSQL[@]}" -c "UPDATE public.intro_requests SET release_id='$RID' WHERE id='$C1'" >/dev/null
chk "the release envelope excludes a sibling" "0" "$(u "$P1" "'$RID'")"
chk "  but not a card from a different release" "1" "$(u "$P1" "gen_random_uuid()")"
"${PSQL[@]}" -c "DELETE FROM public.intro_requests WHERE requester_id IN ('$P1','$P2') OR target_user_id IN ('$P1','$P2')" >/dev/null

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# 5. TRANSACTIONAL ENFORCEMENT
# ═══════════════════════════════════════════════════════════════════════════════════════════════
echo "── 5. the rule at the writers ──"
crs(){ q "SELECT public.create_reciprocal_suggestion('$1','$2','reciprocal',NULL,30,2,${3:-NULL})"; }
A=$(mk a); B=$(mk b); C=$(mk c); D=$(mk d); E=$(mk e); F=$(mk f)

REL=$(q "SELECT gen_random_uuid()")
chk "release card 1" "created" "$(crs "$A" "$B" "'$REL'")"
# THE POINT OF THE ENVELOPE: card 1 is unanswered, yet card 2 of the SAME release is still allowed.
chk "A now has one UNANSWERED card" "1" "$(u "$A")"
chk "release card 2 — SAME envelope, still allowed" "created" "$(crs "$A" "$C" "'$REL'")"
chk "A holds two cards" "2" "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$A' AND status='suggested'")"
chk "only A's rows carry the envelope" "2" "$(q "SELECT count(*) FROM public.intro_requests WHERE release_id='$REL' AND requester_id='$A'")"
chk "counterpart rows are NOT exempted (release_id NULL)" "2" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id IN ('$B','$C') AND release_id IS NULL")"

# Free ONE slot so the next refusal is provably the RESPONSE gate and not the capacity cap.
PAC=$(q "SELECT pair_id FROM public.intro_requests WHERE requester_id='$A' AND target_user_id='$C'")
q "SELECT public.pass_reciprocal_pair('$PAC','$A')" >/dev/null
chk "A has a free visible slot again" "1" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$A' AND status='suggested' AND capacity_released_at IS NULL")"
REL2=$(q "SELECT gen_random_uuid()")
chk "a LATER release is refused while the earlier one is unanswered" "unresolved" "$(crs "$A" "$D" "'$REL2'")"
chk "  and nothing was written for either side" "0" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$D' OR target_user_id='$D'")"

echo "  -- the counterpart bypass, closed --"
chk "B (one unanswered card) cannot be someone else's counterpart" "unresolved" "$(crs "$E" "$B")"
chk "  E is NOT left holding a one-sided card" "0" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$E'")"
chk "  and no member_pairs row was claimed" "0" \
  "$(q "SELECT count(*) FROM public.member_pairs WHERE (user_a_id='$E' OR user_b_id='$E')")"

echo "  -- responding restores eligibility --"
CB=$(q "SELECT id FROM public.intro_requests WHERE requester_id='$B' AND status='suggested'")
"${PSQL[@]}" -c "SELECT public.express_intro_interest('$CB','$B','$A',NULL)" >/dev/null
chk "Express interest restores eligibility immediately" "0" "$(u "$B")"
chk "  even though B is now waiting privately" "1" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE responds_to_id='$CB'")"

echo "  -- 72h capacity release must not re-block --"
"${PSQL[@]}" -c "UPDATE public.intro_requests SET created_at=now()-interval '80 hours' WHERE responds_to_id='$CB'" >/dev/null
chk "release_intro_capacity succeeds" "t" "$(q "SELECT public.release_intro_capacity('$CB')")"
chk "  and B is STILL clear afterwards (the card is answered, not merely released)" "0" "$(u "$B")"
chk "  so B can now be a counterpart" "created" "$(crs "$E" "$B")"

echo "  -- Pass restores eligibility too --"
PBE=$(q "SELECT pair_id FROM public.intro_requests WHERE requester_id='$B' AND target_user_id='$E'")
chk "Pass" "passed" "$(q "SELECT public.pass_reciprocal_pair('$PBE','$B')")"
chk "  B is clear again" "0" "$(u "$B")"

echo "  -- concurrency: the gate is transactional, not advisory --"
"${PSQL[@]}" -c "DELETE FROM public.intro_requests; DELETE FROM public.member_pairs; DELETE FROM public.matches;" >/dev/null
G=$(mk g); H1=$(mk h1); H2=$(mk h2)
for x in "$H1" "$H2"; do
  ("$PGBIN/psql" -U postgres -X -q -c "SELECT public.create_reciprocal_suggestion('$x','$G','reciprocal',NULL,30,2,NULL)" >/dev/null 2>&1 || true) &
done; wait
chk "2 concurrent INDEPENDENT placements -> G receives exactly ONE" "1" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$G' AND status='suggested'")"
chk "  and exactly one pair exists" "1" \
  "$(q "SELECT count(*) FROM public.member_pairs WHERE user_a_id='$G' OR user_b_id='$G'")"
for i in 1 2 3 4 5 6; do
  ("$PGBIN/psql" -U postgres -X -q -c "SELECT public.create_reciprocal_suggestion('$(mk z$i)','$G','reciprocal',NULL,30,2,NULL)" >/dev/null 2>&1 || true) &
done; wait
chk "6 more concurrent attempts cannot bypass the gate" "1" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$G' AND status='suggested'")"

echo "  -- a refused placement creates NOTHING else --"
OB=$(q "SELECT count(*) FROM public.introduction_email_outbox")
MT=$(q "SELECT count(*) FROM public.matches"); CV=$(q "SELECT count(*) FROM public.conversations")
K=$(mk k)
chk "refused" "unresolved" "$(crs "$K" "$G")"
chk "  no outbox row" "$OB" "$(q "SELECT count(*) FROM public.introduction_email_outbox")"
chk "  no match" "$MT" "$(q "SELECT count(*) FROM public.matches")"
chk "  no conversation" "$CV" "$(q "SELECT count(*) FROM public.conversations")"
chk "  no credit debited" "0" "$(q "SELECT count(*) FROM public.meeting_credits WHERE user_id IN ('$K','$G')")"
chk "  no card for either member" "0" "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$K'")"

echo "  -- queued promotion is a LATER release --"
"${PSQL[@]}" -c "DELETE FROM public.intro_requests; DELETE FROM public.member_pairs;" >/dev/null
M1=$(mk m1); M2=$(mk m2); M3=$(mk m3)
AB=$(q "INSERT INTO public.recommendation_batches(member_id,batch_source,state) VALUES ('$M1','weekly','active') RETURNING batch_id")
QB=$(q "INSERT INTO public.recommendation_batches(member_id,batch_source,state) VALUES ('$M1','weekly','queued') RETURNING batch_id")
"${PSQL[@]}" -c "INSERT INTO public.intro_requests(requester_id,target_user_id,status,batch_id) VALUES ('$M1','$M2','queued','$QB')" >/dev/null
PZ=$(pair "$M1" "$M3"); CZ=$(card "$M1" "$M3" "$PZ")
chk "promotion refused while an unrelated card is unanswered" "unresolved" \
  "$(q "SELECT public.promote_queued_rows('$M1')->>'reason'")"
chk "  nothing was revealed" "0" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE batch_id='$QB' AND status='suggested'")"
"${PSQL[@]}" -c "INSERT INTO public.intro_requests(requester_id,target_user_id,status,responds_to_id) VALUES ('$M1','$M3','approved','$CZ')" >/dev/null
chk "once answered, promotion proceeds" "true" "$(q "SELECT public.promote_queued_rows('$M1')->>'promoted'")"

echo "  -- batch placement respects the same envelope --"
"${PSQL[@]}" -c "DELETE FROM public.intro_requests; DELETE FROM public.member_pairs; DELETE FROM public.recommendation_batches;" >/dev/null
N1=$(mk n1); N2=$(mk n2); N3=$(mk n3)
PY1=$(pair "$N1" "$N2"); CY=$(card "$N1" "$N2" "$PY1")
chk "place_batch_rows refuses while a card is unanswered" "unresolved" \
  "$(q "SELECT public.place_batch_rows('$N1','weekly','[{\"target_user_id\":\"$N3\"}]'::jsonb,NULL,30)->>'reason'")"
chk "  and placed nothing" "0" "$(q "SELECT count(*) FROM public.intro_requests WHERE target_user_id='$N3'")"

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# 6. THE AUDITS EXECUTE AGAINST A REAL CATALOG (pglast validates syntax, not columns)
# ═══════════════════════════════════════════════════════════════════════════════════════════════
echo "── 6. preflight / post-apply audits execute ──"
POST=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/081_postapply.sql 2>&1 || true)
chk "post-apply runs with no ERROR" "0" "$(printf '%s' "$POST" | grep -cE '(ERROR|FATAL):' || true)"
chk "  every writer is gated" "1" "$(printf '%s' "$POST" | grep -c '"all_writers_gated": true' || true)"
chk "  no accidental overloads" "1" "$(printf '%s' "$POST" | grep -c '"no_accidental_overloads": true' || true)"
chk "  the old 6-arg reciprocal signature is gone" "1" \
  "$(printf '%s' "$POST" | grep -c '"old_reciprocal_signature_gone": true' || true)"
chk "  expire_intro_pair unchanged" "1" "$(printf '%s' "$POST" | grep -c '"unchanged": true' || true)"
for z in releases_spanning_members_DEFECT oversized_releases_DEFECT members_above_visible_cap_DEFECT; do
  chk "  $z is zero" "1" "$(printf '%s' "$POST" | grep -c "\"$z\": 0" || true)"
done

PRE=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/081_preflight.sql 2>&1 || true)
chk "preflight runs with no ERROR" "0" "$(printf '%s' "$PRE" | grep -cE '(ERROR|FATAL):' || true)"
chk "  and now correctly BLOCKS (081 is applied)" "1" \
  "$(printf '%s' "$PRE" | grep -c '"overall_verdict": "BLOCKER"' || true)"
# Three, not four: create_reciprocal_suggestion reports SIGNATURE_ABSENT instead, because 081
# changed its signature and the preflight expects the pre-081 six-argument form.
chk "  rows_with_release_id reports 0 while none are stamped" "1" \
  "$(printf '%s' "$PRE" | grep -c '"rows_with_release_id": 0' || true)"
# EXACTNESS. A count that is always zero would satisfy the check above without reading anything.
# Stamp a known number of rows and require the audit to report that exact number.
EX1=$(mk ex1); EX2=$(mk ex2); EX3=$(mk ex3)
EREL=$(q "SELECT gen_random_uuid()")
EP=$(pair "$EX1" "$EX2")
"${PSQL[@]}" -c "INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id,release_id)
  VALUES ('$EX1','$EX2','suggested','$EP','$EREL'), ('$EX1','$EX3','suggested',NULL,'$EREL')" >/dev/null
PRE3=$("$PGBIN/psql" -U postgres -X -q -f supabase/audits/081_preflight.sql 2>&1 || true)
chk "  and reports EXACTLY 2 once two rows are stamped" "1" \
  "$(printf '%s' "$PRE3" | grep -c '"rows_with_release_id": 2' || true)"
chk "  with no ERROR" "0" "$(printf '%s' "$PRE3" | grep -cE '(ERROR|FATAL):' || true)"
chk "  agreeing with a direct count now that the column exists" "2" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE release_id IS NOT NULL")"
"${PSQL[@]}" -c "DELETE FROM public.intro_requests WHERE release_id='$EREL'" >/dev/null
chk "  naming the reason on the three same-signature writers" "3" \
  "$(printf '%s' "$PRE" | grep -c 'ALREADY_GATED_081_APPLIED' || true)"
chk "  and SIGNATURE_ABSENT on the one whose signature changed" "1" \
  "$(printf '%s' "$PRE" | grep -c 'SIGNATURE_ABSENT' || true)"

echo
[ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "FAILURES PRESENT"; exit 1; }
