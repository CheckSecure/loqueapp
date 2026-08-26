#!/usr/bin/env bash
# Verify migration 085 on a DISPOSABLE PostgreSQL 17 cluster. Touches no production database.
#
# The fixture installs the EXACT post-081 predicate body, extracted verbatim from
# supabase/migrations/081_response_eligibility.sql, so 085's md5 drift guard is exercised for real
# rather than against a hand-copied approximation.
set -uo pipefail

PGBIN=/opt/homebrew/opt/postgresql@17/bin
[ -x "$PGBIN/initdb" ] || { echo "PostgreSQL 17 not found at $PGBIN"; exit 1; }
PORT=55519
DIR="$(mktemp -d)"
PASS=0; FAIL=0
cleanup(){ "$PGBIN/pg_ctl" -D "$DIR/pg" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
ok(){ PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
chk(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — expected [$3] got [$2]"; fi; }
Q(){ "$PGBIN/psql" -U postgres -X -q -A -t -h localhost -p $PORT -d postgres -c "$1" 2>&1; }
RUN(){ "$PGBIN/psql" -U postgres -X -q -h localhost -p $PORT -d postgres -v ON_ERROR_STOP=1 -f "$1" 2>&1; }
SQL(){ "$PGBIN/psql" -U postgres -X -q -h localhost -p $PORT -d postgres -v ON_ERROR_STOP=1 2>&1; }

MIG=supabase/migrations/085_unavailable_target_release.sql

echo "── 0. the migration rewrites no row ──"
# Column 0 only: the writer BODIES legitimately INSERT cards — that is their job. A top-level
# INSERT/DELETE would be a bulk historical rewrite, which this migration must not contain.
DML=$(grep -vE '^\s*--' "$MIG" | grep -cE '^(INSERT|DELETE)' || true)
chk "no top-level INSERT/DELETE in the migration" "$DML" "0"
# Every UPDATE in this file lives INSIDE the neutraliser function body (indented). A top-level one
# — at column 0 — would be a bulk rewrite the migration must not contain.
BF=$(grep -vE '^\s*--' "$MIG" | grep -cE '^(UPDATE|INSERT|DELETE)' || true)
chk "no top-level UPDATE/INSERT/DELETE (no bulk rewrite)" "$BF" "0"

echo "── cluster ──"
"$PGBIN/initdb" -D "$DIR/pg" -U postgres --auth=trust --no-sync >/dev/null 2>&1 || { echo initdb failed; exit 1; }
"$PGBIN/pg_ctl" -D "$DIR/pg" -o "-p $PORT -c listen_addresses=localhost -c fsync=off" -l "$DIR/log" -w start >/dev/null 2>&1 \
  || { echo "start failed"; cat "$DIR/log"; exit 1; }
echo "  PostgreSQL $(Q 'SHOW server_version;') on port $PORT"

# Extract the post-081 predicate definition VERBATIM so the md5 guard is tested honestly.
python3 - "$DIR/pred.sql" <<'PY'
import sys
s=open('supabase/migrations/081_response_eligibility.sql').read()
i=s.index('CREATE OR REPLACE FUNCTION public.count_unresolved_introductions')
j=s.index('$fn$;', s.index('AS $fn$', i))+len('$fn$;')
open(sys.argv[1],'w').write(s[i:j]+'\n')
PY

fixture(){
"$PGBIN/psql" -U postgres -X -q -h localhost -p $PORT -d postgres -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'EOSQL'
DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text,
  account_status text DEFAULT 'active', profile_complete boolean DEFAULT true,
  is_test_account boolean DEFAULT false, matching_paused boolean DEFAULT false,
  is_admin boolean DEFAULT false);
CREATE TABLE public.member_pairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_a_id uuid, user_b_id uuid,
  status text DEFAULT 'active', source text, last_recommended_at timestamptz, recommend_count integer DEFAULT 0,
  first_recommended_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (user_a_id, user_b_id));
CREATE TABLE public.intro_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid, target_user_id uuid, status text, resolution_reason text,
  batch_id uuid, release_id uuid, responds_to_id uuid, pair_id uuid, capacity_released_at timestamptz,
  is_admin_initiated boolean DEFAULT false, match_reason text, source text, expired_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
ALTER TABLE public.intro_requests ADD CONSTRAINT intro_requests_resolution_reason_check
  CHECK (resolution_reason IS NULL OR resolution_reason IN ('not_for_me','never_show','already_know'));
CREATE TABLE public.matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_a_id uuid, user_b_id uuid);
CREATE TABLE public.blocked_users (user_id uuid, blocked_user_id uuid);
-- The rest of the placement schema the REAL writer bodies reference. Without these, 085 cannot
-- install its section 7 at all, so the fixture would silently test nothing.
CREATE TABLE public.recommendation_batches (
  batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid, state text,
  batch_source text, reciprocal_batch_id uuid, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now());
CREATE TABLE public.batch_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid, recipient_id uuid,
  suggested_id uuid, status text, reason text, match_score numeric, materialized_at timestamptz);
