#!/usr/bin/env bash
#
# Migration 064 verification against a REAL, DISPOSABLE PostgreSQL.
#
# WHY THIS EXISTS. Static assertions on SQL text cannot prove atomicity. Only real sessions can
# show that two directional rows commit together or not at all, that a second concurrent approval
# BLOCKS on the participant advisory lock, that a refusal leaves the database untouched, and that a
# capacity-rejected pair keeps its review rows approvable. Those are the properties that made the
# 145 historical one-sided rows possible, so they are the ones worth proving.
#
# USAGE
#   DATABASE_URL=postgres://…/andrel_064_test ./scripts/verify-064-atomic-pair.sh
#
# SAFETY. Refuses any hosted Supabase URL and any database whose name is not obviously disposable
# (must contain 'test' or 'tmp', or FORCE_DISPOSABLE=1). It TRUNCATES tables repeatedly.
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

A=aaaaaaaa-0000-4000-8000-000000000001
B=bbbbbbbb-0000-4000-8000-000000000002
C=cccccccc-0000-4000-8000-000000000003
D=dddddddd-0000-4000-8000-000000000004
RB=11111111-0000-4000-8000-0000000000aa   # review batch

q(){ psql "$URL" -qAt -c "$1" 2>&1; }
PASS=0; FAIL=0
check(){ if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; PASS=$((PASS+1));
         else echo "  FAIL  $1 — got [$2] want [$3]"; FAIL=$((FAIL+1)); fi; }
out(){ python3 -c "import sys,json;print(json.load(sys.stdin).get('outcome','-'))"; }
fld(){ python3 -c "import sys,json;print(json.load(sys.stdin).get('$1','-'))"; }

reset(){
  q "SELECT public.t_reset064();" >/dev/null
  # The 063 fixture already seeds these ids, and migration 061 adds
  # profiles_complete_requires_location_chk — so an INSERT without a location silently FAILS and
  # leaves the previous scenario's mutation in place. Force the eligibility columns with an UPDATE
  # and always supply a location, or every later gate reports 'ineligible' from leaked state.
  q "UPDATE public.profiles
        SET account_status='active', profile_complete=true, is_admin=false, is_test_account=false,
            matching_paused=false, company=NULL, location='New York, NY'
      WHERE id IN ('$A','$B','$C','$D');" >/dev/null
  local ELIG
  ELIG=$(q "SELECT count(*) FROM public.profiles WHERE id IN ('$A','$B','$C','$D')
              AND account_status='active' AND profile_complete AND NOT matching_paused
              AND NOT is_admin AND NOT is_test_account;")
  if [[ "$ELIG" != "4" ]]; then
    echo "  ABORT: reset failed to make all four members eligible (got $ELIG/4)"; exit 3
  fi
  q "INSERT INTO public.introduction_batches(id,batch_number,week_start,week_end,status)
     VALUES ('$RB',1,current_date,current_date+6,'pending_review');" >/dev/null
}
# symmetric review proposals for a pair
prop(){ q "INSERT INTO public.batch_suggestions(batch_id,recipient_id,suggested_id,reason,match_score,position,status)
           VALUES ('$RB','$1','$2','r1',80.00,1,'generated'),('$RB','$2','$1','r2',80.00,1,'generated');" >/dev/null; }
call(){ q "SELECT public.materialize_admin_pair('$RB'::uuid,'$1'::uuid,'$2'::uuid);"; }
cards(){ q "SELECT count(*) FILTER (WHERE status='suggested')||'/'||count(*) FILTER (WHERE status='queued') FROM public.intro_requests WHERE requester_id='$1';"; }
seed_cards(){ # $1 member, $2 n_suggested, $3 n_queued  — seeded against throwaway targets
  # C-style loops, NOT `seq 1 $n`: BSD/macOS seq counts DOWN when the end is below the start, so
  # `seq 1 0` emits "1 0" and a "seed zero rows" call silently seeds TWO. That difference made the
  # queued-tier scenarios look like RPC capacity failures when the fault was entirely in the seed.
  local i
  for ((i=0; i<${2:-0}; i++)); do q "INSERT INTO public.intro_requests(requester_id,target_user_id,status) VALUES ('$1','$C','suggested');" >/dev/null; done
  for ((i=0; i<${3:-0}; i++)); do q "INSERT INTO public.intro_requests(requester_id,target_user_id,status) VALUES ('$1','$D','queued');" >/dev/null; done
}

echo "== environment =="
q "SELECT 'server: ' || version();" | head -1
q "SELECT 'database: ' || current_database() || ' | user ' || current_user;"

echo
echo "== 1. visible/visible atomic placement =="
reset; prop $A $B
R=$(call $A $B)
check "outcome is created"                 "$(echo "$R" | out)"       "created"
check "tier is suggested"                  "$(echo "$R" | fld tier)"  "suggested"
check "A has 1 visible"                    "$(cards $A)"              "1/0"
check "B has 1 visible"                    "$(cards $B)"              "1/0"
check "exactly two directional rows"       "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id IS NOT NULL;")" "2"
check "both rows share ONE pair_id"        "$(q "SELECT count(DISTINCT pair_id) FROM public.intro_requests WHERE pair_id IS NOT NULL;")" "1"
check "per-member batch ids DIFFER"        "$(q "SELECT count(DISTINCT batch_id) FROM public.intro_requests WHERE pair_id IS NOT NULL;")" "2"
check "each row uses its OWN member batch" "$(q "SELECT count(*) FROM public.intro_requests ir JOIN public.recommendation_batches b ON b.batch_id=ir.batch_id WHERE b.member_id=ir.requester_id;")" "2"
check "both review rows materialized"      "$(q "SELECT count(*) FROM public.batch_suggestions WHERE materialized_at IS NOT NULL AND status='shown';")" "2"
check "no notification/email written in SQL" "$(q "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('notifications','email_queue');")" "0"

echo
echo "== 2. repeated approval is idempotent =="
R2=$(call $A $B)
check "second call: already_materialized"  "$(echo "$R2" | out)" "already_materialized"
check "still exactly two rows"             "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id IS NOT NULL;")" "2"
check "argument order does not matter"     "$(call $B $A | out)" "already_materialized"
check "STILL exactly two rows"             "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id IS NOT NULL;")" "2"

echo
echo "== 3. VISIBLE-ONLY: a pair is never placed in the reserved tier =="
reset; prop $A $B; seed_cards $A 2 0; seed_cards $B 2 0
BEFORE=$(q "SELECT count(*) FROM public.intro_requests;")
R=$(call $A $B)
check "no visible room -> capacity, not queued"  "$(echo "$R" | out)" "capacity"
check "no rows written"                          "$(q "SELECT count(*) FROM public.intro_requests;")" "$BEFORE"
check "review rows stay 'generated'"             "$(q "SELECT count(*) FROM public.batch_suggestions WHERE status='generated' AND materialized_at IS NULL;")" "2"
check "NO pair row is ever status 'queued'"      "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id IS NOT NULL AND status='queued';")" "0"
check "the RPC creates no queued batch"          "$(q "SELECT count(*) FROM public.recommendation_batches WHERE state='queued';")" "0"

