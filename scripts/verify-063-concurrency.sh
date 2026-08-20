#!/usr/bin/env bash
#
# Migration 063 verification against a REAL, DISPOSABLE PostgreSQL.
#
# WHY THIS EXISTS. The Vitest suite drives a JavaScript transcription of the SQL. A model of a lock
# is not a lock: it cannot prove that two concurrent transactions serialize, that a partial promotion
# respects the partial-unique indexes, or that a failure rolls back. Only two real sessions can.
#
# HOW THE LOCK IS PROVEN. Session A opens a transaction, calls a capacity function, and does NOT
# commit — so it holds pg_advisory_xact_lock(hashtextextended(member_id)). Session B then calls the
# same function for the SAME member with `SET LOCAL lock_timeout`. If the lock works, B blocks and
# dies with SQLSTATE 55P03 (lock_not_available). If B returns a result instead, the two calls
# interleaved and the test FAILS. A control case with a DIFFERENT member must NOT block, so the
# suite cannot pass vacuously by blocking on everything.
#
# USAGE
#   DATABASE_URL=postgres://…/andrel_capacity_test ./scripts/verify-063-concurrency.sh
#
# SAFETY. It refuses any hosted Supabase URL, and any database whose name is not obviously
# disposable (must contain 'test' or 'tmp', or FORCE_DISPOSABLE=1). It TRUNCATES tables repeatedly.
set -uo pipefail

URL="${DATABASE_URL:-}"
[[ -z "$URL" ]] && { echo "DATABASE_URL is required (point it at a DISPOSABLE database)"; exit 2; }
if [[ "$URL" == *"supabase.co"* || "$URL" == *"supabase.com"* ]]; then
  echo "REFUSING: this looks like a hosted Supabase URL. This script truncates tables."; exit 2
fi
DBNAME="${URL##*/}"; DBNAME="${DBNAME%%\?*}"
if [[ "$DBNAME" != *test* && "$DBNAME" != *tmp* && "${FORCE_DISPOSABLE:-0}" != "1" ]]; then
  echo "REFUSING: database '$DBNAME' is not obviously disposable. Set FORCE_DISPOSABLE=1 to override."; exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
A=aaaaaaaa-0000-4000-8000-000000000001
B=bbbbbbbb-0000-4000-8000-000000000002
C=cccccccc-0000-4000-8000-000000000003
D=dddddddd-0000-4000-8000-000000000004
E=eeeeeeee-0000-4000-8000-000000000005
F=ffffffff-0000-4000-8000-000000000006
G=99999999-0000-4000-8000-000000000007
H=88888888-0000-4000-8000-000000000008
X=77777777-0000-4000-8000-000000000009   # ineligible (matching_paused)

q()   { psql "$URL" -qAt -c "$1" 2>&1; }
reset(){ psql "$URL" -qAt -c "SELECT public.t_reset();" >/dev/null 2>&1; }
PASS=0; FAIL=0
check(){ if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; PASS=$((PASS+1));
         else echo "  FAIL  $1 — got [$2] want [$3]"; FAIL=$((FAIL+1)); fi; }
place(){ q "SELECT public.place_batch_rows('$1'::uuid,'$2',(SELECT jsonb_agg(jsonb_build_object('target_user_id',t)) FROM unnest(ARRAY[$3]::text[]) t));"; }
counts(){ q "SELECT count(*) FILTER (WHERE status='suggested') || '/' || count(*) FILTER (WHERE status='queued') FROM public.intro_requests WHERE requester_id='$1';"; }
# visible/reserved/dropped/reason from a placement result
res(){ python3 -c "import sys,json;d=json.load(sys.stdin);print(f\"{d.get('visible_placed',0)}/{d.get('reserved_placed',0)}/{d.get('dropped',0)}/{d.get('reason','-')}\")"; }
# batch summary: count and sources by state
batches(){ q "SELECT coalesce(string_agg(state||':'||batch_source,',' ORDER BY state,batch_source),'none') FROM public.recommendation_batches WHERE member_id='$1';"; }
seed_batch(){ q "INSERT INTO public.recommendation_batches(batch_id,member_id,batch_source,state,created_at,generated_at,displayed_at) VALUES (gen_random_uuid(),'$1','$2','$3',now(),now(),CASE WHEN '$3'='active' THEN now() ELSE NULL END);" >/dev/null; }
seed_card(){ q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,batch_id) SELECT '$1','$2','$3',batch_id FROM public.recommendation_batches WHERE member_id='$1' AND state='$4';" >/dev/null; }