-- Tables the cleanup artifact proves did NOT change.
CREATE TABLE public.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), match_id uuid);
CREATE TABLE public.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), is_system boolean DEFAULT false);
CREATE TABLE public.notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, type text);
CREATE TABLE public.meeting_credits (user_id uuid PRIMARY KEY, balance integer DEFAULT 0);
CREATE TABLE public.introduction_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, created_at timestamptz DEFAULT now());
EOSQL
"$PGBIN/psql" -U postgres -X -q -h localhost -p $PORT -d postgres -v ON_ERROR_STOP=1 -f "$DIR/pred.sql" >/dev/null 2>&1
# Stand-in writers: the guard checks EXACT signature, exactly one instance, and that the body calls
# the predicate. Their bodies do nothing else — 085 does not replace them.
"$PGBIN/psql" -U postgres -X -q -h localhost -p $PORT -d postgres -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'EOSQL'
-- Stand-in shaped like the REAL writer: canonical lock, then the capacity count that migration 081
-- deploys verbatim, then the unresolved gate. 085 replaces this with the real reconciled body.
CREATE FUNCTION public.create_reciprocal_suggestion(a_id uuid, b_id uuid, p_source text DEFAULT 'reciprocal', p_reason text DEFAULT NULL, p_cooldown_days integer DEFAULT 30, p_max_cards integer DEFAULT 2, p_release_id uuid DEFAULT NULL)
  RETURNS text LANGUAGE plpgsql AS $$
  DECLARE a_cards integer; b_cards integer; lo uuid; hi uuid; BEGIN
    lo := LEAST(a_id,b_id); hi := GREATEST(a_id,b_id);
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));
    SELECT count(*) INTO a_cards FROM public.intro_requests ir
      WHERE ir.requester_id = a_id AND ir.status = 'suggested' AND ir.capacity_released_at IS NULL;
    SELECT count(*) INTO b_cards FROM public.intro_requests ir
      WHERE ir.requester_id = b_id AND ir.status = 'suggested' AND ir.capacity_released_at IS NULL;
    -- (stand-in only: 085 replaces this whole body with the real, usable-capacity one)
    IF a_cards >= p_max_cards OR b_cards >= p_max_cards THEN RETURN 'capacity'; END IF;
    IF public.count_unresolved_introductions(a_id, NULL, NULL) > 0 THEN RETURN 'unresolved'; END IF;
    IF public.count_unresolved_introductions(b_id, NULL, NULL) > 0 THEN RETURN 'unresolved'; END IF;
    RETURN 'ok'; END $$;
CREATE FUNCTION public.place_batch_rows(p_member_id uuid, p_source text, p_rows jsonb, p_reciprocal_batch_id uuid, p_cooldown_days integer)
  RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
    IF public.count_unresolved_introductions(p_member_id, NULL, NULL) > 0 THEN RETURN '{}'::jsonb; END IF; RETURN '{}'::jsonb; END $$;
CREATE FUNCTION public.promote_queued_rows(p_member_id uuid)
  RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
    IF public.count_unresolved_introductions(p_member_id, NULL, NULL) > 0 THEN RETURN '{}'::jsonb; END IF; RETURN '{}'::jsonb; END $$;
CREATE FUNCTION public.materialize_admin_pair(p_review_batch_id uuid, p_member_a uuid, p_member_b uuid, p_batch_a uuid, p_batch_b uuid, p_cooldown_days integer)
  RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
    IF public.count_unresolved_introductions(p_member_a, NULL, NULL) > 0 THEN RETURN '{}'::jsonb; END IF; RETURN '{}'::jsonb; END $$;
EOSQL
}

seed(){
"$PGBIN/psql" -U postgres -X -q -h localhost -p $PORT -d postgres -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'EOSQL'
DELETE FROM public.intro_requests; DELETE FROM public.blocked_users; DELETE FROM public.matches;
DELETE FROM public.member_pairs; DELETE FROM public.recommendation_batches;
DELETE FROM public.batch_suggestions; DELETE FROM public.profiles;
INSERT INTO public.profiles (id,email,full_name,account_status,profile_complete,is_test_account,matching_paused) VALUES
 ('00000000-0000-0000-0000-0000000000f1','m@x.test','Member','active',true,false,false),
 ('00000000-0000-0000-0000-0000000000a1','ok@x.test','Available','active',true,false,false),
 ('00000000-0000-0000-0000-0000000000d1','de@x.test','Deactivated','deactivated',true,false,false),
 ('00000000-0000-0000-0000-0000000000c1','ic@x.test','Incomplete','active',false,false,false),
 ('00000000-0000-0000-0000-0000000000e1','ts@x.test','TestAcct','active',true,true,false),
 ('00000000-0000-0000-0000-0000000000d2','pa@x.test','Paused','active',true,false,true),
 ('00000000-0000-0000-0000-0000000000b1','bl@x.test','Blocker','active',true,false,false),
 ('00000000-0000-0000-0000-0000000000b2','b2@x.test','Blocked','active',true,false,false);
EOSQL
}
card(){ Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status) VALUES ('$1','00000000-0000-0000-0000-0000000000f1','$2','suggested');" >/dev/null; }
UNRES(){ Q "SELECT public.count_unresolved_introductions('00000000-0000-0000-0000-0000000000f1',NULL,NULL);"; }

echo "── 1. preflight on the post-081 fixture ──"
fixture; seed
PRE=$(RUN supabase/audits/085_preflight.sql)
echo "$PRE" | grep -q '"overall_verdict": "READY"' && ok "preflight says READY" || bad "preflight: $(echo "$PRE" | grep overall_verdict)"
echo "$PRE" | grep -q '"body_md5": "c834301b7374934c88e27e1005959f0a"' && ok "preflight reports the pinned post-081 md5" || bad "md5 mismatch: $(echo "$PRE" | grep body_md5)"