echo
echo "== 4. only ONE side lacks visible room -> capacity, never a split tier =="
reset; prop $A $B; seed_cards $B 2 0
BEFORE=$(q "SELECT count(*) FROM public.intro_requests;")
R=$(call $A $B)
check "outcome is capacity"                      "$(echo "$R" | out)" "capacity"
check "A received nothing"                       "$(cards $A)" "0/0"
check "row count unchanged"                      "$(q "SELECT count(*) FROM public.intro_requests;")" "$BEFORE"
check "no split tier is representable"           "$(q "SELECT count(DISTINCT status) FROM public.intro_requests WHERE pair_id IS NOT NULL;")" "0"

echo
echo "== 4b. MULTI-PAIR, MIXED-TIER LIFECYCLE (one member in two pairs) =="
# 1. A receives two VISIBLE pairs -> both land, ONE active batch reused for both.
reset; prop $A $B; prop $A $C
R1=$(call $A $B); R2=$(call $A $C)
check "pair 1 created"                           "$(echo "$R1" | out)" "created"
check "pair 2 created"                           "$(echo "$R2" | out)" "created"
check "A holds 2 visible, 0 queued"              "$(cards $A)" "2/0"
check "A has exactly ONE active batch"           "$(q "SELECT count(*) FROM public.recommendation_batches WHERE member_id='$A' AND state='active';")" "1"
check "both of A's rows REUSE that batch id"     "$(q "SELECT count(DISTINCT batch_id) FROM public.intro_requests WHERE requester_id='$A';")" "1"
check "A has no queued batch"                    "$(q "SELECT count(*) FROM public.recommendation_batches WHERE member_id='$A' AND state='queued';")" "0"
check "the two pairs have DIFFERENT pair_ids"    "$(q "SELECT count(DISTINCT pair_id) FROM public.intro_requests WHERE requester_id='$A';")" "2"

# 3/4. A is full after two pairs -> a third pair cannot place, and never queues.
prop $A $D
R3=$(call $A $D)
check "third pair -> capacity (never queued)"    "$(echo "$R3" | out)" "capacity"
check "A still 2 visible, 0 queued"              "$(cards $A)" "2/0"
check "no queued batch was created"              "$(q "SELECT count(*) FROM public.recommendation_batches WHERE state='queued';")" "0"
check "third pair still reviewable"              "$(q "SELECT count(*) FROM public.batch_suggestions WHERE recipient_id='$A' AND suggested_id='$D' AND status='generated';")" "1"

# 6. A has a foreign ACTIVE envelope holding NOTHING LIVE -> stale, so it is retired rather than
# blocking the member. Refusing here was the underfill; hiding a live card would be worse. Both
# live-envelope cases are covered in section 4i.
reset; prop $A $B
q "INSERT INTO public.recommendation_batches(batch_id,member_id,batch_source,state,created_at,generated_at,displayed_at) VALUES ('dddddd11-0000-4000-8000-000000001111','$A','weekly','active',now(),now(),now());" >/dev/null
check "stale foreign envelope -> created"        "$(call $A $B | out)" "created"
check "it was RETIRED, source preserved"         "$(q "SELECT state||batch_source FROM public.recommendation_batches WHERE batch_id='dddddd11-0000-4000-8000-000000001111';")" "completedweekly"
check "exactly one active envelope for A"        "$(q "SELECT count(*) FROM public.recommendation_batches WHERE member_id='$A' AND state='active';")" "1"

# A's admin envelope from a DIFFERENT review with nothing live -> also stale -> retired, and the new
# envelope carries the CURRENT review stamp.
reset; prop $A $B
q "INSERT INTO public.recommendation_batches(batch_id,member_id,batch_source,state,reciprocal_batch_id,created_at,generated_at,displayed_at) VALUES ('eeeeee11-0000-4000-8000-000000002222','$A','admin_reciprocal','active','33333333-0000-4000-8000-0000000000cc',now(),now(),now());" >/dev/null
check "stale older-review envelope -> created"   "$(call $A $B | out)" "created"
check "old envelope retired"                     "$(q "SELECT state FROM public.recommendation_batches WHERE batch_id='eeeeee11-0000-4000-8000-000000002222';")" "completed"
check "new envelope carries THIS review stamp"   "$(q "SELECT reciprocal_batch_id FROM public.recommendation_batches WHERE member_id='$A' AND state='active';")" "$RB"

# 7. ORDER INDEPENDENCE: materializing {A,B} then {C,D} == {C,D} then {A,B}
reset; prop $A $B; prop $C $D
call $A $B >/dev/null; call $C $D >/dev/null
FWD=$(q "SELECT string_agg(requester_id::text||'>'||target_user_id::text||':'||status,',' ORDER BY requester_id,target_user_id) FROM public.intro_requests;")
reset; prop $A $B; prop $C $D
call $C $D >/dev/null; call $A $B >/dev/null
REV=$(q "SELECT string_agg(requester_id::text||'>'||target_user_id::text||':'||status,',' ORDER BY requester_id,target_user_id) FROM public.intro_requests;")
check "edge order does not change the outcome"   "$FWD" "$REV"

# 8. Partial success then retry: only still-valid pairs complete; done pairs are idempotent.
reset; prop $A $B; prop $A $C; prop $B $C
call $A $B >/dev/null
R=$(call $A $B)
check "replay of a done pair is idempotent"      "$(echo "$R" | out)" "already_materialized"
check "retry completes the remaining pair"       "$(call $A $C | out)" "created"
check "A is now full"                            "$(cards $A)" "2/0"
# B and C each still hold one free slot after the pairs above, so B<->C legitimately FITS —
# asserting otherwise would be asserting a bug. Exhaust them first, then prove the refusal.
check "a pair that still fits is created"        "$(call $B $C | out)" "created"
# A, B and C are now all at 2 visible — no seeding needed, and seeding here would push a member
# over the cap by hand and then blame the RPC for it.
check "B is now at capacity"                     "$(cards $B)" "2/0"
prop $B $D
check "now B is full -> capacity"                "$(call $B $D | out)" "capacity"
check "the refused pair stays reviewable"        "$(q "SELECT count(*) FROM public.batch_suggestions WHERE recipient_id='$B' AND suggested_id='$D' AND status='generated';")" "1"
check "no member over visible capacity"          "$(q "SELECT count(*) FROM (SELECT requester_id FROM public.intro_requests WHERE status='suggested' GROUP BY requester_id HAVING count(*)>2) x;")" "0"