echo "== environment =="
q "SELECT 'server: ' || version();" | head -1
q "SELECT 'database: ' || current_database() || ' | port ' || inet_server_port() || ' | user ' || current_user;"

echo
echo "== applying fixture + migration 063 =="
psql "$URL" -v ON_ERROR_STOP=1 -qAt -f "$ROOT/supabase/tests/063_fixture.sql" >/dev/null 2>&1
echo "  fixture exit=$?"
psql "$URL" -v ON_ERROR_STOP=1 -qAt -f "$ROOT/supabase/migrations/063_unified_introduction_capacity.sql" >/dev/null
echo "  migration exit=$?"

# ── session A held open through a FIFO ───────────────────────────────────────────────────────────
CTL="$(mktemp -u)"; mkfifo "$CTL"
psql "$URL" -qAt < "$CTL" > /tmp/063_sessionA.log 2>&1 &
A_PID=$!
exec 9>"$CTL"
sayA(){ echo "$1" >&9; }
cleanup(){ exec 9>&- 2>/dev/null || true; wait "$A_PID" 2>/dev/null || true; rm -f "$CTL"; }
trap cleanup EXIT

# Returns "blocked:<SQLSTATE>" or "ran"
b_blocks() {
  local out
  out="$(psql "$URL" -qAt -v VERBOSITY=verbose -c "BEGIN; SET LOCAL lock_timeout='1200ms'; $1 COMMIT;" 2>&1)"
  if grep -qi "lock timeout" <<<"$out"; then echo "blocked:55P03"; else echo "ran"; fi
}

echo
echo "== REQUIRED 1-3 — reciprocal capacity is per-member and visible-only =="
reset
check "1a. A(0/0) ↔ B(0/0) reciprocal succeeds" "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid);")" "created"
reset
q "SELECT public.create_reciprocal_suggestion('$B'::uuid,'$C'::uuid);" >/dev/null   # B has 1 visible
check "1b. B already holds 1 visible → A↔B still succeeds" "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid);")" "created"
check "1c. A ends at 1 visible"  "$(counts $A)" "1/0"
check "1d. B ends at 2 visible (both, at cap)" "$(counts $B)" "2/0"
reset
q "SELECT public.create_reciprocal_suggestion('$B'::uuid,'$C'::uuid);" >/dev/null
q "SELECT public.create_reciprocal_suggestion('$B'::uuid,'$D'::uuid);" >/dev/null
check "3a. B holds C and D → A↔B returns capacity" "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid);")" "capacity"
check "3b. neither side received a card" "$(counts $A)|$(counts $B)" "0/0|2/0"

echo
echo "== REQUIRED 4-5 — one call fills visible THEN reserved =="
reset
check "4a. 0/0 + 4 candidates → 2 visible + 2 reserved" \
  "$(place $A weekly "'$C','$D','$E','$F'" | python3 -c "import sys,json;d=json.load(sys.stdin);print(f\"{d['visible_placed']}/{d['reserved_placed']}/{d['dropped']}\")")" "2/2/0"
check "4b. member row counts agree" "$(counts $A)" "2/2"
reset
q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid);" >/dev/null   # A has 1 visible, batch_id NULL
check "5a. 1 visible/0 reserved + 2 candidates → 1 visible + 1 reserved" \
  "$(place $A weekly "'$C','$D'" | python3 -c "import sys,json;d=json.load(sys.stdin);print(f\"{d['visible_placed']}/{d['reserved_placed']}/{d['dropped']}\")")" "1/1/0"