echo "── 2. BEFORE 085 — every unavailable target STRANDS the member ──"
for pair in "10000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000d1 deactivated" \
            "10000000-0000-0000-0000-000000000002 00000000-0000-0000-0000-0000000000c1 incomplete" \
            "10000000-0000-0000-0000-000000000003 00000000-0000-0000-0000-0000000000e1 test-account" \
            "10000000-0000-0000-0000-000000000004 00000000-0000-0000-0000-0000000000d2 paused"; do
  set -- $pair; seed; card "$1" "$2"
  N=$(UNRES)
  if [ "$3" = "deactivated" ]; then chk "  $3 already excluded by 081" "$N" "0"
  else chk "  $3 STRANDS the member before 085" "$N" "1"; fi
done
seed; card 10000000-0000-0000-0000-000000000005 00000000-0000-0000-0000-0000000000b2
Q "INSERT INTO public.blocked_users VALUES ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000f1');" >/dev/null
chk "  blocked-by-target STRANDS the member before 085" "$(UNRES)" "1"

echo "── 3. apply 085 ──"
OUT=$(RUN "$MIG")
echo "$OUT" | grep -q '085 OK' && ok "applied: $(echo "$OUT" | grep -o '085 OK.*')" || bad "apply failed: $OUT"

echo "── 4. AFTER 085 — nothing unanswerable counts ──"
for pair in "00000000-0000-0000-0000-0000000000d1 deactivated" "00000000-0000-0000-0000-0000000000c1 incomplete" \
            "00000000-0000-0000-0000-0000000000e1 test-account" "00000000-0000-0000-0000-0000000000d2 paused"; do
  set -- $pair; seed; card 20000000-0000-0000-0000-000000000001 "$1"
  chk "  $2 no longer counts" "$(UNRES)" "0"
done
seed; card 20000000-0000-0000-0000-000000000002 00000000-0000-0000-0000-0000000000b2
Q "INSERT INTO public.blocked_users VALUES ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000f1');" >/dev/null
chk "  blocked BY the target no longer counts" "$(UNRES)" "0"
seed; card 20000000-0000-0000-0000-000000000003 00000000-0000-0000-0000-0000000000b2
Q "INSERT INTO public.blocked_users VALUES ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000b2');" >/dev/null
chk "  blocked BY the member no longer counts" "$(UNRES)" "0"
seed; Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status) VALUES ('20000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-00000000ffff','suggested');" >/dev/null
chk "  MISSING target row does not count" "$(UNRES)" "0"

echo "── 5. an AVAILABLE target still counts — the gate is not disarmed ──"
seed; card 20000000-0000-0000-0000-000000000005 00000000-0000-0000-0000-0000000000a1
chk "  available target still blocks (081 gate intact)" "$(UNRES)" "1"

echo "── 5b. CAPACITY RECOVERY — the whole point of the second blocker ──"
# THE VISIBLE-CAPACITY AUTHORITY, verbatim from the writers.
VIS(){ Q "SELECT count(*) FROM public.intro_requests WHERE requester_id='00000000-0000-0000-0000-0000000000f1' AND status='suggested' AND capacity_released_at IS NULL;"; }

# (a) two unavailable cards fill both slots -> the member looks FULL and gets nothing.
seed
card 21000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000d2
card 21000000-0000-0000-0000-000000000002 00000000-0000-0000-0000-0000000000c1
chk "  (a) before reconciliation the member occupies 2/2 visible slots" "$(VIS)" "2"
chk "  (a) and the strict gate already ignores them (085 predicate)" "$(UNRES)" "0"
# ...which is EXACTLY the reported bug: caught-up by the gate, starved by capacity.
chk "  (a) but USABLE capacity is 0/2" "$(Q "SELECT public.count_usable_visible_cards('00000000-0000-0000-0000-0000000000f1');")" "0"
R=$(Q "SELECT public.create_reciprocal_suggestion('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000a1');")
chk "  (a) the WRITER allocates immediately, without waiting for maintenance" "$R" "created"
chk "  (a) and it MUTATED NOTHING — the stale rows are untouched" "$(Q "SELECT count(*) FROM public.intro_requests WHERE id IN ('21000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000002') AND status='suggested';")" "2"
chk "  (a) RAW rows may exceed the cap; USABLE never does" "$(Q "SELECT (SELECT count(*) FROM public.intro_requests WHERE requester_id='00000000-0000-0000-0000-0000000000f1' AND status='suggested')::text || '/' || public.count_usable_visible_cards('00000000-0000-0000-0000-0000000000f1')::text;")" "3/1"

# (b) ONE unavailable card must not reduce a two-card weekly allocation.
seed
card 22000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000d2
chk "  (b) before: only 1 of 2 slots free" "$(( 2 - $(VIS) ))" "1"
chk "  (b) usable capacity is already 0 — no maintenance needed" "$(Q "SELECT public.count_usable_visible_cards('00000000-0000-0000-0000-0000000000f1');")" "0"
chk "  (b) so the full 2-card allocation is available immediately" "$(( 2 - $(Q "SELECT public.count_usable_visible_cards('00000000-0000-0000-0000-0000000000f1');") ))" "2"
chk "  (b) and nothing was fabricated as a member Pass" "$(Q "SELECT count(*) FROM public.intro_requests WHERE status='passed' OR resolution_reason IN ('not_for_me','never_show','already_know');")" "0"

# (c) an AVAILABLE card still occupies its slot — reconciliation is not a capacity giveaway.
seed
card 23000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000a1
chk "  (c) an available card keeps its slot" "$(Q "SELECT public.count_usable_visible_cards('00000000-0000-0000-0000-0000000000f1');")" "1"
chk "  (c) and still blocks the strict gate" "$(UNRES)" "1"