echo
echo "== 4c. DUPLICATE AND MALFORMED REVIEW PROPOSALS (must fail closed, zero writes) =="
dup_case(){ # $1 label, $2 SQL seeding the review rows
  reset
  q "$2" >/dev/null
  local BEFORE; BEFORE=$(q "SELECT count(*) FROM public.intro_requests;")
  local O; O=$(call $A $B | out)
  check "$1: outcome invalid"      "$O" "invalid"
  check "$1: zero writes"          "$(q "SELECT count(*) FROM public.intro_requests;")" "$BEFORE"
  check "$1: no pair row"          "$(q "SELECT count(*) FROM public.member_pairs;")" "0"
}
G="INSERT INTO public.batch_suggestions(batch_id,recipient_id,suggested_id,reason,match_score,status)"
dup_case "two A->B, one B->A" "$G VALUES ('$RB','$A','$B','r',80,'generated'),('$RB','$A','$B','r',80,'generated'),('$RB','$B','$A','r',80,'generated');"
dup_case "one A->B, two B->A" "$G VALUES ('$RB','$A','$B','r',80,'generated'),('$RB','$B','$A','r',80,'generated'),('$RB','$B','$A','r',80,'generated');"
dup_case "duplicates both ways" "$G VALUES ('$RB','$A','$B','r',80,'generated'),('$RB','$A','$B','r',80,'generated'),('$RB','$B','$A','r',80,'generated'),('$RB','$B','$A','r',80,'generated');"
dup_case "dropped mixed with generated" "$G VALUES ('$RB','$A','$B','r',80,'dropped'),('$RB','$B','$A','r',80,'generated');"
dup_case "one side already shown" "$G VALUES ('$RB','$A','$B','r',80,'shown'),('$RB','$B','$A','r',80,'generated');"
dup_case "null suggested_id" "$G VALUES ('$RB','$A',NULL,'r',80,'generated'),('$RB','$B','$A','r',80,'generated');"
dup_case "null recipient_id" "$G VALUES ('$RB',NULL,'$B','r',80,'generated'),('$RB','$B','$A','r',80,'generated');"
dup_case "rows in DIFFERENT review batches" "INSERT INTO public.introduction_batches(id,batch_number,week_start,week_end,status) VALUES ('44444444-0000-4000-8000-0000000000dd',2,current_date,current_date+6,'pending_review'); $G VALUES ('$RB','$A','$B','r',80,'generated'),('44444444-0000-4000-8000-0000000000dd','$B','$A','r',80,'generated');"
dup_case "participants not the batch owners" "$G VALUES ('$RB','$C','$D','r',80,'generated'),('$RB','$D','$C','r',80,'generated');"

# half-materialized: one side stamped, one not -> refuse, never complete one-sidedly
reset
q "$G VALUES ('$RB','$A','$B','r',80,'shown'),('$RB','$B','$A','r',80,'generated');" >/dev/null
q "UPDATE public.batch_suggestions SET materialized_at=now() WHERE recipient_id='$A';" >/dev/null
check "half-materialized: invalid"   "$(call $A $B | out)" "invalid"
check "half-materialized: no writes" "$(q "SELECT count(*) FROM public.intro_requests;")" "0"

# inconsistent score/provenance across the two symmetric rows is ACCEPTED (each side keeps its own
# directional score by design) — assert it does not corrupt anything.
reset
q "$G VALUES ('$RB','$A','$B','ra',91.50,'generated'),('$RB','$B','$A','rb',72.25,'generated');" >/dev/null
check "asymmetric scores are allowed"  "$(call $A $B | out)" "created"
check "each side keeps its OWN score"  "$(q "SELECT count(DISTINCT match_score) FROM public.intro_requests WHERE pair_id IS NOT NULL;")" "2"

echo "== 4d. NO-WRITE-ON-REFUSAL MATRIX (complete state identical before and after) =="
# Fingerprints the ENTIRE relevant database state. Any refusal must leave it byte-identical.
snap(){ q "SELECT md5(coalesce(string_agg(x,'|' ORDER BY x),'')) FROM (
  SELECT 'ir:'||id::text||requester_id::text||target_user_id::text||status||coalesce(pair_id::text,'-')||coalesce(batch_id::text,'-') AS x FROM public.intro_requests
  UNION ALL SELECT 'mp:'||id::text||user_a_id::text||user_b_id::text||status||coalesce(last_recommended_at::text,'-') FROM public.member_pairs
  UNION ALL SELECT 'rb:'||batch_id::text||member_id::text||state||batch_source||coalesce(reciprocal_batch_id::text,'-') FROM public.recommendation_batches
  UNION ALL SELECT 'bs:'||id::text||coalesce(recipient_id::text,'-')||coalesce(suggested_id::text,'-')||coalesce(status,'-')||coalesce(materialized_at::text,'-') FROM public.batch_suggestions
) t;"; }
ctr(){ q "SELECT (SELECT count(*) FROM public.member_pairs)||'/'||(SELECT count(*) FROM public.recommendation_batches)||'/'||(SELECT count(*) FROM public.intro_requests);"; }
norw(){ # $1 label, $2 setup SQL, $3 expected outcome
  reset; prop $A $B
  [ -n "$2" ] && q "$2" >/dev/null
  local S0 C0 O
  S0=$(snap); C0=$(ctr)
  O=$(call $A $B | out)
  check "$1: outcome"                   "$O" "$3"
  check "$1: STATE IDENTICAL"           "$(snap)" "$S0"
  check "$1: mp/rb/ir counts unchanged" "$(ctr)"  "$C0"
}
norw "capacity" "INSERT INTO public.intro_requests(requester_id,target_user_id,status) VALUES ('$A','$C','suggested'),('$A','$C','suggested');" "capacity"
norw "ineligible" "UPDATE public.profiles SET matching_paused=true WHERE id='$B';" "ineligible"
norw "blocked" "INSERT INTO public.blocked_users(user_id,blocked_user_id) VALUES ('$B','$A');" "blocked"
norw "already_matched" "INSERT INTO public.matches(user_a_id,user_b_id) VALUES ('$A','$B');" "already_matched"
norw "same_company" "UPDATE public.profiles SET company='Acme, LLC' WHERE id='$A'; UPDATE public.profiles SET company='acme' WHERE id='$B';" "same_company"
norw "history" "INSERT INTO public.intro_requests(requester_id,target_user_id,status) VALUES ('$B','$A','declined');" "history"
norw "cooldown" "INSERT INTO public.intro_requests(requester_id,target_user_id,status,updated_at) VALUES ('$B','$A','passed',now());" "cooldown"
norw "pair_cooldown" "INSERT INTO public.member_pairs(user_a_id,user_b_id,source,status,last_recommended_at) VALUES (LEAST('$A'::uuid,'$B'::uuid),GREATEST('$A'::uuid,'$B'::uuid),'admin','passed',now());" "cooldown"
# An admin envelope from an OLDER review with a LIVE card is now REUSED, not refused — that refusal
# was the underfill this work exists to remove. A live FOREIGN-source envelope is still refused.
norw "live weekly envelope blocks an admin card" "INSERT INTO public.recommendation_batches(batch_id,member_id,batch_source,state,created_at,generated_at,displayed_at) VALUES ('66666666-0000-4000-8000-0000000000ff','$A','weekly','active',now(),now(),now()); INSERT INTO public.intro_requests(requester_id,target_user_id,status,batch_id) VALUES ('$A','$C','suggested','66666666-0000-4000-8000-0000000000ff');" "capacity"
norw "duplicate_proposal" "$G VALUES ('$RB','$A','$B','r',80,'generated');" "invalid"

reset; prop $A $B
S0=$(snap)
check "batch_id_mismatch: outcome"         "$(q "SELECT public.materialize_admin_pair('$RB'::uuid,'$A'::uuid,'$B'::uuid,'55555555-0000-4000-8000-0000000000ee'::uuid,NULL,30);" | out)" "invalid"
check "batch_id_mismatch: STATE IDENTICAL" "$(snap)" "$S0"