check "5b. THE REGRESSION: visible stays at the cap, not 3" "$(counts $A)" "2/1"
check "5c. 2 visible/1 reserved + 2 candidates → 0 visible + 1 reserved + 1 dropped" \
  "$(place $A weekly "'$E','$F'" | python3 -c "import sys,json;d=json.load(sys.stdin);print(f\"{d['visible_placed']}/{d['reserved_placed']}/{d['dropped']}\")")" "0/1/1"
check "5d. both tiers now at cap" "$(counts $A)" "2/2"

echo
echo "== REQUIRED 6 — a full organic queue is NEVER deleted by admin placement =="
reset
q "SELECT public.place_batch_rows('$A'::uuid,'weekly',jsonb_build_array(jsonb_build_object('target_user_id','$C'),jsonb_build_object('target_user_id','$D')));" >/dev/null
q "SELECT public.place_batch_rows('$A'::uuid,'weekly',jsonb_build_array(jsonb_build_object('target_user_id','$E'),jsonb_build_object('target_user_id','$F')));" >/dev/null
BEFORE_ROWS="$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$A';")"
BEFORE_META="$(q "SELECT string_agg(state||':'||batch_source,',' ORDER BY state) FROM public.recommendation_batches WHERE member_id='$A';")"
ADMIN="$(place $A admin_reciprocal "'$G','$H'")"
check "6a. admin placement is refused at capacity" "$(echo "$ADMIN" | python3 -c "import sys,json;print(json.load(sys.stdin)['reason'])")" "at_capacity"
check "6b. no row was deleted"       "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$A';")" "$BEFORE_ROWS"
check "6c. no batch was discarded"   "$(q "SELECT string_agg(state||':'||batch_source,',' ORDER BY state) FROM public.recommendation_batches WHERE member_id='$A';")" "$BEFORE_META"
check "6d. zero discarded batches exist anywhere" "$(q "SELECT count(*) FROM public.recommendation_batches WHERE state='discarded';")" "0"

echo
echo "== REQUIRED 7-10 — concurrency (two real sessions) =="
reset
sayA "BEGIN; SELECT public.create_reciprocal_suggestion('$A'::uuid,'$C'::uuid);"
sleep 1
check "7.  reciprocal(A,C) blocks placement for A" "$(b_blocks "SELECT public.place_batch_rows('$A'::uuid,'weekly',jsonb_build_array(jsonb_build_object('target_user_id','$D')));")" "blocked:55P03"
check "8.  reciprocal(A,C) blocks promotion for A" "$(b_blocks "SELECT public.promote_queued_rows('$A'::uuid);")" "blocked:55P03"
check "10. a DIFFERENT member does NOT block (control)" "$(b_blocks "SELECT public.place_batch_rows('$E'::uuid,'weekly',jsonb_build_array(jsonb_build_object('target_user_id','$F')));")" "ran"
sayA "COMMIT;"; sleep 0.5
check "7b. after commit, A holds exactly 1 visible — cap never exceeded" "$(counts $A)" "1/0"

reset
sayA "BEGIN; SELECT public.place_batch_rows('$A'::uuid,'weekly',jsonb_build_array(jsonb_build_object('target_user_id','$C')));"
sleep 1
check "9a. placement vs placement serializes" "$(b_blocks "SELECT public.place_batch_rows('$A'::uuid,'weekly',jsonb_build_array(jsonb_build_object('target_user_id','$D')));")" "blocked:55P03"
sayA "COMMIT;"; sleep 0.5
reset
sayA "BEGIN; SELECT public.promote_queued_rows('$A'::uuid);"
sleep 1
check "9b. promotion vs promotion serializes" "$(b_blocks "SELECT public.promote_queued_rows('$A'::uuid);")" "blocked:55P03"
sayA "COMMIT;"; sleep 0.5