# (d) NO CAP BREACH: reconciliation can only free slots, never create them.
seed
card 24000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000a1
card 24000000-0000-0000-0000-000000000002 00000000-0000-0000-0000-0000000000b1
chk "  (d) two available cards still fill the cap" "$(Q "SELECT public.count_usable_visible_cards('00000000-0000-0000-0000-0000000000f1');")" "2"
R=$(Q "SELECT public.create_reciprocal_suggestion('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000b2');")
chk "  (d) the writer refuses — no cap breach" "$R" "capacity"

echo "── 6. the neutraliser ──"
seed; card 30000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000d2
R=$(Q "SELECT public.neutralize_unavailable_pair('30000000-0000-0000-0000-000000000001')::text;")
echo "$R" | grep -q '"outcome": "released"' && ok "releases an unavailable card" || bad "release outcome: $R"
chk "  status is the NEUTRAL 'expired'" "$(Q "SELECT status FROM public.intro_requests WHERE id='30000000-0000-0000-0000-000000000001';")" "expired"
chk "  reason is the SYSTEM reason"     "$(Q "SELECT resolution_reason FROM public.intro_requests WHERE id='30000000-0000-0000-0000-000000000001';")" "system_pair_unavailable"
chk "  it is NOT 'passed'"              "$(Q "SELECT count(*) FROM public.intro_requests WHERE status='passed';")" "0"
chk "  no member-authored reason written" "$(Q "SELECT count(*) FROM public.intro_requests WHERE resolution_reason IN ('not_for_me','never_show','already_know');")" "0"
chk "  no match created"                "$(Q 'SELECT count(*) FROM public.matches;')" "0"

seed; card 30000000-0000-0000-0000-000000000002 00000000-0000-0000-0000-0000000000a1
R=$(Q "SELECT public.neutralize_unavailable_pair('30000000-0000-0000-0000-000000000002')::text;")
echo "$R" | grep -q 'target_available' && ok "REFUSES an available target" || bad "should refuse: $R"
chk "  the card is untouched" "$(Q "SELECT status FROM public.intro_requests WHERE id='30000000-0000-0000-0000-000000000002';")" "suggested"

seed; card 30000000-0000-0000-0000-000000000003 00000000-0000-0000-0000-0000000000d2
Q "UPDATE public.intro_requests SET status='passed' WHERE id='30000000-0000-0000-0000-000000000003';" >/dev/null
R=$(Q "SELECT public.neutralize_unavailable_pair('30000000-0000-0000-0000-000000000003')::text;")
echo "$R" | grep -q 'not_actionable' && ok "REFUSES a card that is no longer suggested" || bad "should refuse: $R"
R=$(Q "SELECT public.neutralize_unavailable_pair(NULL)::text;")
echo "$R" | grep -q 'not_found' && ok "NULL card id is not_found, not an error" || bad "null: $R"

echo "── 7. reciprocal pair consistency ──"
seed
PID=$(Q "INSERT INTO public.member_pairs (status) VALUES ('active') RETURNING id;")
Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status,pair_id) VALUES
   ('40000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','suggested','$PID'),
   ('40000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000f1','suggested','$PID');" >/dev/null
R=$(Q "SELECT public.neutralize_unavailable_pair('40000000-0000-0000-0000-000000000001')::text;")
echo "$R" | grep -q 'both_sides_closed' && ok "closes BOTH directions together" || bad "pair: $R"
chk "  both rows expired"     "$(Q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$PID' AND status='expired';")" "2"
chk "  no half-closed pair"   "$(Q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$PID' AND status='suggested';")" "0"
chk "  member_pairs expired"  "$(Q "SELECT status FROM public.member_pairs WHERE id='$PID';")" "expired"

echo "── 8. an authored decision is NEVER rewritten ──"
seed
PID=$(Q "INSERT INTO public.member_pairs (user_a_id,user_b_id,status) VALUES ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','active') RETURNING id;")
Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status,pair_id) VALUES
   ('50000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','suggested','$PID'),
   ('50000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000f1','approved','$PID');" >/dev/null
R=$(Q "SELECT public.neutralize_unavailable_pair('50000000-0000-0000-0000-000000000001')::text;")
echo "$R" | grep -q 'counterpart_authored' && ok "the authored counterpart is reported, not rewritten" || bad "authored: $R"
chk "  the AUTHORED in-place Interest is preserved byte-for-byte" "$(Q "SELECT status||'/'||COALESCE(resolution_reason,'-') FROM public.intro_requests WHERE id='50000000-0000-0000-0000-000000000002';")" "approved/-"
chk "  only the unanswered card was neutralised" "$(Q "SELECT status||'/'||COALESCE(resolution_reason,'-') FROM public.intro_requests WHERE id='50000000-0000-0000-0000-000000000001';")" "expired/system_pair_unavailable"
chk "  member_pairs is truthfully expired" "$(Q "SELECT status FROM public.member_pairs WHERE id='$PID';")" "expired"
if grep -qF "v_pair.status IN ('expired','blocked')" supabase/migrations/067_finalize_mutual_match_atomic.sql; then
  ok "  finalize_mutual_match already refuses an expired pair (067, unmodified)"
else bad "  067 does not refuse an expired pair"; fi

echo "── 8b. a CORRELATED response row is immutable evidence ──"
seed
PID=$(Q "INSERT INTO public.member_pairs (user_a_id,user_b_id,status) VALUES ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','active') RETURNING id;")
Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status,pair_id) VALUES
   ('51000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','suggested','$PID'),
   ('51000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000f1','suggested','$PID');" >/dev/null
# both members answered via CORRELATED rows — the cards stay 'suggested' (migration 080)
Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status,responds_to_id) VALUES
   ('51000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','pending','51000000-0000-0000-0000-000000000001'),
   ('51000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000f1','pending','51000000-0000-0000-0000-000000000002');" >/dev/null