reset; q "$G VALUES ('$RB','$A','$B','r',80,'generated');" >/dev/null
S0=$(snap)
check "malformed proposal: outcome"         "$(call $A $B | out)" "invalid"
check "malformed proposal: STATE IDENTICAL" "$(snap)" "$S0"

echo
echo "== 4e. MEMBER_PAIRS STATUS POLICY (every CHECK-allowed value) =="
pstat(){ reset; prop $A $B
  q "INSERT INTO public.member_pairs(user_a_id,user_b_id,source,status) VALUES (LEAST('$A'::uuid,'$B'::uuid),GREATEST('$A'::uuid,'$B'::uuid),'admin','$1');" >/dev/null
  local S0; S0=$(snap)
  check "pair status '$1' -> $2" "$(call $A $B | out)" "$2"
  if [ "$2" != "created" ]; then check "pair status '$1': STATE IDENTICAL" "$(snap)" "$S0"; fi
}
pstat matched     already_matched
pstat blocked     blocked
pstat ineligible  ineligible
pstat superseded  invalid
pstat active      created
pstat passed      created
pstat expired     created
reset; prop $A $B
q "INSERT INTO public.member_pairs(user_a_id,user_b_id,source,status) VALUES (LEAST('$A'::uuid,'$B'::uuid),GREATEST('$A'::uuid,'$B'::uuid),'admin','matched');" >/dev/null
call $A $B >/dev/null
check "a 'matched' pair is never flipped to active" "$(q "SELECT status FROM public.member_pairs;")" "matched"

echo
echo "== 4f. MALFORMED REPLAY (never repaired, never completed one-sidedly) =="
seed_ok(){ reset; prop $A $B; call $A $B >/dev/null; }
badrep(){ seed_ok
  local PRE; PRE=$(snap)
  q "$2" >/dev/null
  local S0; S0=$(snap)
  # Guard: if the corruption did not actually change anything (e.g. a foreign key rejected it),
  # the scenario is vacuous and would "pass" while testing nothing. Fail loudly instead.
  if [ "$S0" == "$PRE" ]; then
    echo "  FAIL  $1 — corruption did not apply (scenario is vacuous)"; FAIL=$((FAIL+1)); return
  fi
  check "$1: invalid"         "$(call $A $B | out)" "invalid"
  check "$1: STATE IDENTICAL" "$(snap)" "$S0"
}
badrep "two materialized A->B, no B->A" "DELETE FROM public.batch_suggestions WHERE recipient_id='$B'; INSERT INTO public.batch_suggestions(batch_id,recipient_id,suggested_id,status,materialized_at) VALUES ('$RB','$A','$B','shown',now());"
badrep "one direction missing its intro_request" "DELETE FROM public.intro_requests WHERE requester_id='$B';"
badrep "duplicate live intro_requests" "INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id) SELECT requester_id,target_user_id,status,pair_id FROM public.intro_requests WHERE requester_id='$A';"
badrep "null pair_id" "UPDATE public.intro_requests SET pair_id=NULL WHERE requester_id='$A';"
# intro_requests.pair_id has a FOREIGN KEY to member_pairs(id), so a random uuid is REJECTED and
# the row stays valid. The reachable inconsistency is pointing at a different REAL pair row.
badrep "pair_id points at a DIFFERENT real member_pair" "INSERT INTO public.member_pairs(user_a_id,user_b_id,source) VALUES (LEAST('$C'::uuid,'$D'::uuid),GREATEST('$C'::uuid,'$D'::uuid),'admin'); UPDATE public.intro_requests SET pair_id=(SELECT id FROM public.member_pairs WHERE user_a_id=LEAST('$C'::uuid,'$D'::uuid));"
badrep "wrong member-level batch_id" "UPDATE public.intro_requests SET batch_id=(SELECT batch_id FROM public.recommendation_batches WHERE member_id='$B') WHERE requester_id='$A';"
# A DIFFERENT reciprocal_batch_id on the envelope is NOT an inconsistency — it is the legitimate
# reuse case (an envelope created by review X, appended to by review Y). Replay must still succeed;
# asserting invalid here is what the previous revision got wrong.
seed_ok
q "UPDATE public.recommendation_batches SET reciprocal_batch_id='33333333-0000-4000-8000-0000000000cc';" >/dev/null
S0=$(snap)
check "envelope stamped by ANOTHER review: replay still valid" "$(call $A $B | out)" "already_materialized"
check "and it performed zero writes"                           "$(snap)" "$S0"
# What DOES fail replay is a non-active envelope, or one owned by the wrong member/source.
badrep "envelope no longer active" "UPDATE public.recommendation_batches SET state='discarded' WHERE member_id='$A' AND state='active';"
seed_ok
check "correct replay (A,B)" "$(call $A $B | out)" "already_materialized"
check "correct replay (B,A)" "$(call $B $A | out)" "already_materialized"

echo
echo "== 4g. SHARED-MEMBER CONCURRENCY (two pairs, one common member) =="
reset; prop $A $B; prop $A $C
psql "$URL" -qAt -c "BEGIN; SELECT public.materialize_admin_pair('$RB'::uuid,'$A'::uuid,'$B'::uuid); SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 &
SP=$!
sleep 1
BLK=$(psql "$URL" -qAt -c "SET lock_timeout='700ms'; SELECT public.materialize_admin_pair('$RB'::uuid,'$A'::uuid,'$C'::uuid);" 2>&1 | grep -c "55P03\|lock timeout\|canceling statement")
check "a pair SHARING member A blocks on A's lock" "$BLK" "1"
wait $SP
check "exactly ONE active batch for A"     "$(q "SELECT count(*) FROM public.recommendation_batches WHERE member_id='$A' AND state='active';")" "1"
check "no unhandled unique violation"      "$(call $A $C | out)" "created"
check "STILL exactly one active batch"     "$(q "SELECT count(*) FROM public.recommendation_batches WHERE member_id='$A' AND state='active';")" "1"
check "A has 2 visible from two pairs"     "$(cards $A)" "2/0"

reset; prop $A $B
q "INSERT INTO public.introduction_batches(id,batch_number,week_start,week_end,status) VALUES ('44444444-0000-4000-8000-0000000000dd',2,current_date,current_date+6,'pending_review');" >/dev/null
q "$G VALUES ('44444444-0000-4000-8000-0000000000dd','$A','$C','r',80,'generated'),('44444444-0000-4000-8000-0000000000dd','$C','$A','r',80,'generated');" >/dev/null
call $A $B >/dev/null
# A's envelope was created by review #1 and still holds a live card. Review #2 REUSES it rather
# than refusing — the underfill fix — and never rewrites its reciprocal_batch_id.
check "different review batch -> REUSES the envelope" "$(q "SELECT public.materialize_admin_pair('44444444-0000-4000-8000-0000000000dd'::uuid,'$A'::uuid,'$C'::uuid);" | out)" "created"
check "still exactly ONE active batch for A" "$(q "SELECT count(*) FROM public.recommendation_batches WHERE member_id='$A' AND state='active';")" "1"
check "envelope keeps its ORIGINAL review stamp" "$(q "SELECT reciprocal_batch_id FROM public.recommendation_batches WHERE member_id='$A' AND state='active';")" "$RB"
check "A now holds 2 visible cards"          "$(cards $A)" "2/0"
check "per-card review origin still recoverable via batch_suggestions" "$(q "SELECT count(DISTINCT batch_id) FROM public.batch_suggestions WHERE recipient_id='$A' AND status='shown';")" "2"