echo
echo "== REQUIRED 11-12 — promotion: partial reveal, split, and batch completion =="
reset
q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid);" >/dev/null                      # 1 visible, batch_id NULL
q "SELECT public.place_batch_rows('$A'::uuid,'weekly',jsonb_build_array(jsonb_build_object('target_user_id','$C'),jsonb_build_object('target_user_id','$D')));" >/dev/null
check "11a. setup — 2 visible (1 reciprocal + 1 batch) + 1 reserved" "$(counts $A)" "2/1"
# resolve ONLY the legacy batch row; the reciprocal card stays unanswered
q "UPDATE public.intro_requests SET status='passed', updated_at=now() WHERE requester_id='$A' AND batch_id IS NOT NULL AND status='suggested';" >/dev/null
PROMO="$(q "SELECT public.promote_queued_rows('$A'::uuid);")"
check "12a. the legacy batch COMPLETES despite an unanswered reciprocal card" \
  "$(q "SELECT state FROM public.recommendation_batches WHERE member_id='$A' AND completed_at IS NOT NULL;")" "completed"
check "12b. the reciprocal card is NOT archived — it still consumes a visible slot" \
  "$(q "SELECT status FROM public.intro_requests WHERE requester_id='$A' AND pair_id IS NOT NULL;")" "suggested"
check "11b. exactly one reservation was revealed into the one free slot" "$(counts $A)" "2/0"
check "11c. no batch mixes statuses" \
  "$(q "SELECT count(*) FROM public.recommendation_batches b JOIN public.intro_requests i ON i.batch_id=b.batch_id WHERE b.member_id='$A' AND ((b.state='active' AND i.status<>'suggested') OR (b.state='queued' AND i.status<>'queued'));")" "0"

reset
q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid);" >/dev/null
q "SELECT public.place_batch_rows('$A'::uuid,'weekly',jsonb_build_array(jsonb_build_object('target_user_id','$C'),jsonb_build_object('target_user_id','$D'),jsonb_build_object('target_user_id','$E')));" >/dev/null
q "UPDATE public.intro_requests SET status='passed', updated_at=now() WHERE requester_id='$A' AND batch_id IS NOT NULL AND status='suggested';" >/dev/null
q "SELECT public.promote_queued_rows('$A'::uuid);" >/dev/null
check "11d. partial promotion leaves the remainder queued" "$(counts $A)" "2/1"
check "11e. still exactly one active and one queued batch" \
  "$(q "SELECT count(*) FILTER (WHERE state='active') || '/' || count(*) FILTER (WHERE state='queued') FROM public.recommendation_batches WHERE member_id='$A';")" "1/1"
check "11f. split batch holds only queued rows" \
  "$(q "SELECT count(*) FROM public.recommendation_batches b JOIN public.intro_requests i ON i.batch_id=b.batch_id WHERE b.member_id='$A' AND ((b.state='active' AND i.status<>'suggested') OR (b.state='queued' AND i.status<>'queued'));")" "0"

echo
echo "== REQUIRED 13 — p_max_cards cannot raise the database cap =="
reset
q "SELECT public.create_reciprocal_suggestion('$B'::uuid,'$C'::uuid);" >/dev/null
q "SELECT public.create_reciprocal_suggestion('$B'::uuid,'$D'::uuid);" >/dev/null
# >=1 clamps to the cap; NULL/0/negative now fail closed with 'invalid' (see BLOCKER 5 section).
check "13. p_max_cards=100 -> capacity (clamped, cannot raise)" \
  "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid,'reciprocal',NULL,30,100);")" "capacity"
check "13. p_max_cards=2 -> capacity"   "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid,'reciprocal',NULL,30,2);")" "capacity"
for v in "NULL" "0" "-5"; do
  check "13. p_max_cards=$v -> invalid (fails closed, never the full cap)" \
    "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid,'reciprocal',NULL,30,$v);")" "invalid"
done
check "13e. B still holds exactly 2 visible" "$(counts $B)" "2/0"