R=$(Q "SELECT public.neutralize_unavailable_pair('51000000-0000-0000-0000-000000000001')::text;")
echo "$R" | grep -q '"mutual_interest_preserved": true' && ok "MUTUAL interest on an unavailable pair is detected via correlated rows" || bad "mutual detect: $R"
echo "$R" | grep -q '"outcome": "released"' && ok "  and the pair is closed neutrally, not refused" || bad "mutual close: $R"
chk "  BOTH correlated response rows survive untouched" "$(Q "SELECT count(*) FROM public.intro_requests WHERE responds_to_id IS NOT NULL AND status='pending' AND resolution_reason IS NULL;")" "2"
chk "  neither response row was expired" "$(Q "SELECT count(*) FROM public.intro_requests WHERE responds_to_id IS NOT NULL AND status='expired';")" "0"
chk "  only the two placement cards were neutralised" "$(Q "SELECT count(*) FROM public.intro_requests WHERE responds_to_id IS NULL AND status='expired' AND resolution_reason='system_pair_unavailable';")" "2"
chk "  NO match was created for the mutually-interested pair" "$(Q 'SELECT count(*) FROM public.matches;')" "0"
chk "  and the pair is expired, so finalization can never revive it" "$(Q "SELECT status FROM public.member_pairs WHERE id='$PID';")" "expired"

echo "── 8c. a correlated response row can never be selected as a counterpart ──"
seed
PID=$(Q "INSERT INTO public.member_pairs (user_a_id,user_b_id,status) VALUES ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','active') RETURNING id;")
# a malicious/legacy correlated row that DOES carry the pair_id and the reversed direction
Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status,pair_id) VALUES
   ('52000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','suggested','$PID');" >/dev/null
Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status,pair_id,responds_to_id) VALUES
   ('52000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000f1','pending','$PID','52000000-0000-0000-0000-000000000001');" >/dev/null
R=$(Q "SELECT public.neutralize_unavailable_pair('52000000-0000-0000-0000-000000000001')::text;")
echo "$R" | grep -q 'counterpart_row_missing' && ok "a correlated row carrying pair_id is NOT treated as the counterpart" || bad "8c: $R"
chk "  and it was not rewritten" "$(Q "SELECT status FROM public.intro_requests WHERE id='52000000-0000-0000-0000-000000000002';")" "pending"

echo "── 8d. a malformed pair is refused, unchanged ──"
seed
PID=$(Q "INSERT INTO public.member_pairs (user_a_id,user_b_id,status) VALUES ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','active') RETURNING id;")
Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status,pair_id) VALUES
   ('53000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','suggested','$PID'),
   ('53000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000f1','suggested','$PID'),
   ('53000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000f1','suggested','$PID');" >/dev/null
R=$(Q "SELECT public.neutralize_unavailable_pair('53000000-0000-0000-0000-000000000001')::text;")
echo "$R" | grep -q '"outcome": "malformed"' && ok "two reversed placement cards -> malformed" || bad "8d: $R"
chk "  every row is left exactly as it was" "$(Q "SELECT count(*) FROM public.intro_requests WHERE status='suggested';")" "3"

echo "── 8e. a response row is never neutralised directly ──"
seed
Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status,responds_to_id) VALUES
   ('54000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','pending','54000000-0000-0000-0000-0000000000ff');" >/dev/null
R=$(Q "SELECT public.neutralize_unavailable_pair('54000000-0000-0000-0000-000000000001')::text;")
echo "$R" | grep -q 'not_a_placement_card' && ok "a correlated row passed in directly is refused" || bad "8e: $R"
chk "  and is unchanged" "$(Q "SELECT status FROM public.intro_requests WHERE id='54000000-0000-0000-0000-000000000001';")" "pending"

echo "── 9. it never pre-empts a real outcome ──"
seed
PID=$(Q "INSERT INTO public.member_pairs (status) VALUES ('active') RETURNING id;")
Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status,pair_id) VALUES
   ('60000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','approved','$PID'),
   ('60000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000f1','approved','$PID');" >/dev/null
Q "UPDATE public.intro_requests SET status='suggested' WHERE id='60000000-0000-0000-0000-000000000001';" >/dev/null
Q "UPDATE public.intro_requests SET status='approved' WHERE id='60000000-0000-0000-0000-000000000001';" >/dev/null
R=$(Q "SELECT public.neutralize_unavailable_pair('60000000-0000-0000-0000-000000000001')::text;")
echo "$R" | grep -q 'not_actionable' && ok "a non-suggested card is refused before anything else" || bad "mutual: $R"
seed; card 60000000-0000-0000-0000-000000000003 00000000-0000-0000-0000-0000000000d2
Q "INSERT INTO public.matches (user_a_id,user_b_id) VALUES ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2');" >/dev/null
R=$(Q "SELECT public.neutralize_unavailable_pair('60000000-0000-0000-0000-000000000003')::text;")
echo "$R" | grep -q '"outcome": "matched"' && ok "REFUSES when a match already exists" || bad "matched: $R"

echo "── 10. post-apply audit ──"
seed
POST=$(RUN supabase/audits/085_postapply.sql)
echo "$POST" | grep -q '"overall_verdict": "PASS"' && ok "post-apply says PASS" || bad "post-apply: $(echo "$POST" | grep -A2 overall_verdict)"
echo "$POST" | grep -q '"members_still_stranded_by_an_unanswerable_card": 0' && ok "reports 0 stranded members" || bad "stranded != 0"