echo
echo "== 4h. PARTIAL APPROVAL AND RETRY LIFECYCLE =="
reset; prop $A $B; prop $C $D
q "INSERT INTO public.intro_requests(requester_id,target_user_id,status) VALUES ('$C','$A','suggested'),('$C','$A','suggested');" >/dev/null
check "pair 1 materializes"                "$(call $A $B | out)" "created"
check "pair 2 refused for capacity"        "$(call $C $D | out)" "capacity"
check "successful pair is 'shown'"         "$(q "SELECT count(*) FROM public.batch_suggestions WHERE recipient_id IN ('$A','$B') AND status='shown' AND materialized_at IS NOT NULL;")" "2"
check "refused pair stays 'generated'"     "$(q "SELECT count(*) FROM public.batch_suggestions WHERE recipient_id IN ('$C','$D') AND status='generated' AND materialized_at IS NULL;")" "2"
check "retry does NOT rematerialize"       "$(call $A $B | out)" "already_materialized"
check "still exactly 2 live rows for A|B"  "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id IS NOT NULL;")" "2"
q "DELETE FROM public.intro_requests WHERE requester_id='$C' AND target_user_id='$A';" >/dev/null
check "capacity freed -> retry succeeds"   "$(call $C $D | out)" "created"
q "DELETE FROM public.introduction_batches WHERE id='$RB';" >/dev/null
check "review rows cascade away"           "$(q "SELECT count(*) FROM public.batch_suggestions;")" "0"
check "live cards SURVIVE deletion"        "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id IS NOT NULL;")" "4"
check "orphan rec batches remain"          "$(q "SELECT count(*) FROM public.recommendation_batches WHERE reciprocal_batch_id='$RB';")" "4"
check "no introduction_batches row remains" "$(q "SELECT count(*) FROM public.introduction_batches WHERE id='$RB';")" "0"

echo
echo "== 4i. MEMBER-BATCH (ENVELOPE) LIFECYCLE =="
env_state(){ q "SELECT coalesce(string_agg(state||':'||batch_source,',' ORDER BY state,batch_source),'none') FROM public.recommendation_batches WHERE member_id='$1';"; }
live_of(){ q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$1' AND status IN ('suggested','queued');"; }

# 1. no active envelope -> one is created, stamped with THIS review
reset; prop $A $B
check "no envelope: created"                 "$(call $A $B | out)" "created"
check "no envelope: exactly one active"      "$(q "SELECT count(*) FROM public.recommendation_batches WHERE member_id='$A' AND state='active';")" "1"
check "no envelope: stamped with this review" "$(q "SELECT reciprocal_batch_id FROM public.recommendation_batches WHERE member_id='$A' AND state='active';")" "$RB"

# 2. active admin envelope for the CURRENT review -> reused for a second pair
reset; prop $A $B; prop $A $C
call $A $B >/dev/null
check "current-review envelope reused"       "$(call $A $C | out)" "created"
check "still one active envelope"            "$(q "SELECT count(*) FROM public.recommendation_batches WHERE member_id='$A' AND state='active';")" "1"
check "both cards share the envelope"        "$(q "SELECT count(DISTINCT batch_id) FROM public.intro_requests WHERE requester_id='$A';")" "1"

# 3. active admin envelope from an OLDER review, ZERO live rows -> retired, fresh envelope created
reset; prop $A $B
q "INSERT INTO public.recommendation_batches(batch_id,member_id,batch_source,state,reciprocal_batch_id,created_at,generated_at,displayed_at) VALUES ('77777777-0000-4000-8000-00000000aaaa','$A','admin_reciprocal','active','33333333-0000-4000-8000-0000000000cc',now(),now(),now());" >/dev/null
check "stale old envelope: created"          "$(call $A $B | out)" "created"
check "old envelope RETIRED to completed"    "$(q "SELECT state FROM public.recommendation_batches WHERE batch_id='77777777-0000-4000-8000-00000000aaaa';")" "completed"
check "old envelope has completed_at"        "$(q "SELECT (completed_at IS NOT NULL)::text FROM public.recommendation_batches WHERE batch_id='77777777-0000-4000-8000-00000000aaaa';")" "true"
check "exactly one active envelope"          "$(q "SELECT count(*) FROM public.recommendation_batches WHERE member_id='$A' AND state='active';")" "1"
check "new envelope stamped with this review" "$(q "SELECT reciprocal_batch_id FROM public.recommendation_batches WHERE member_id='$A' AND state='active';")" "$RB"

# 4. active admin envelope from an OLDER review holding ONE live card -> REUSED, card untouched
reset; prop $A $B
q "INSERT INTO public.recommendation_batches(batch_id,member_id,batch_source,state,reciprocal_batch_id,created_at,generated_at,displayed_at) VALUES ('88888888-0000-4000-8000-00000000bbbb','$A','admin_reciprocal','active','33333333-0000-4000-8000-0000000000cc',now(),now(),now());" >/dev/null
q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,batch_id) VALUES ('$A','$D','suggested','88888888-0000-4000-8000-00000000bbbb');" >/dev/null
OLD=$(q "SELECT id||status||batch_id FROM public.intro_requests WHERE requester_id='$A';")
check "old envelope with a live card: created" "$(call $A $B | out)" "created"
check "old card UNCHANGED (id/status/batch)"   "$(q "SELECT id||status||batch_id FROM public.intro_requests WHERE requester_id='$A' AND target_user_id='$D';")" "$OLD"
check "old envelope keeps its ORIGINAL stamp"  "$(q "SELECT reciprocal_batch_id FROM public.recommendation_batches WHERE batch_id='88888888-0000-4000-8000-00000000bbbb';")" "33333333-0000-4000-8000-0000000000cc"
check "old envelope stays ACTIVE"              "$(q "SELECT state FROM public.recommendation_batches WHERE batch_id='88888888-0000-4000-8000-00000000bbbb';")" "active"
check "A now has 2 visible"                    "$(cards $A)" "2/0"
check "still exactly one active envelope"      "$(q "SELECT count(*) FROM public.recommendation_batches WHERE member_id='$A' AND state='active';")" "1"

# 5. active ONBOARDING envelope with a live card and a free visible slot -> refused, nothing touched
reset; prop $A $B
q "INSERT INTO public.recommendation_batches(batch_id,member_id,batch_source,state,created_at,generated_at,displayed_at) VALUES ('99999999-0000-4000-8000-00000000cccc','$A','onboarding','active',now(),now(),now());" >/dev/null
q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,batch_id) VALUES ('$A','$D','suggested','99999999-0000-4000-8000-00000000cccc');" >/dev/null
S0=$(snap)
check "live onboarding envelope -> capacity"   "$(call $A $B | out)" "capacity"
check "onboarding provenance untouched"        "$(q "SELECT batch_source||state FROM public.recommendation_batches WHERE batch_id='99999999-0000-4000-8000-00000000cccc';")" "onboardingactive"
check "STATE IDENTICAL"                        "$(snap)" "$S0"