echo
echo "== REQUIRED 14 — unsafe targets produce no unsafe write =="
reset
check "14a. malformed uuid dropped"     "$(place $A weekly "'not-a-uuid'" | python3 -c "import sys,json;print(json.load(sys.stdin)['reason'])")" "no_eligible_candidates"
check "14b. non-existent target dropped" "$(place $A weekly "'12121212-0000-4000-8000-000000009999'" | python3 -c "import sys,json;print(json.load(sys.stdin)['reason'])")" "no_eligible_candidates"
check "14c. ineligible (paused) target dropped" "$(place $A weekly "'$X'" | python3 -c "import sys,json;print(json.load(sys.stdin)['reason'])")" "no_eligible_candidates"
check "14d. self-target dropped"        "$(place $A weekly "'$A'" | python3 -c "import sys,json;print(json.load(sys.stdin)['reason'])")" "no_eligible_candidates"
q "INSERT INTO public.blocked_users(user_id,blocked_user_id) VALUES ('$C','$A');" >/dev/null
check "14e. blocked target dropped (reverse direction)" "$(place $A weekly "'$C'" | python3 -c "import sys,json;print(json.load(sys.stdin)['reason'])")" "no_eligible_candidates"
q "INSERT INTO public.matches(user_a_id,user_b_id) VALUES ('$D','$A');" >/dev/null
check "14f. already-matched target dropped" "$(place $A weekly "'$D'" | python3 -c "import sys,json;print(json.load(sys.stdin)['reason'])")" "no_eligible_candidates"
q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,updated_at) VALUES ('$A','$E','passed',now());" >/dev/null
check "14g. in-cooldown target dropped" "$(place $A weekly "'$E'" | python3 -c "import sys,json;print(json.load(sys.stdin)['reason'])")" "no_eligible_candidates"
check "14h. ineligible MEMBER gets nothing" "$(place $X weekly "'$C'" | python3 -c "import sys,json;print(json.load(sys.stdin)['reason'])")" "ineligible"
check "14i. oversized payload refused" \
  "$(q "SELECT public.place_batch_rows('$A'::uuid,'weekly',(SELECT jsonb_agg(jsonb_build_object('target_user_id','$F')) FROM generate_series(1,51))) ->> 'reason';")" "too_many_rows"
check "14j. non-array payload refused" "$(q "SELECT public.place_batch_rows('$A'::uuid,'weekly','\"nope\"'::jsonb) ->> 'reason';")" "invalid"
check "14k. duplicates deduplicate, first occurrence wins" \
  "$(q "SELECT (public.place_batch_rows('$A'::uuid,'weekly',jsonb_build_array(jsonb_build_object('target_user_id','$F','match_reason','first'),jsonb_build_object('target_user_id','$F','match_reason','second'))) ->> 'visible_placed');")" "1"
check "14l. and kept the FIRST reason" "$(q "SELECT match_reason FROM public.intro_requests WHERE requester_id='$A' AND target_user_id='$F';")" "first"
check "14m. no unsafe row was written by any of the above" \
  "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$A' AND status IN ('suggested','queued') AND target_user_id IN ('$C','$D','$E','$X','$A');")" "0"

echo
echo "== REQUIRED 15 — rollback leaves nothing =="
reset
psql "$URL" -qAt -c "BEGIN; SELECT public.place_batch_rows('$A'::uuid,'weekly',jsonb_build_array(jsonb_build_object('target_user_id','$C'),jsonb_build_object('target_user_id','$D'),jsonb_build_object('target_user_id','$E'))); ROLLBACK;" >/dev/null
check "15a. no intro_requests rows"        "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$A';")" "0"
check "15b. no recommendation_batches rows" "$(q "SELECT count(*) FROM public.recommendation_batches WHERE member_id='$A';")" "0"
psql "$URL" -qAt -c "BEGIN; SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid); ROLLBACK;" >/dev/null
check "15c. no member_pairs rows"          "$(q "SELECT count(*) FROM public.member_pairs;")" "0"
q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid);" >/dev/null
check "15d. retry of an ambiguous reciprocal call is idempotent" "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid);")" "exists_active"
check "15e. and did not duplicate pair rows" "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id IS NOT NULL;")" "2"

echo
echo "== BLOCKER 4 — source-mismatch matrix (every combination) =="
# Each case: seed the member's batches/cards, then place from 'weekly' and report the full tuple.
# CASE 1 — active SAME source, queued SAME source, both tiers partially free
reset; seed_batch $A weekly active; seed_card $A $C suggested active
       seed_batch $A weekly queued; seed_card $A $D queued queued