echo "── 11. census reconciles and names each card once ──"
seed
card 70000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000a1
card 70000000-0000-0000-0000-000000000002 00000000-0000-0000-0000-0000000000c1
card 70000000-0000-0000-0000-000000000003 00000000-0000-0000-0000-0000000000e1
card 70000000-0000-0000-0000-000000000004 00000000-0000-0000-0000-0000000000b2
Q "INSERT INTO public.blocked_users VALUES ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000b2');" >/dev/null
CEN=$(RUN supabase/audits/unavailable_target_census.sql)
echo "$CEN" | grep -q '"reconciles": true' && ok "census reconciles" || bad "census does not reconcile"
echo "$CEN" | grep -q '"suggested_total": 4' && ok "census total is 4" || bad "census total wrong"
echo "$CEN" | grep -q '"otherwise_actionable": 1' && ok "1 genuinely actionable" || bad "actionable count wrong"
echo "$CEN" | grep -q '"unavailable_total": 3' && ok "3 unavailable" || bad "unavailable count wrong"
# a card that is BOTH incomplete and blocked is counted ONCE (the 6-vs-7 class of defect)
seed; card 70000000-0000-0000-0000-000000000005 00000000-0000-0000-0000-0000000000c1
Q "INSERT INTO public.blocked_users VALUES ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000c1');" >/dev/null
CEN=$(RUN supabase/audits/unavailable_target_census.sql)
echo "$CEN" | grep -q '"suggested_total": 1' && echo "$CEN" | grep -q '"unavailable_total": 1' \
  && ok "a doubly-unavailable card is counted ONCE" || bad "double-count: $(echo "$CEN" | grep -E 'total')"

echo "── 12. cleanup artifact: gate false keeps nothing ──"
seed
card 80000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000d2
card 80000000-0000-0000-0000-000000000002 00000000-0000-0000-0000-0000000000a1
GATE=$(grep -cE '^  v_apply constant boolean := false;$' supabase/repairs/unavailable_cards_release.PROPOSED.sql)
chk "the checked-in gate is false" "$GATE" "1"
OUT=$(RUN supabase/repairs/unavailable_cards_release.PROPOSED.sql 2>&1 || true)
echo "$OUT" | grep -q 'DRY RUN COMPLETE' && ok "dry run reports and rolls back" || bad "dry run: $(echo "$OUT" | tail -2)"
echo "$OUT" | grep -q 'visible slot(s) would be recovered' && ok "dry run reports capacity it WOULD recover" || bad "dry run capacity line missing"
chk "  nothing was neutralised"  "$(Q "SELECT count(*) FROM public.intro_requests WHERE resolution_reason='system_pair_unavailable';")" "0"
chk "  both cards still suggested" "$(Q "SELECT count(*) FROM public.intro_requests WHERE status='suggested';")" "2"
# apply path, via a copy differing by exactly one line
sed 's/^  v_apply constant boolean := false;$/  v_apply constant boolean := true;/' \
  supabase/repairs/unavailable_cards_release.PROPOSED.sql > "$DIR/apply.sql"
chk "  the apply copy differs by exactly one line" "$(diff supabase/repairs/unavailable_cards_release.PROPOSED.sql "$DIR/apply.sql" | grep -c '^[<>]')" "2"
OUT=$(RUN "$DIR/apply.sql" 2>&1 || true)
echo "$OUT" | grep -q 'CLEANUP APPLIED' && ok "apply copy neutralises" || bad "apply: $(echo "$OUT" | tail -2)"
chk "  the unavailable card is neutralised" "$(Q "SELECT status||'/'||COALESCE(resolution_reason,'-') FROM public.intro_requests WHERE id='80000000-0000-0000-0000-000000000001';")" "expired/system_pair_unavailable"
chk "  the AVAILABLE card is untouched"     "$(Q "SELECT status FROM public.intro_requests WHERE id='80000000-0000-0000-0000-000000000002';")" "suggested"
chk "  no member reason manufactured"       "$(Q "SELECT count(*) FROM public.intro_requests WHERE resolution_reason IN ('not_for_me','never_show','already_know');")" "0"
chk "  no match/conversation/message/notification/credit side effect" \
  "$(Q "SELECT (SELECT count(*) FROM public.matches)+(SELECT count(*) FROM public.conversations)+(SELECT count(*) FROM public.messages)+(SELECT count(*) FROM public.notifications)+(SELECT count(*) FROM public.meeting_credits);")" "0"
echo "$OUT" | grep -q 'visible slot(s) recovered' && ok "  reports the capacity it recovered" || bad "no capacity line: $(echo "$OUT" | tail -2)"
chk "  the freed slot really is free" "$(Q "SELECT count(*) FROM public.intro_requests WHERE requester_id='00000000-0000-0000-0000-0000000000f1' AND status='suggested' AND capacity_released_at IS NULL;")" "1"

echo "── 13. NEGATIVE: 085 refuses a drifted or unprepared environment ──"
fixture; seed
Q "CREATE OR REPLACE FUNCTION public.count_unresolved_introductions(p_member_id uuid, p_exclude_release uuid DEFAULT NULL, p_exclude_batch uuid DEFAULT NULL) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS \$x\$ SELECT 0; \$x\$;" >/dev/null
OUT=$(RUN "$MIG" || true)
echo "$OUT" | grep -q 'DRIFT GUARD 085' && ok "refuses a drifted predicate body" || bad "did not refuse drift"
PRE=$(RUN supabase/audits/085_preflight.sql)
echo "$PRE" | grep -q 'BLOCKER' && ok "preflight independently reports BLOCKER" || bad "preflight missed drift"