# 6. active envelope whose cards are no longer live (all passed) -> stale, retired safely
reset; prop $A $B
q "INSERT INTO public.recommendation_batches(batch_id,member_id,batch_source,state,created_at,generated_at,displayed_at) VALUES ('aaaaaaa1-0000-4000-8000-00000000dddd','$A','weekly','active',now(),now(),now());" >/dev/null
q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,batch_id) VALUES ('$A','$D','passed','aaaaaaa1-0000-4000-8000-00000000dddd');" >/dev/null
check "resolved weekly envelope is stale: created" "$(call $A $B | out)" "created"
check "it was retired, not overwritten"        "$(q "SELECT state||batch_source FROM public.recommendation_batches WHERE batch_id='aaaaaaa1-0000-4000-8000-00000000dddd';")" "completedweekly"
check "the passed card is untouched"           "$(q "SELECT status FROM public.intro_requests WHERE requester_id='$A' AND target_user_id='$D';")" "passed"

# 7. member has BOTH active and queued envelopes -> queued untouched, one active maintained
reset; prop $A $B
q "INSERT INTO public.recommendation_batches(batch_id,member_id,batch_source,state,created_at,generated_at) VALUES ('bbbbbbb1-0000-4000-8000-00000000eeee','$A','weekly','queued',now(),now());" >/dev/null
q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,batch_id) VALUES ('$A','$D','queued','bbbbbbb1-0000-4000-8000-00000000eeee');" >/dev/null
check "queued envelope present: created"       "$(call $A $B | out)" "created"
check "queued envelope untouched"              "$(q "SELECT state||batch_source FROM public.recommendation_batches WHERE batch_id='bbbbbbb1-0000-4000-8000-00000000eeee';")" "queuedweekly"
check "queued card still queued"               "$(q "SELECT status FROM public.intro_requests WHERE requester_id='$A' AND target_user_id='$D';")" "queued"
check "exactly one active + one queued"        "$(q "SELECT count(*) FILTER (WHERE state='active')||'/'||count(*) FILTER (WHERE state='queued') FROM public.recommendation_batches WHERE member_id='$A';")" "1/1"

# 8. promotion still works after an admin pair, and cannot split the pair
reset; prop $A $B
q "INSERT INTO public.recommendation_batches(batch_id,member_id,batch_source,state,created_at,generated_at) VALUES ('ccccccc1-0000-4000-8000-00000000ffff','$A','weekly','queued',now(),now());" >/dev/null
q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,batch_id) VALUES ('$A','$D','queued','ccccccc1-0000-4000-8000-00000000ffff');" >/dev/null
call $A $B >/dev/null
q "UPDATE public.intro_requests SET status='passed' WHERE requester_id='$A' AND target_user_id='$B';" >/dev/null
q "SELECT public.promote_queued_rows('$A'::uuid);" >/dev/null
check "promotion left the admin pair intact"   "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id IS NOT NULL;")" "2"
check "no pair row was promoted from queued"   "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id IS NOT NULL AND status='queued';")" "0"
check "no member card was deleted"             "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$A';")" "2"

# no member card is ever deleted/archived/hidden by this RPC
reset; prop $A $B
q "INSERT INTO public.intro_requests(requester_id,target_user_id,status) VALUES ('$A','$D','suggested');" >/dev/null
BEFORE=$(q "SELECT count(*)||'/'||coalesce(string_agg(DISTINCT status,','),'-') FROM public.intro_requests;")
call $A $B >/dev/null
check "no existing card deleted or restatused" "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$A' AND target_user_id='$D' AND status='suggested';")" "1"