check "4.1 active=weekly queued=weekly, 1 free each, 2 candidates -> 1 visible + 1 reserved" \
  "$(place $A weekly "'$E','$F'" | res)" "1/1/0/-"
check "4.1 batches unchanged in count and source" "$(batches $A)" "active:weekly,queued:weekly"
check "4.1 rows"  "$(counts $A)" "2/2"

# CASE 2 — active DIFFERENT source, queued ABSENT
reset; seed_batch $A admin_reciprocal active; seed_card $A $C suggested active
check "4.2 active=admin queued=absent -> visible tier skipped, reserved used" \
  "$(place $A weekly "'$E','$F'" | res)" "0/2/0/-"
check "4.2 a NEW queued batch was created, admin active batch untouched" "$(batches $A)" "active:admin_reciprocal,queued:weekly"
check "4.2 rows" "$(counts $A)" "1/2"

# CASE 3 — active ABSENT, queued DIFFERENT source
reset; seed_batch $A admin_reciprocal queued; seed_card $A $C queued queued
check "4.3 active=absent queued=admin -> visible used, reserved skipped" \
  "$(place $A weekly "'$E','$F'" | res)" "2/0/0/-"
check "4.3 a NEW active batch was created, admin queued batch untouched" "$(batches $A)" "active:weekly,queued:admin_reciprocal"
check "4.3 rows" "$(counts $A)" "2/1"

# CASE 4 — active SAME source, queued DIFFERENT source
reset; seed_batch $A weekly active; seed_card $A $C suggested active
       seed_batch $A admin_reciprocal queued; seed_card $A $D queued queued
check "4.4 active=weekly queued=admin -> 1 visible appended, reserved skipped, 1 dropped" \
  "$(place $A weekly "'$E','$F'" | res)" "1/0/1/-"
check "4.4 no new batch of either state" "$(batches $A)" "active:weekly,queued:admin_reciprocal"
check "4.4 rows" "$(counts $A)" "2/1"

# CASE 5 — BOTH tiers different source, both partially free
reset; seed_batch $A admin_reciprocal active; seed_card $A $C suggested active
       seed_batch $A admin_reciprocal queued; seed_card $A $D queued queued
BEFORE5="$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$A';")"
check "4.5 both tiers admin, placing weekly -> refused source_mismatch" \
  "$(place $A weekly "'$E','$F'" | res)" "0/0/2/source_mismatch"
check "4.5 nothing written"  "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$A';")" "$BEFORE5"
check "4.5 no evicted card, no new batch" "$(batches $A)" "active:admin_reciprocal,queued:admin_reciprocal"

# CASE 6 — same source both tiers, VISIBLE full, reserved partly free
reset; seed_batch $A weekly active; seed_card $A $C suggested active; seed_card $A $D suggested active
check "4.6 visible full, reserved free -> all into reserved" \
  "$(place $A weekly "'$E','$F'" | res)" "0/2/0/-"
check "4.6 rows" "$(counts $A)" "2/2"

# CASE 7 — a candidate is never dropped while the other compatible tier has room
reset; seed_batch $A admin_reciprocal active; seed_card $A $C suggested active
check "4.7 visible tier incompatible but reserved compatible -> 0 dropped" \
  "$(place $A weekly "'$E'" | res)" "0/1/0/-"

echo
echo "== BLOCKER 5 — legacy p_max_cards fails closed =="
reset
check "5.1 p_max_cards NULL -> invalid"    "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid,'reciprocal',NULL,30,NULL);")" "invalid"
check "5.2 p_max_cards 0 -> invalid"       "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid,'reciprocal',NULL,30,0);")" "invalid"
check "5.3 p_max_cards -5 -> invalid"      "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid,'reciprocal',NULL,30,-5);")" "invalid"
check "5.4 none of those wrote anything"   "$(q "SELECT count(*) FROM public.intro_requests;")|$(q "SELECT count(*) FROM public.member_pairs;")" "0|0"
check "5.5 p_max_cards 1 -> created"       "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid,'reciprocal',NULL,30,1);")" "created"
check "5.6 p_max_cards 1 caps at ONE visible per participant" \
  "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$C'::uuid,'reciprocal',NULL,30,1);")" "capacity"