fixture; seed
Q "DROP FUNCTION public.promote_queued_rows(uuid);" >/dev/null
OUT=$(RUN "$MIG" || true)
echo "$OUT" | grep -q 'DRIFT GUARD 085' && ok "refuses when a writer is absent" || bad "did not refuse a missing writer"

fixture; seed
Q "CREATE OR REPLACE FUNCTION public.promote_queued_rows(p_member_id uuid) RETURNS jsonb LANGUAGE sql AS \$x\$ SELECT '{}'::jsonb \$x\$;" >/dev/null
OUT=$(RUN "$MIG" || true)
echo "$OUT" | grep -q 'does not call count_unresolved_introductions' && ok "refuses when a writer stopped calling the predicate" || bad "did not refuse an ungated writer"

fixture; seed
Q "DROP TABLE public.blocked_users;" >/dev/null
OUT=$(RUN "$MIG" || true)
echo "$OUT" | grep -q 'DRIFT GUARD 085' && ok "refuses when blocked_users is absent" || bad "did not refuse a missing table"

echo "── 14. idempotent / already-applied ──"
fixture; seed
RUN "$MIG" >/dev/null 2>&1
OUT=$(RUN "$MIG" || true)
echo "$OUT" | grep -q 'appears to be applied already' && ok "refuses a second application" || bad "second apply: $(echo "$OUT" | tail -2)"
PRE=$(RUN supabase/audits/085_preflight.sql)
echo "$PRE" | grep -q '"overall_verdict": "ALREADY_APPLIED"' && ok "preflight says ALREADY_APPLIED" || bad "preflight after apply"

echo "── 15. THE MAINTENANCE SWEEP ──"
seed
card 90000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000d2
card 90000000-0000-0000-0000-000000000002 00000000-0000-0000-0000-0000000000c1
card 90000000-0000-0000-0000-000000000003 00000000-0000-0000-0000-0000000000a1
SW=$(Q "SELECT public.sweep_unavailable_introductions(100)::text;")
echo "$SW" | grep -q '"released": 2' && ok "sweep releases exactly the 2 unavailable cards" || bad "sweep: $SW"
chk "  the available card is untouched" "$(Q "SELECT status FROM public.intro_requests WHERE id='90000000-0000-0000-0000-000000000003';")" "suggested"
chk "  every closed row carries system_pair_unavailable" "$(Q "SELECT count(*) FROM public.intro_requests WHERE status='expired' AND resolution_reason IS DISTINCT FROM 'system_pair_unavailable';")" "0"
# IDEMPOTENT: a second run finds nothing left
SW2=$(Q "SELECT public.sweep_unavailable_introductions(100)::text;")
echo "$SW2" | grep -q '"released": 0' && ok "a repeat sweep releases nothing (idempotent)" || bad "repeat sweep: $SW2"
echo "$SW2" | grep -q '"processed": 0' && ok "and processes nothing" || bad "repeat processed: $SW2"

# BOUNDED / BATCHED
seed
for i in 1 2 3 4 5; do card "9100000$i-0000-0000-0000-000000000001" 00000000-0000-0000-0000-0000000000d2; done
SW=$(Q "SELECT public.sweep_unavailable_introductions(2)::text;")
echo "$SW" | grep -q '"processed": 2' && ok "sweep honours its limit (2)" || bad "limit: $SW"
echo "$SW" | grep -q '"truncated": true' && ok "and reports truncation" || bad "truncated: $SW"
chk "  3 unavailable cards remain for the next run" "$(Q "SELECT count(*) FROM public.intro_requests WHERE status='suggested';")" "3"
SW=$(Q "SELECT public.sweep_unavailable_introductions(500)::text;")
chk "  a following run clears the rest" "$(Q "SELECT count(*) FROM public.intro_requests WHERE status='suggested';")" "0"
SWB=$(Q "SELECT (public.sweep_unavailable_introductions(99999)->>'limit') ;")
chk "  an absurd limit is clamped" "$SWB" "500"
SWB=$(Q "SELECT (public.sweep_unavailable_introductions(-5)->>'limit');")
chk "  a negative limit is clamped" "$SWB" "1"

echo "── 16. the sweep reports aggregates and no member data ──"
seed; card 92000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000d2
SW=$(Q "SELECT public.sweep_unavailable_introductions(10)::text;")
for k in processed released skipped failed limit truncated outcomes; do
  echo "$SW" | grep -q "\"$k\"" && ok "  reports $k" || bad "missing $k"
done
echo "$SW" | grep -qiE "0000-0000-0000|@|full_name|email" && bad "sweep leaked an identifier" || ok "  no identifier in the sweep result"

echo "── 17. CONCURRENCY ──"
# (a) maintenance vs weekly placement: the sweep holds the canonical member locks, so a concurrent
#     writer serialises behind it rather than double-counting the slot it is freeing.
seed
card 93000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000d2
card 93000000-0000-0000-0000-000000000002 00000000-0000-0000-0000-0000000000c1
"$PGBIN/psql" -U postgres -X -q -h localhost -p $PORT -d postgres >/dev/null 2>&1 <<'EOSQL' &
BEGIN;
SELECT public.sweep_unavailable_introductions(100);
SELECT pg_sleep(0.6);
COMMIT;
EOSQL
sleep 0.15
R=$(Q "SELECT public.create_reciprocal_suggestion('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000a1');")
wait
chk "  (a) concurrent placement still lands exactly once" "$R" "created"
chk "  (a) and the member holds no more than the cap" "$(Q "SELECT count(*) FROM public.intro_requests WHERE requester_id='00000000-0000-0000-0000-0000000000f1' AND status='suggested' AND capacity_released_at IS NULL;")" "1"
chk "  (a) no duplicate placement" "$(Q "SELECT count(*) FROM public.intro_requests WHERE requester_id='00000000-0000-0000-0000-0000000000f1' AND target_user_id='00000000-0000-0000-0000-0000000000a1';")" "1"