echo
echo "== 4j. REPLAY ACROSS REUSED ENVELOPES (review X envelope, review Y approval) =="
RY=44444444-0000-4000-8000-0000000000dd
mkreview(){ q "INSERT INTO public.introduction_batches(id,batch_number,week_start,week_end,status) VALUES ('$1',9,current_date,current_date+6,'pending_review');" >/dev/null; }
propY(){ q "INSERT INTO public.batch_suggestions(batch_id,recipient_id,suggested_id,reason,match_score,status)
            VALUES ('$RY','$1','$2','r',80.00,'generated'),('$RY','$2','$1','r',80.00,'generated');" >/dev/null; }
callY(){ q "SELECT public.materialize_admin_pair('$RY'::uuid,'$1'::uuid,'$2'::uuid);"; }
# seed a LIVE admin envelope for $1 stamped with an OLDER review X, holding one card to $2
oldenv(){ q "INSERT INTO public.recommendation_batches(batch_id,member_id,batch_source,state,reciprocal_batch_id,created_at,generated_at,displayed_at)
             VALUES ('$3','$1','admin_reciprocal','active','33333333-0000-4000-8000-0000000000cc',now(),now(),now());
             INSERT INTO public.intro_requests(requester_id,target_user_id,status,batch_id) VALUES ('$1','$2','suggested','$3');" >/dev/null; }

# 1. Both members get NEW envelopes from review Y; retry succeeds.
reset; mkreview $RY; propY $A $B
check "1. new envelopes: created"            "$(callY $A $B | out)" "created"
check "1. retry: already_materialized"       "$(callY $A $B | out)" "already_materialized"

# 2. A REUSES a live admin envelope from review X; B gets a new envelope from Y.
reset; mkreview $RY; propY $A $B
oldenv $A $D 'f1111111-0000-4000-8000-000000000001'
check "2. mixed envelopes: created"          "$(callY $A $B | out)" "created"
check "2. A reused the X envelope"           "$(q "SELECT batch_id FROM public.intro_requests WHERE requester_id='$A' AND target_user_id='$B';")" "f1111111-0000-4000-8000-000000000001"
check "2. RETRY: already_materialized"       "$(callY $A $B | out)" "already_materialized"
check "2. X envelope keeps its stamp"        "$(q "SELECT reciprocal_batch_id FROM public.recommendation_batches WHERE batch_id='f1111111-0000-4000-8000-000000000001';")" "33333333-0000-4000-8000-0000000000cc"

# 3. BOTH members reuse live admin envelopes from two DIFFERENT older reviews.
reset; mkreview $RY; propY $A $B
oldenv $A $D 'f2222222-0000-4000-8000-000000000002'
q "UPDATE public.recommendation_batches SET reciprocal_batch_id='11111111-0000-4000-8000-0000000000aa' WHERE batch_id='f2222222-0000-4000-8000-000000000002';" >/dev/null
oldenv $B $C 'f3333333-0000-4000-8000-000000000003'
check "3. two older envelopes: created"      "$(callY $A $B | out)" "created"
check "3. REPLAY succeeds"                   "$(callY $A $B | out)" "already_materialized"
check "3. replay in reverse arg order"       "$(callY $B $A | out)" "already_materialized"
# 4. original stamps unchanged
check "4. A envelope stamp unchanged"        "$(q "SELECT reciprocal_batch_id FROM public.recommendation_batches WHERE batch_id='f2222222-0000-4000-8000-000000000002';")" "11111111-0000-4000-8000-0000000000aa"
check "4. B envelope stamp unchanged"        "$(q "SELECT reciprocal_batch_id FROM public.recommendation_batches WHERE batch_id='f3333333-0000-4000-8000-000000000003';")" "33333333-0000-4000-8000-0000000000cc"
check "4. neither envelope reassigned"       "$(q "SELECT count(*) FROM public.recommendation_batches WHERE batch_id IN ('f2222222-0000-4000-8000-000000000002','f3333333-0000-4000-8000-000000000003') AND state='active';")" "2"

# 5. The CURRENT review's two batch_suggestions rows are what replay relies on.
check "5. exactly 2 materialized rows under Y" "$(q "SELECT count(*) FROM public.batch_suggestions WHERE batch_id='$RY' AND materialized_at IS NOT NULL;")" "2"
q "UPDATE public.batch_suggestions SET materialized_at=NULL, status='generated' WHERE batch_id='$RY' AND recipient_id='$B';" >/dev/null
check "5. one side unmaterialized -> invalid" "$(callY $A $B | out)" "invalid"
q "UPDATE public.batch_suggestions SET materialized_at=now(), status='shown' WHERE batch_id='$RY' AND recipient_id='$B';" >/dev/null
check "5. restored -> replay works again"     "$(callY $A $B | out)" "already_materialized"

# 6. A live row in an ONBOARDING/WEEKLY envelope fails replay validation.
reset; mkreview $RY; propY $A $B
callY $A $B >/dev/null
q "UPDATE public.recommendation_batches SET batch_source='weekly' WHERE member_id='$A' AND state='active';" >/dev/null
S0=$(snap)
check "6. weekly-source envelope -> invalid"  "$(callY $A $B | out)" "invalid"
check "6. zero writes"                        "$(snap)" "$S0"

# 7. A live row referencing ANOTHER member's envelope fails replay validation.
reset; mkreview $RY; propY $A $B
callY $A $B >/dev/null
q "UPDATE public.intro_requests SET batch_id=(SELECT batch_id FROM public.recommendation_batches WHERE member_id='$B' AND state='active') WHERE requester_id='$A';" >/dev/null
S0=$(snap)
check "7. foreign-owner envelope -> invalid"  "$(callY $A $B | out)" "invalid"
check "7. zero writes"                        "$(snap)" "$S0"

# 7b. A non-active (completed) envelope fails replay validation.
reset; mkreview $RY; propY $A $B
callY $A $B >/dev/null
q "UPDATE public.recommendation_batches SET state='completed' WHERE member_id='$A' AND state='active';" >/dev/null
S0=$(snap)
check "7b. completed envelope -> invalid"     "$(callY $A $B | out)" "invalid"
check "7b. zero writes"                       "$(snap)" "$S0"

# 8. Malformed / missing current-review proposal fails closed.
reset; mkreview $RY; propY $A $B
callY $A $B >/dev/null
q "DELETE FROM public.batch_suggestions WHERE batch_id='$RY' AND recipient_id='$B';" >/dev/null
S0=$(snap)
check "8. missing proposal -> invalid"        "$(callY $A $B | out)" "invalid"
check "8. zero writes"                        "$(snap)" "$S0"

# 9. Replay AFTER the review batch was deleted: documented, non-actionable, zero writes.
reset; mkreview $RY; propY $A $B
callY $A $B >/dev/null
q "DELETE FROM public.introduction_batches WHERE id='$RY';" >/dev/null
S0=$(snap)
R=$(callY $A $B)
check "9. deleted review -> invalid"          "$(echo "$R" | out)" "invalid"
check "9. detail names the cause"             "$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin).get('detail','-'))")" "review_batch_not_found"
check "9. zero writes"                        "$(snap)" "$S0"
check "9. live cards SURVIVED the deletion"   "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id IS NOT NULL;")" "2"
check "9. exact review provenance is GONE"    "$(q "SELECT count(*) FROM public.batch_suggestions WHERE batch_id='$RY';")" "0"
check "9. coarse provenance survives"         "$(q "SELECT source FROM public.member_pairs;")" "admin"

echo
echo "== 4k. A VALID REPLAY IS A PURE READ =="
reset; mkreview $RY; propY $A $B
callY $A $B >/dev/null
BEFORE_SNAP=$(snap)
BEFORE_PAIR=$(q "SELECT id::text||'|'||recommend_count::text||'|'||last_recommended_at::text||'|'||first_recommended_at::text||'|'||status FROM public.member_pairs;")
BEFORE_ENV=$(q "SELECT string_agg(batch_id::text||state||coalesce(reciprocal_batch_id::text,'-')||coalesce(displayed_at::text,'-'),',' ORDER BY batch_id) FROM public.recommendation_batches;")
R1=$(callY $A $B); R2=$(callY $B $A)
check "replay outcome (A,B)"                  "$(echo "$R1" | out)" "already_materialized"
check "replay outcome (B,A)"                  "$(echo "$R2" | out)" "already_materialized"
check "same canonical pair_id both ways"      "$(echo "$R1" | python3 -c "import sys,json;print(json.load(sys.stdin)['pair_id'])")" "$(echo "$R2" | python3 -c "import sys,json;print(json.load(sys.stdin)['pair_id'])")"
check "pair_id matches member_pairs"          "$(echo "$R1" | python3 -c "import sys,json;print(json.load(sys.stdin)['pair_id'])")" "$(q "SELECT id FROM public.member_pairs;")"
check "recommend_count NOT incremented"       "$(q "SELECT id::text||'|'||recommend_count::text||'|'||last_recommended_at::text||'|'||first_recommended_at::text||'|'||status FROM public.member_pairs;")" "$BEFORE_PAIR"
check "envelope never restamped/reassigned"   "$(q "SELECT string_agg(batch_id::text||state||coalesce(reciprocal_batch_id::text,'-')||coalesce(displayed_at::text,'-'),',' ORDER BY batch_id) FROM public.recommendation_batches;")" "$BEFORE_ENV"
check "COMPLETE STATE IDENTICAL after replay" "$(snap)" "$BEFORE_SNAP"

echo
echo "== 5. no shared tier -> capacity, ZERO inserts =="
reset; prop $A $B; seed_cards $A 2 2; seed_cards $B 2 0
BEFORE=$(q "SELECT count(*) FROM public.intro_requests;")
R=$(call $A $B)
check "outcome is capacity"                "$(echo "$R" | out)" "capacity"
check "row count unchanged"                "$(q "SELECT count(*) FROM public.intro_requests;")" "$BEFORE"
check "no pair row created"                "$(q "SELECT count(*) FROM public.member_pairs;")" "0"
check "review rows stay 'generated'"       "$(q "SELECT count(*) FROM public.batch_suggestions WHERE status='generated' AND materialized_at IS NULL;")" "2"