check "5.7 p_max_cards 2 allows the second" "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$C'::uuid,'reciprocal',NULL,30,2);")" "created"
check "5.8 A now holds exactly 2 visible"  "$(counts $A)" "2/0"
check "5.9 p_max_cards 100 still capped at 2" \
  "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$D'::uuid,'reciprocal',NULL,30,100);")" "capacity"
check "5.10 refusal outcomes remain idempotent (repeat is identical)" \
  "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$D'::uuid,'reciprocal',NULL,30,100);")" "capacity"
check "5.11 retry of a created pair is idempotent" \
  "$(q "SELECT public.create_reciprocal_suggestion('$A'::uuid,'$B'::uuid,'reciprocal',NULL,30,2);")" "exists_active"
check "5.12 and nothing was duplicated"    "$(counts $A)" "2/0"

echo
echo "== grants, definer, search_path =="
for fn in create_reciprocal_suggestion place_batch_rows promote_queued_rows; do
  # Per-overload row, then folded — has_function_privilege is not an aggregate, so it must be
  # evaluated per row and aggregated afterwards.
  check "$fn: anon=f authenticated=f service_role=t" \
    "$(q "SELECT bool_or(anon)::text||bool_or(auth)::text||bool_and(svc)::text FROM (SELECT has_function_privilege('anon',p.oid,'EXECUTE') AS anon, has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth, has_function_privilege('service_role',p.oid,'EXECUTE') AS svc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='$fn') r;")" "falsefalsetrue"
  # Postgres stores SET search_path = '' as the proconfig entry search_path="" (quoted empty).
  check "$fn: SECURITY DEFINER + search_path=''" \
    "$(q "SELECT bool_and(p.prosecdef)::text || bool_and(p.proconfig::text = '{\"search_path=\\\"\\\"\"}')::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='$fn';")" "truetrue"
  check "$fn: owner is a single trusted role (definer runs as owner)" \
    "$(q "SELECT count(DISTINCT pg_get_userbyid(p.proowner)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='$fn';")" "1"
  check "$fn: no dynamic SQL" \
    "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='$fn' AND (p.prosrc ~* 'EXECUTE\\s+(format|''|\"|\\\$)' OR p.prosrc ~* 'quote_ident|quote_literal');")" "0"
done

echo
echo "== FINAL INVARIANTS across everything the suite created =="
check "every member has suggested <= 2" "$(q "SELECT count(*) FROM (SELECT requester_id FROM public.intro_requests WHERE status='suggested' GROUP BY 1 HAVING count(*)>2) x;")" "0"
check "every member has queued <= 2"    "$(q "SELECT count(*) FROM (SELECT requester_id FROM public.intro_requests WHERE status='queued' GROUP BY 1 HAVING count(*)>2) x;")" "0"
check "no member has >1 active batch"   "$(q "SELECT count(*) FROM (SELECT member_id FROM public.recommendation_batches WHERE state='active' GROUP BY 1 HAVING count(*)>1) x;")" "0"
check "no member has >1 queued batch"   "$(q "SELECT count(*) FROM (SELECT member_id FROM public.recommendation_batches WHERE state='queued' GROUP BY 1 HAVING count(*)>1) x;")" "0"
check "active batches hold only suggested rows" \
  "$(q "SELECT count(*) FROM public.recommendation_batches b JOIN public.intro_requests i ON i.batch_id=b.batch_id WHERE b.state='active' AND i.status<>'suggested';")" "0"
check "queued batches hold only queued rows" \
  "$(q "SELECT count(*) FROM public.recommendation_batches b JOIN public.intro_requests i ON i.batch_id=b.batch_id WHERE b.state='queued' AND i.status<>'queued';")" "0"
check "nothing was ever discarded"      "$(q "SELECT count(*) FROM public.recommendation_batches WHERE state='discarded';")" "0"

echo
echo "==================== $PASS passed, $FAIL failed ===================="
[[ "$FAIL" -eq 0 ]] || exit 1