# (b) member responds while maintenance runs: the answered card must NOT be neutralised.
seed
card 94000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000d2
Q "UPDATE public.intro_requests SET status='approved' WHERE id='94000000-0000-0000-0000-000000000001';" >/dev/null
SW=$(Q "SELECT public.sweep_unavailable_introductions(100)::text;")
chk "  (b) an answered card is not touched by the sweep" "$(Q "SELECT status FROM public.intro_requests WHERE id='94000000-0000-0000-0000-000000000001';")" "approved"
echo "$SW" | grep -q '"released": 0' && ok "  (b) and the sweep reports nothing released" || bad "(b): $SW"

# (c) target becomes unavailable AFTER candidate selection: the writer reconciles at placement time.
seed
card 95000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000a1
card 95000000-0000-0000-0000-000000000002 00000000-0000-0000-0000-0000000000b1
chk "  (c) member is at cap with two valid cards" "$(VIS)" "2"
Q "UPDATE public.profiles SET matching_paused=true WHERE id='00000000-0000-0000-0000-0000000000b1';" >/dev/null
R=$(Q "SELECT public.create_reciprocal_suggestion('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000b2');")
chk "  (c) placement is refused — the OTHER card is still unanswered" "$R" "unresolved"
chk "  (c) the newly-unavailable card is NOT rewritten by the writer" "$(Q "SELECT status FROM public.intro_requests WHERE id='95000000-0000-0000-0000-000000000002';")" "suggested"
chk "  (c) but it stops costing a slot immediately, with no cron" "$(Q "SELECT public.count_usable_visible_cards('00000000-0000-0000-0000-0000000000f1');")" "1"

echo "── 18. remaining lifecycle cases ──"
# legacy one-sided row (no pair_id)
seed; card 96000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000c1
R=$(Q "SELECT public.neutralize_unavailable_pair('96000000-0000-0000-0000-000000000001')::text;")
echo "$R" | grep -q 'not_a_pair' && ok "legacy one-sided row closes with no counterpart invented" || bad "legacy: $R"
chk "  and nothing else was created" "$(Q 'SELECT count(*) FROM public.intro_requests;')" "1"

# reciprocal pair where only ONE member is unavailable — the far side is still available
seed
PID=$(Q "INSERT INTO public.member_pairs (user_a_id,user_b_id,status) VALUES ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','active') RETURNING id;")
Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status,pair_id) VALUES
   ('97000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','suggested','$PID'),
   ('97000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000f1','suggested','$PID');" >/dev/null
Q "SELECT public.neutralize_unavailable_pair('97000000-0000-0000-0000-000000000001');" >/dev/null
chk "one-sided unavailability closes BOTH rows" "$(Q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$PID' AND status='expired';")" "2"
chk "  and BOTH carry system_pair_unavailable — true of the pair, false of neither member" "$(Q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$PID' AND resolution_reason='system_pair_unavailable';")" "2"

# a finalized pair is refused
seed
PID=$(Q "INSERT INTO public.member_pairs (user_a_id,user_b_id,status) VALUES ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','matched') RETURNING id;")
Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status,pair_id) VALUES
   ('98000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','suggested','$PID');" >/dev/null
R=$(Q "SELECT public.neutralize_unavailable_pair('98000000-0000-0000-0000-000000000001')::text;")
echo "$R" | grep -q 'finalized' && ok "a finalized pair is refused" || bad "finalized: $R"

# mutual interest is refused (finalisation owns it)
seed
PID=$(Q "INSERT INTO public.member_pairs (user_a_id,user_b_id,status) VALUES ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','active') RETURNING id;")
Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status,pair_id) VALUES
   ('98000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d2','suggested','$PID'),
   ('98000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000f1','approved','$PID');" >/dev/null
Q "UPDATE public.intro_requests SET status='approved' WHERE id='98000000-0000-0000-0000-000000000002';" >/dev/null
R=$(Q "SELECT public.neutralize_unavailable_pair('98000000-0000-0000-0000-000000000002')::text;")
echo "$R" | grep -q 'not_actionable' && ok "a mutually-interested pair is never pre-empted" || bad "mutual: $R"

echo "── 19. nothing else in the database moved ──"
seed
card 99000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000d2
B4M=$(Q 'SELECT count(*) FROM public.matches;'); B4P=$(Q 'SELECT count(*) FROM public.profiles;')
B4B=$(Q 'SELECT count(*) FROM public.batch_suggestions;'); B4R=$(Q 'SELECT count(*) FROM public.recommendation_batches;')
Q "SELECT public.sweep_unavailable_introductions(100);" >/dev/null
chk "  matches unchanged" "$(Q 'SELECT count(*) FROM public.matches;')" "$B4M"
chk "  profiles unchanged" "$(Q 'SELECT count(*) FROM public.profiles;')" "$B4P"
chk "  batch_suggestions unchanged" "$(Q 'SELECT count(*) FROM public.batch_suggestions;')" "$B4B"
chk "  recommendation_batches unchanged" "$(Q 'SELECT count(*) FROM public.recommendation_batches;')" "$B4R"
chk "  no replacement card was created" "$(Q "SELECT count(*) FROM public.intro_requests WHERE status='suggested';")" "0"

echo
printf '══ %d passed, %d failed ══\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