echo
echo "== 6. one side fails a gate -> NEITHER row =="
for gate in ineligible blocked already_matched same_company history cooldown; do
  reset; prop $A $B
  case $gate in
    ineligible)      q "UPDATE public.profiles SET matching_paused=true WHERE id='$B';" >/dev/null;;
    blocked)         q "INSERT INTO public.blocked_users(user_id,blocked_user_id) VALUES ('$B','$A');" >/dev/null;;
    already_matched) q "INSERT INTO public.matches(user_a_id,user_b_id) VALUES ('$A','$B');" >/dev/null;;
    same_company)    q "UPDATE public.profiles SET company='Acme, LLC' WHERE id='$A'; UPDATE public.profiles SET company='acme' WHERE id='$B';" >/dev/null;;
    history)         q "INSERT INTO public.intro_requests(requester_id,target_user_id,status) VALUES ('$B','$A','declined');" >/dev/null;;
    cooldown)        q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,updated_at) VALUES ('$B','$A','passed',now());" >/dev/null;;
  esac
  BEFORE=$(q "SELECT count(*) FROM public.intro_requests;")
  R=$(call $A $B)
  check "$gate: outcome"                   "$(echo "$R" | out)" "$gate"
  check "$gate: no rows written"           "$(q "SELECT count(*) FROM public.intro_requests;")" "$BEFORE"
  check "$gate: review rows re-approvable" "$(q "SELECT count(*) FROM public.batch_suggestions WHERE status='generated' AND materialized_at IS NULL;")" "2"
done

echo
echo "== 7. malformed input =="
reset; prop $A $B
check "self-pair rejected"                 "$(call $A $A | out)" "invalid"
check "self-pair wrote nothing"            "$(q "SELECT count(*) FROM public.intro_requests;")" "0"
reset
q "INSERT INTO public.batch_suggestions(batch_id,recipient_id,suggested_id,status) VALUES ('$RB','$A','$B','generated');" >/dev/null
check "asymmetric proposal rejected"       "$(call $A $B | out)" "invalid"
check "asymmetric wrote nothing"           "$(q "SELECT count(*) FROM public.intro_requests;")" "0"
reset; prop $A $B
check "unknown review batch rejected"      "$(q "SELECT public.materialize_admin_pair('22222222-0000-4000-8000-0000000000bb'::uuid,'$A'::uuid,'$B'::uuid);" | out)" "invalid"

echo
echo "== 8. concurrency (two real sessions) =="
reset; prop $A $B
# Session 1 opens a transaction, calls the RPC, and HOLDS the participant advisory locks.
psql "$URL" -qAt -c "BEGIN; SELECT public.materialize_admin_pair('$RB'::uuid,'$A'::uuid,'$B'::uuid); SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 &
S1=$!
sleep 1
# Session 2 tries the SAME pair with a short lock_timeout: it must BLOCK (55P03), not interleave.
BLOCKED=$(psql "$URL" -qAt -c "SET lock_timeout='700ms'; SELECT public.materialize_admin_pair('$RB'::uuid,'$A'::uuid,'$B'::uuid);" 2>&1 | grep -c "55P03\|lock timeout\|canceling statement")
check "same pair BLOCKS on the advisory lock" "$BLOCKED" "1"
# Control: a DIFFERENT, disjoint pair must NOT block, so the test cannot pass vacuously.
q "INSERT INTO public.batch_suggestions(batch_id,recipient_id,suggested_id,reason,match_score,status)
   VALUES ('$RB','$C','$D','r',80.00,'generated'),('$RB','$D','$C','r',80.00,'generated');" >/dev/null
CTRL=$(psql "$URL" -qAt -c "SET lock_timeout='700ms'; SELECT public.materialize_admin_pair('$RB'::uuid,'$C'::uuid,'$D'::uuid);" 2>&1 | out)
check "a DIFFERENT pair does NOT block (control)" "$CTRL" "created"
wait $S1
check "after commit: exactly 2 rows for A|B" "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id IN ('$A','$B') AND pair_id IS NOT NULL;")" "2"

echo
echo "== 9. rollback leaves nothing =="
reset; prop $A $B
psql "$URL" -qAt -c "BEGIN; SELECT public.materialize_admin_pair('$RB'::uuid,'$A'::uuid,'$B'::uuid); ROLLBACK;" >/dev/null 2>&1
check "no intro_requests after rollback"   "$(q "SELECT count(*) FROM public.intro_requests;")" "0"
check "no member_pairs after rollback"     "$(q "SELECT count(*) FROM public.member_pairs;")" "0"
check "no recommendation_batches"          "$(q "SELECT count(*) FROM public.recommendation_batches;")" "0"
check "review rows untouched"              "$(q "SELECT count(*) FROM public.batch_suggestions WHERE status='generated';")" "2"

echo
echo "== 10. deletion lifecycle =="
reset; prop $A $B; call $A $B >/dev/null
q "DELETE FROM public.introduction_batches WHERE id='$RB';" >/dev/null
check "review suggestions CASCADE away"    "$(q "SELECT count(*) FROM public.batch_suggestions;")" "0"
check "live member cards SURVIVE"          "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id IS NOT NULL;")" "2"
check "member_pairs survives"              "$(q "SELECT count(*) FROM public.member_pairs;")" "1"
check "recommendation_batches survives"    "$(q "SELECT count(*) FROM public.recommendation_batches;")" "2"

echo
echo "== 11. security posture =="
check "SECURITY DEFINER"                   "$(q "SELECT prosecdef FROM pg_proc WHERE proname='materialize_admin_pair';")" "t"
SP=$(q "SELECT coalesce(array_to_string(proconfig,','),'-') FROM pg_proc WHERE proname='materialize_admin_pair';")
check "search_path pinned to empty"        "$SP" 'search_path=""'
check "anon cannot execute"                "$(q "SELECT has_function_privilege('anon','public.materialize_admin_pair(uuid,uuid,uuid,uuid,uuid,integer)','EXECUTE');")" "f"
check "authenticated cannot execute"       "$(q "SELECT has_function_privilege('authenticated','public.materialize_admin_pair(uuid,uuid,uuid,uuid,uuid,integer)','EXECUTE');")" "f"
check "service_role CAN execute"           "$(q "SELECT has_function_privilege('service_role','public.materialize_admin_pair(uuid,uuid,uuid,uuid,uuid,integer)','EXECUTE');")" "t"
check "no identity in any returned message" "$(q "SELECT public.materialize_admin_pair('$RB'::uuid,'$A'::uuid,'$A'::uuid);" | grep -c "@example" )" "0"

echo
echo "== FINAL INVARIANTS =="
check "no one-sided row was ever created"  "$(q "SELECT count(*) FROM public.intro_requests l WHERE l.pair_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.intro_requests r WHERE r.requester_id=l.target_user_id AND r.target_user_id=l.requester_id);")" "0"
check "no member over visible capacity"    "$(q "SELECT count(*) FROM (SELECT requester_id FROM public.intro_requests WHERE status='suggested' GROUP BY requester_id HAVING count(*)>2) x;")" "0"
check "no member over reserved capacity"   "$(q "SELECT count(*) FROM (SELECT requester_id FROM public.intro_requests WHERE status='queued' GROUP BY requester_id HAVING count(*)>2) x;")" "0"

echo
echo "== RESULT: $PASS passed, $FAIL failed =="
[[ $FAIL -eq 0 ]] || exit 1
