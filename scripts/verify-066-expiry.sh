#!/usr/bin/env bash
#
# Migration 065/066 verification against a REAL, DISPOSABLE PostgreSQL.
#
# Static assertions cannot prove that two directional rows expire together, that a privately
# expressed interest blocks expiry, or that a concurrent second worker loses the claim. Only real
# sessions can.
#
# SAFETY. Refuses hosted Supabase URLs and any database not obviously disposable. It TRUNCATES.
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
q(){ psql "$URL" -qAt -c "$1" 2>&1; }
PASS=0; FAIL=0
check(){ if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; PASS=$((PASS+1));
         else echo "  FAIL  $1 — got [$2] want [$3]"; FAIL=$((FAIL+1)); fi; }
out(){ python3 -c "import sys,json;print(json.load(sys.stdin).get('outcome','-'))"; }

# ── Bootstrap ───────────────────────────────────────────────────────────────────────────────────
# Load order matters and was previously done by hand, which is not reproducible. The fixtures stand
# in for tables this repo does not own (profiles, matches, conversations, meeting_credits); the
# migrations under test are then applied on top. 066_fixture MUST precede migration 067, because
# 067 PART 1 ALTERs the delegate the fixture defines.
if [[ "${HARNESS_BOOTSTRAP:-0}" == "1" ]]; then
  echo "== bootstrap =="
  # 065 is loaded BEFORE the 066 fixture so the harness exercises the REAL reminder_deliveries
  # table (the fixture's CREATE ... IF NOT EXISTS then becomes a no-op). 068 is deliberately NOT
  # bootstrapped: section 17 applies it, which is what proves the transition and the post-068 state.
  for f in supabase/tests/063_fixture.sql \
           supabase/migrations/063_unified_introduction_capacity.sql \
           supabase/tests/064_fixture.sql \
           supabase/migrations/064_materialize_admin_pair.sql \
           supabase/migrations/065_reminder_deliveries.sql \
           supabase/tests/066_fixture.sql \
           supabase/migrations/066_expire_intro_pair.sql \
           supabase/migrations/067_finalize_mutual_match_atomic.sql \
           supabase/migrations/069_delivery_purposes_and_event_key.sql \
           supabase/migrations/070_introduction_email_outbox.sql \
           supabase/migrations/071_outbox_service_role_least_privilege.sql \
           supabase/migrations/072_credit_debit_ledger_and_admin_exemption.sql \
           supabase/migrations/073_credit_transactions_acl_correction.sql; do
    if ! psql "$URL" -qAt -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>/tmp/bootstrap.err; then
      echo "  BOOTSTRAP FAILED on $f"; sed -n '1,12p' /tmp/bootstrap.err; exit 2
    fi
    echo "  loaded $f"
  done
fi


reset(){
  q "SELECT public.t_reset066();" >/dev/null
  q "UPDATE public.profiles SET account_status='active',profile_complete=true,is_admin=false,
       is_test_account=false,matching_paused=false,location='NY' WHERE id IN ('$A','$B','$C','$D');" >/dev/null
}
# an OLD reciprocal pair: both rows 'suggested', created 20 days ago
mkpair(){
  q "INSERT INTO public.member_pairs(user_a_id,user_b_id,source,status)
     VALUES (LEAST('$1'::uuid,'$2'::uuid),GREATEST('$1'::uuid,'$2'::uuid),'reciprocal','${3:-active}');" >/dev/null
  q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id,created_at)
     SELECT '$1','$2','suggested',id, now()-interval '${4:-20 days}' FROM public.member_pairs
     WHERE user_a_id=LEAST('$1'::uuid,'$2'::uuid) AND user_b_id=GREATEST('$1'::uuid,'$2'::uuid);
     INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id,created_at)
     SELECT '$2','$1','suggested',id, now()-interval '${4:-20 days}' FROM public.member_pairs
     WHERE user_a_id=LEAST('$1'::uuid,'$2'::uuid) AND user_b_id=GREATEST('$1'::uuid,'$2'::uuid);" >/dev/null
}
pid(){ q "SELECT id FROM public.member_pairs WHERE user_a_id=LEAST('$1'::uuid,'$2'::uuid) AND user_b_id=GREATEST('$1'::uuid,'$2'::uuid);"; }
expire(){ q "SELECT public.expire_intro_pair('$1'::uuid, ${2:-14});"; }
snap(){ q "SELECT md5(coalesce(string_agg(x,'|' ORDER BY x),'')) FROM (
  SELECT 'ir:'||id::text||status||coalesce(expired_at::text,'-') AS x FROM public.intro_requests
  UNION ALL SELECT 'mp:'||id::text||coalesce(status,'-')||coalesce(last_recommended_at::text,'-') FROM public.member_pairs
) t;"; }

echo "== environment =="
q "SELECT 'server: ' || version();" | head -1

echo
echo "== 1. atomic two-sided expiry =="
reset; mkpair $A $B; P=$(pid $A $B)
q "UPDATE public.member_pairs SET last_recommended_at = now() - interval '20 days' WHERE id='$P';" >/dev/null
BEFORE_LR=$(q "SELECT last_recommended_at FROM public.member_pairs WHERE id='$P';")
check "outcome expired"                    "$(expire $P | out)" "expired"
check "BOTH rows expired"                  "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$P' AND status='expired';")" "2"
check "no row left suggested"              "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$P' AND status='suggested';")" "0"
check "expired_at stamped on both"         "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$P' AND expired_at IS NOT NULL;")" "2"
check "pair marked expired"                "$(q "SELECT status FROM public.member_pairs WHERE id='$P';")" "expired"
check "COOLDOWN PRESERVED (last_recommended_at unchanged)" "$(q "SELECT last_recommended_at FROM public.member_pairs WHERE id='$P';")" "$BEFORE_LR"
check "capacity released for A"            "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$A' AND status='suggested';")" "0"
check "capacity released for B"            "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$B' AND status='suggested';")" "0"

echo
echo "== 2. ONE-SIDED PRIVATE INTEREST closes BOTH sides, privacy-neutrally =="
# A expressed interest (A->B 'approved'); B never answered (B->A still 'suggested').
reset; mkpair $A $B; P=$(pid $A $B)
q "UPDATE public.intro_requests SET status='approved' WHERE pair_id='$P' AND requester_id='$A';" >/dev/null
R=$(expire $P)
check "outcome expired"                    "$(echo "$R" | out)" "expired"
check "case is one_sided_interest"         "$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin).get('case','-'))")" "one_sided_interest"
check "BOTH directions closed"             "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$P' AND status='expired';")" "2"
check "no row left suggested"              "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$P' AND status='suggested';")" "0"
check "no row left approved (pending capacity freed)" "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$P' AND status='approved';")" "0"
check "B capacity RELEASED"                "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$B' AND status='suggested';")" "0"
check "A capacity RELEASED"                "$(q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$A' AND status='suggested';")" "0"
check "terminal state is IDENTICAL on both sides (no asymmetry to read)" "$(q "SELECT count(DISTINCT status) FROM public.intro_requests WHERE pair_id='$P';")" "1"
check "NO match created"                   "$(q "SELECT count(*) FROM public.matches;")" "0"
check "retry is idempotent"                "$(expire $P | out)" "skipped"

echo
echo "== 2b. MUTUAL interest is NEVER pre-empted by expiry =="
reset; mkpair $A $B; P=$(pid $A $B)
q "UPDATE public.intro_requests SET status='approved' WHERE pair_id='$P';" >/dev/null
S0=$(snap)
R=$(expire $P)
check "outcome protected"                  "$(echo "$R" | out)" "protected"
check "detail mutual_pending"              "$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin).get('detail','-'))")" "mutual_pending"
check "STATE IDENTICAL — finalization still owns it" "$(snap)" "$S0"

echo
echo "== 2c. a legacy STANDALONE pending row (no pair_id) is untouched =="
reset; mkpair $A $B; P=$(pid $A $B)
q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,created_at) VALUES ('$A','$C','pending', now()-interval '90 days');" >/dev/null
expire $P >/dev/null
check "standalone pending survives"        "$(q "SELECT status FROM public.intro_requests WHERE requester_id='$A' AND target_user_id='$C';")" "pending"

echo "== 3. finalized match never expires =="
reset; mkpair $A $B; P=$(pid $A $B)
q "INSERT INTO public.matches(user_a_id,user_b_id) VALUES ('$A','$B');" >/dev/null
S0=$(snap)
check "outcome protected"                  "$(expire $P | out)" "protected"
check "STATE IDENTICAL"                    "$(snap)" "$S0"
reset; mkpair $A $B 'matched'; P=$(pid $A $B)
check "terminal pair status protected"     "$(expire $P | out)" "protected"

echo
echo "== 4. age and shape guards =="
reset; mkpair $A $B active '3 days'; P=$(pid $A $B)
S0=$(snap)
check "too young -> skipped"               "$(expire $P | out)" "skipped"
check "STATE IDENTICAL"                    "$(snap)" "$S0"
reset; mkpair $A $B; P=$(pid $A $B)
q "UPDATE public.intro_requests SET status='passed' WHERE pair_id='$P' AND requester_id='$A';" >/dev/null
S0=$(snap)
check "only one row open -> skipped"       "$(expire $P | out)" "skipped"
check "STATE IDENTICAL"                    "$(snap)" "$S0"
check "an explicit pass is a RESPONSE, not ghosting" "$(q "SELECT status FROM public.intro_requests WHERE pair_id='$P' AND requester_id='$A';")" "passed"

echo
echo "== 5. idempotent and unknown input =="
reset; mkpair $A $B; P=$(pid $A $B)
expire $P >/dev/null
check "second call -> skipped, no change"  "$(expire $P | out)" "skipped"
check "still exactly 2 expired rows"       "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$P' AND status='expired';")" "2"
check "unknown pair -> invalid"            "$(q "SELECT public.expire_intro_pair('11111111-0000-4000-8000-00000000ffff'::uuid);" | out)" "invalid"
check "null pair -> invalid"               "$(q "SELECT public.expire_intro_pair(NULL);" | out)" "invalid"

echo
echo "== 6. concurrency (two real sessions) =="
reset; mkpair $A $B; P=$(pid $A $B)
psql "$URL" -qAt -c "BEGIN; SELECT public.expire_intro_pair('$P'::uuid); SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 &
SP=$!
sleep 1
BLK=$(psql "$URL" -qAt -c "SET lock_timeout='700ms'; SELECT public.expire_intro_pair('$P'::uuid);" 2>&1 | grep -c "55P03\|lock timeout\|canceling statement")
check "same pair BLOCKS on the advisory lock" "$BLK" "1"
reset; mkpair $A $B; mkpair $B $C 2>/dev/null
P2=$(pid $B $C)
CTRL=$(psql "$URL" -qAt -c "SET lock_timeout='700ms'; SELECT public.expire_intro_pair('$P2'::uuid);" 2>&1 | out)
check "a DIFFERENT pair does NOT block (control)" "$CTRL" "expired"
wait $SP

echo
echo "== 7. rollback leaves nothing =="
reset; mkpair $A $B; P=$(pid $A $B)
S0=$(snap)
psql "$URL" -qAt -c "BEGIN; SELECT public.expire_intro_pair('$P'::uuid); ROLLBACK;" >/dev/null 2>&1
check "STATE IDENTICAL after rollback"     "$(snap)" "$S0"

echo
echo "== 8. reminder claim is concurrency-safe =="
reset
q "INSERT INTO public.reminder_deliveries(member_id,purpose,cycle_key,open_card_count) VALUES ('$A','wednesday_intro_reminder','2026-W34',2);" >/dev/null
DUP=$(q "INSERT INTO public.reminder_deliveries(member_id,purpose,cycle_key,open_card_count) VALUES ('$A','wednesday_intro_reminder','2026-W34',2);" | grep -c "duplicate key\|23505")
check "second claim same week REJECTED"    "$DUP" "1"
check "exactly one claim row"              "$(q "SELECT count(*) FROM public.reminder_deliveries WHERE member_id='$A';")" "1"
q "UPDATE public.reminder_deliveries SET status='failed' WHERE member_id='$A';" >/dev/null
RETRY=$(q "INSERT INTO public.reminder_deliveries(member_id,purpose,cycle_key,open_card_count) VALUES ('$A','wednesday_intro_reminder','2026-W34',2);" | grep -c "duplicate key\|23505")
check "a FAILED attempt is retryable"      "$RETRY" "0"
check "a different WEEK is allowed"        "$(q "INSERT INTO public.reminder_deliveries(member_id,purpose,cycle_key,open_card_count) VALUES ('$A','wednesday_intro_reminder','2026-W35',1);" | grep -c 'duplicate key\|23505')" "0"

echo
echo "== 9. security posture =="
check "expire_intro_pair SECURITY DEFINER" "$(q "SELECT prosecdef FROM pg_proc WHERE proname='expire_intro_pair';")" "t"
check "search_path pinned"                 "$(q "SELECT coalesce(array_to_string(proconfig,','),'-') FROM pg_proc WHERE proname='expire_intro_pair';")" 'search_path=""'
check "anon cannot execute"                "$(q "SELECT has_function_privilege('anon','public.expire_intro_pair(uuid,integer)','EXECUTE');")" "f"
check "authenticated cannot execute"       "$(q "SELECT has_function_privilege('authenticated','public.expire_intro_pair(uuid,integer)','EXECUTE');")" "f"
check "service_role CAN execute"           "$(q "SELECT has_function_privilege('service_role','public.expire_intro_pair(uuid,integer)','EXECUTE');")" "t"

echo
echo "== 10. EXPIRY vs MUTUAL FINALIZATION race, BOTH orderings =="
# Ordering 1: FINALIZATION FIRST. A match exists before expiry runs -> expiry must refuse.
reset; mkpair $A $B; P=$(pid $A $B)
q "UPDATE public.intro_requests SET status='approved' WHERE pair_id='$P';" >/dev/null
q "INSERT INTO public.matches(user_a_id,user_b_id) VALUES ('$A','$B');
   UPDATE public.member_pairs SET status='matched' WHERE id='$P';" >/dev/null
S0=$(snap)
check "finalization first -> expiry refuses"   "$(expire $P | out)" "protected"
check "the match is NOT overwritten"           "$(snap)" "$S0"
check "match still present"                    "$(q "SELECT count(*) FROM public.matches;")" "1"

# Ordering 2: EXPIRY FIRST. Both rows become 'expired'; a later finalization must NOT resurrect.
reset; mkpair $A $B; P=$(pid $A $B)
q "UPDATE public.intro_requests SET status='approved' WHERE pair_id='$P' AND requester_id='$A';" >/dev/null
expire $P >/dev/null
check "expiry first -> both expired"           "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$P' AND status='expired';")" "2"
# finalizeMutualMatch revalidates consent: 'expired' is in neither consent set, so no row qualifies.
check "no row qualifies as consent any more"   "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$P' AND status IN ('approved','accepted','pending');")" "0"
check "no match was created"                   "$(q "SELECT count(*) FROM public.matches;")" "0"

# Two REAL sessions on the same pair: the second must block on the advisory lock, not interleave.
reset; mkpair $A $B; P=$(pid $A $B)
psql "$URL" -qAt -c "BEGIN; SELECT public.expire_intro_pair('$P'::uuid); SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 &
SR=$!
sleep 1
RB=$(psql "$URL" -qAt -c "SET lock_timeout='700ms'; UPDATE public.intro_requests SET status='approved' WHERE pair_id='$P';" 2>&1 | grep -c "55P03\|lock timeout\|canceling statement")
wait $SR
check "a concurrent finalization write serialises on the pair rows" "$RB" "1"
check "after commit: exactly 2 expired rows, no half state" "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$P' AND status='expired';")" "2"

echo
echo "== 11. EXPIRY vs FINALIZATION — TWO GENUINE SESSIONS, both orderings =="
freset(){ q "SELECT public.t_reset067();" >/dev/null
  q "UPDATE public.profiles SET account_status='active',profile_complete=true,is_admin=false,
       is_test_account=false,matching_paused=false,location='NY' WHERE id IN ('$A','$B','$C','$D');" >/dev/null; }
mutual(){ mkpair $1 $2; local P; P=$(pid $1 $2)
  q "UPDATE public.intro_requests SET status='approved' WHERE pair_id='$P';" >/dev/null; echo "$P"; }
fin(){ q "SELECT public.finalize_mutual_match_atomic('$1'::uuid,'$2'::uuid,false);"; }

# 1. FINALIZATION locks first; expiry BLOCKS, then refuses after the commit.
freset; P=$(mutual $A $B)
psql "$URL" -qAt -c "BEGIN; SELECT public.finalize_mutual_match_atomic('$A'::uuid,'$B'::uuid,false); SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 &
S1=$!
sleep 1
BLK=$(psql "$URL" -qAt -c "SET lock_timeout='700ms'; SELECT public.expire_intro_pair('$P'::uuid);" 2>&1 | grep -c "55P03\|lock timeout\|canceling")
check "1. expiry BLOCKS behind finalization"      "$BLK" "1"
wait $S1
check "1. match was created"                      "$(q "SELECT count(*) FROM public.matches;")" "1"
check "1. expiry now REFUSES"                     "$(expire $P | out)" "protected"
check "1. no row was expired"                     "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$P' AND status='expired';")" "0"

# 2. EXPIRY locks first; finalization BLOCKS, then refuses after the commit.
freset; P=$(mutual $A $B)
q "UPDATE public.intro_requests SET status='suggested' WHERE pair_id='$P' AND requester_id='$B';" >/dev/null
psql "$URL" -qAt -c "BEGIN; SELECT public.expire_intro_pair('$P'::uuid); SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 &
S2=$!
sleep 1
BLK2=$(psql "$URL" -qAt -c "SET lock_timeout='700ms'; SELECT public.finalize_mutual_match_atomic('$A'::uuid,'$B'::uuid,false);" 2>&1 | grep -c "55P03\|lock timeout\|canceling")
check "2. finalization BLOCKS behind expiry"      "$BLK2" "1"
wait $S2
check "2. both rows expired"                      "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$P' AND status='expired';")" "2"
R=$(fin $A $B)
check "2. finalization now REFUSES"               "$(echo "$R" | out)" "not_consented"
check "2. NO match"                               "$(q "SELECT count(*) FROM public.matches;")" "0"
check "2. NO conversation"                        "$(q "SELECT count(*) FROM public.conversations;")" "0"
check "2. NO credit was charged"                  "$(q "SELECT count(*) FROM public.meeting_credits WHERE user_id IN ('$A','$B') AND free_credits <> 5;")" "0"

# 3. STALE READ: consent observed BEFORE expiry cannot authorise a match afterwards.
freset; P=$(mutual $A $B)
STALE=$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$P' AND status='approved';")
check "3. consent observed as mutual (the stale read)" "$STALE" "2"
q "UPDATE public.intro_requests SET status='suggested' WHERE pair_id='$P' AND requester_id='$B';" >/dev/null
expire $P >/dev/null
check "3. expiry committed first"                 "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$P' AND status='expired';")" "2"
check "3. the stale read CANNOT create a match"   "$(fin $A $B | out)" "not_consented"
check "3. still no match / conversation / charge" "$(q "SELECT (SELECT count(*) FROM public.matches)::text||'/'||(SELECT count(*) FROM public.conversations)::text||'/'||(SELECT count(*) FROM public.meeting_credits WHERE free_credits<>5)::text;")" "0/0/0"

# 4. Reverse stale read: pair observed live, then finalization wins; expiry cannot use it.
freset; P=$(mutual $A $B)
check "4. pair observed as expirable"             "$(q "SELECT count(*) FROM public.intro_requests WHERE pair_id='$P';")" "2"
check "4. finalization wins"                      "$(fin $A $B | out)" "finalized"
check "4. stale expiry REFUSES"                   "$(expire $P | out)" "protected"
check "4. match intact"                           "$(q "SELECT count(*) FROM public.matches;")" "1"

echo
echo "== 12. NO interleaving produces a forbidden combination =="
check "expired rows PLUS a match"                 "$(q "SELECT count(*) FROM public.intro_requests ir JOIN public.member_pairs mp ON mp.id=ir.pair_id JOIN public.matches m ON (m.user_a_id=mp.user_a_id AND m.user_b_id=mp.user_b_id) WHERE ir.status='expired';")" "0"
check "only ONE direction expired"                "$(q "SELECT count(*) FROM (SELECT pair_id FROM public.intro_requests WHERE pair_id IS NOT NULL GROUP BY pair_id HAVING count(*) FILTER (WHERE status='expired')=1 AND count(*)=2) x;")" "0"
check "conversation without a match"              "$(q "SELECT count(*) FROM public.conversations c LEFT JOIN public.matches m ON m.id=c.match_id WHERE m.id IS NULL;")" "0"
check "credit charged without a match"            "$(q "SELECT CASE WHEN (SELECT count(*) FROM public.matches)=0 AND (SELECT count(*) FROM public.meeting_credits WHERE free_credits<>5)>0 THEN 1 ELSE 0 END;")" "0"

echo
echo "== 13. retry idempotency and independent-pair concurrency =="
freset; P=$(mutual $A $B)
fin $A $B >/dev/null
check "retry finalization -> already_matched"     "$(fin $A $B | out)" "already_matched"
check "still exactly ONE match"                   "$(q "SELECT count(*) FROM public.matches;")" "1"
check "still exactly ONE conversation"            "$(q "SELECT count(*) FROM public.conversations;")" "1"
check "credits charged exactly once"              "$(q "SELECT count(*) FROM public.meeting_credits WHERE user_id IN ('$A','$B') AND free_credits=4;")" "2"
check "retry expiry on a matched pair -> protected" "$(expire $P | out)" "protected"

# Independent pairs must NOT be globally serialized.
freset; P1=$(mutual $A $B); mkpair $C $D 2>/dev/null || true
psql "$URL" -qAt -c "BEGIN; SELECT public.finalize_mutual_match_atomic('$A'::uuid,'$B'::uuid,false); SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 &
S3=$!
sleep 1
IND=$(psql "$URL" -qAt -c "SET lock_timeout='700ms'; SELECT public.expire_intro_pair('$(pid $C $D)'::uuid);" 2>&1 | grep -c "55P03\|lock timeout\|canceling")
check "an INDEPENDENT pair is NOT blocked"        "$IND" "0"
wait $S3

echo
echo "== 14. one-sided still expires privately; mutual still finalizes =="
freset; P=$(mkpair $A $B; pid $A $B)
q "UPDATE public.intro_requests SET status='approved' WHERE pair_id='$P' AND requester_id='$A';" >/dev/null
check "one-sided -> expired"                      "$(expire $P | out)" "expired"
check "both directions closed identically"        "$(q "SELECT count(DISTINCT status) FROM public.intro_requests WHERE pair_id='$P';")" "1"
check "no match from a one-sided close"           "$(q "SELECT count(*) FROM public.matches;")" "0"
freset; P=$(mutual $A $B)
check "mutual -> finalized normally"              "$(fin $A $B | out)" "finalized"
check "match + conversation created"              "$(q "SELECT (SELECT count(*) FROM public.matches)::text||'/'||(SELECT count(*) FROM public.conversations)::text;")" "1/1"

echo
echo "== 15. 067 security posture and consent rules =="
check "SECURITY DEFINER"                          "$(q "SELECT prosecdef FROM pg_proc WHERE proname='finalize_mutual_match_atomic';")" "t"
check "search_path pinned"                        "$(q "SELECT coalesce(array_to_string(proconfig,','),'-') FROM pg_proc WHERE proname='finalize_mutual_match_atomic';")" 'search_path=""'
check "anon cannot execute"                       "$(q "SELECT has_function_privilege('anon','public.finalize_mutual_match_atomic(uuid,uuid,boolean)','EXECUTE');")" "f"
check "authenticated cannot execute"              "$(q "SELECT has_function_privilege('authenticated','public.finalize_mutual_match_atomic(uuid,uuid,boolean)','EXECUTE');")" "f"
check "service_role CAN execute"                  "$(q "SELECT has_function_privilege('service_role','public.finalize_mutual_match_atomic(uuid,uuid,boolean)','EXECUTE');")" "t"
# admin action can never manufacture consent
freset; mkpair $A $B; P=$(pid $A $B)
q "UPDATE public.intro_requests SET status='admin_pending' WHERE pair_id='$P';" >/dev/null
check "admin_pending is NOT consent"              "$(fin $A $B | out)" "not_consented"
check "no match from an admin action"             "$(q "SELECT count(*) FROM public.matches;")" "0"

echo
echo "== 16. delegate contract: public.consume_credits_and_create_match =="
D3="public.consume_credits_and_create_match(uuid,uuid,boolean)"
dq(){ q "SELECT $1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname='consume_credits_and_create_match';"; }
check "exact argument signature"      "$(dq "pg_get_function_arguments(p.oid)")" "p_user_a uuid, p_user_b uuid, p_admin_facilitated boolean DEFAULT false"
check "exact result columns + order"  "$(dq "pg_get_function_result(p.oid)")"    "TABLE(match_id uuid, conversation_id uuid, error_code text)"
check "SECURITY DEFINER"              "$(dq "prosecdef")"                        "t"
check "VOLATILE"                      "$(dq "provolatile")"                      "v"
check "language plpgsql"              "$(dq "(SELECT lanname FROM pg_language l WHERE l.oid=p.prolang)")" "plpgsql"
check "PUBLIC cannot execute"         "$(q "SELECT has_function_privilege('public','$D3','EXECUTE');")" "f"
check "anon cannot execute"           "$(q "SELECT has_function_privilege('anon','$D3','EXECUTE');")"   "f"
check "authenticated cannot execute"  "$(q "SELECT has_function_privilege('authenticated','$D3','EXECUTE');")" "f"
check "search_path is EMPTY"          "$(dq "coalesce(array_to_string(proconfig,','),'-')")" 'search_path=""'

# The whole point of search_path='' is that every non-built-in name must be qualified. Prove it on
# the DEPLOYED body (prosrc), not on the migration text, with comments stripped first.
STRIP="regexp_replace(prosrc, '--[^\n]*', '', 'g')"
QUAL="regexp_replace($STRIP, 'public\.(meeting_credits|matches|conversations)', '', 'g')"
check "meeting_credits is qualified"  "$(dq "($STRIP ~ 'public\.meeting_credits')::text")" "true"
check "matches is qualified"          "$(dq "($STRIP ~ 'public\.matches')::text")"         "true"
check "conversations is qualified"    "$(dq "($STRIP ~ 'public\.conversations')::text")"    "true"
check "NO unqualified reference left" "$(dq "($QUAL ~ '\m(meeting_credits|matches|conversations)\M')::text")" "false"
check "balance recalculated, not decremented" "$(dq "($STRIP ~ 'balance = \(free_credits - 1\) \+ COALESCE\(premium_credits, 0\)')::text")" "true"
check "free-credit-only spend policy kept"    "$(dq "($STRIP ~ 'free_credits >= 1')::text")" "true"

cred(){ q "SELECT free_credits FROM public.meeting_credits WHERE user_id='$1';"; }
del(){ q "SELECT coalesce(error_code,'ok') FROM public.consume_credits_and_create_match('$1'::uuid,'$2'::uuid,false);"; }

freset
R=$(del $A $B)
check "  success returns no error"    "$R" "ok"
check "  A charged exactly one"       "$(cred $A)" "4"
check "  B charged exactly one"       "$(cred $B)" "4"
check "  exactly one match"           "$(q "SELECT count(*) FROM public.matches;")" "1"
check "  exactly one conversation"    "$(q "SELECT count(*) FROM public.conversations;")" "1"

freset
q "UPDATE public.meeting_credits SET free_credits=0 WHERE user_id='$A';" >/dev/null
check "A broke -> insufficient_credits_a" "$(del $A $B)" "insufficient_credits_a"
check "  B was NOT charged"               "$(cred $B)" "5"
check "  no match written"                "$(q "SELECT count(*) FROM public.matches;")" "0"

freset
q "UPDATE public.meeting_credits SET free_credits=0 WHERE user_id='$B';" >/dev/null
check "B broke -> insufficient_credits_b" "$(del $A $B)" "insufficient_credits_b"
check "  A deduction ROLLED BACK"         "$(cred $A)" "5"
check "  no match written"                "$(q "SELECT count(*) FROM public.matches;")" "0"
check "  no conversation written"         "$(q "SELECT count(*) FROM public.conversations;")" "0"

freset
q "INSERT INTO public.matches(user_a_id,user_b_id) VALUES (LEAST('$A'::uuid,'$B'::uuid),GREATEST('$A'::uuid,'$B'::uuid));" >/dev/null
check "duplicate -> duplicate_match"      "$(del $A $B)" "duplicate_match"
check "  NEITHER member charged"          "$(q "SELECT count(*) FROM public.meeting_credits WHERE user_id IN ('$A','$B') AND free_credits<>5;")" "0"
check "  no second match"                 "$(q "SELECT count(*) FROM public.matches;")" "1"

freset
check "wrapper refuses a self-pair"       "$(fin $A $A | out)" "invalid"
check "  self-pair wrote nothing"         "$(q "SELECT count(*) FROM public.matches;")" "0"

echo "== FINAL INVARIANTS =="
check "no pair left in a MIXED terminal/live state" "$(q "SELECT count(*) FROM (SELECT pair_id FROM public.intro_requests WHERE pair_id IS NOT NULL GROUP BY pair_id HAVING count(*) FILTER (WHERE status='expired') > 0 AND count(*) FILTER (WHERE status IN ('suggested','approved','accepted','pending')) > 0) x;")" "0"
check "no notification table was written"  "$(q "SELECT count(*) FROM information_schema.tables WHERE table_name='notifications';")" "0"

echo
echo "== 17. after migration 068 (applied LAST - it drops a privilege for good) =="
freset; mkpair $A $B; P=$(pid $A $B)
q "UPDATE public.intro_requests SET status='approved' WHERE pair_id='$P';" >/dev/null
# 068 removes a privilege PERMANENTLY, so this precondition only holds on a freshly bootstrapped
# database. On a re-run against the same disposable DB it is already gone — which is the correct
# post-068 state, not a regression. It is never re-granted here: restoring service_role EXECUTE on
# the raw delegate is exactly what must not happen.
if [[ "${HARNESS_BOOTSTRAP:-0}" == "1" ]]; then
  check "before 068: service_role CAN reach delegate" "$(q "SELECT has_function_privilege('service_role','$D3','EXECUTE');")" "t"
else
  echo "  SKIP  before 068 precondition (re-run against an already-migrated DB)"
fi
psql "$URL" -qAt -v ON_ERROR_STOP=1 -f supabase/migrations/068_revoke_raw_delegate_service_role.sql >/dev/null 2>&1 \
  && echo "  (068 applied)" || { echo "  FAIL  068 would not apply"; FAIL=$((FAIL+1)); }
check "delegate: PUBLIC cannot execute"        "$(q "SELECT has_function_privilege('public','$D3','EXECUTE');")" "f"
check "delegate: anon cannot execute"          "$(q "SELECT has_function_privilege('anon','$D3','EXECUTE');")" "f"
check "delegate: authenticated cannot execute" "$(q "SELECT has_function_privilege('authenticated','$D3','EXECUTE');")" "f"
check "delegate: service_role cannot execute"  "$(q "SELECT has_function_privilege('service_role','$D3','EXECUTE');")" "f"
check "wrapper: service_role CAN execute"      "$(q "SELECT has_function_privilege('service_role','public.finalize_mutual_match_atomic(uuid,uuid,boolean)','EXECUTE');")" "t"
check "wrapper: anon cannot execute"           "$(q "SELECT has_function_privilege('anon','public.finalize_mutual_match_atomic(uuid,uuid,boolean)','EXECUTE');")" "f"
# the direct path is severed for the role the application actually uses...
check "direct delegate call is DENIED"         "$(q "SET ROLE service_role; SELECT * FROM public.consume_credits_and_create_match('$A'::uuid,'$B'::uuid,false);" | grep -c 'permission denied')" "1"
# ...while the wrapper, SECURITY DEFINER owned by the delegate's owner, still works.
check "wrapper still finalizes as service_role" "$(q "SET ROLE service_role; SELECT public.finalize_mutual_match_atomic('$A'::uuid,'$B'::uuid,false);" | out)" "finalized"
check "  exactly one match"                     "$(q "SELECT count(*) FROM public.matches;")" "1"
check "  exactly one conversation"              "$(q "SELECT count(*) FROM public.conversations;")" "1"
check "  both members charged once"             "$(q "SELECT count(*) FROM public.meeting_credits WHERE user_id IN ('$A','$B') AND free_credits=4;")" "2"
check "  balance invariant holds"               "$(q "SELECT count(*) FROM public.meeting_credits WHERE balance <> free_credits + coalesce(premium_credits,0);")" "0"

echo
echo "== 18. migration 070: the transactional outbox trigger =="
OB="public.introduction_email_outbox"
ob(){ q "SELECT count(*) FROM $OB ${1:-};"; }
obreset(){ q "TRUNCATE $OB CASCADE; DELETE FROM public.intro_requests;" >/dev/null; }
mkcard(){ q "INSERT INTO public.intro_requests(id,requester_id,target_user_id,status,created_at)
             VALUES ('$1'::uuid,'$2'::uuid,'$3'::uuid,'$4',now());" >/dev/null; }
C1=11111111-0000-4000-8000-00000000ca01
C2=11111111-0000-4000-8000-00000000ca02

# the card and its outbox event are written by the SAME transaction
obreset; mkcard $C1 $A $B suggested
check "INSERT suggested -> exactly one event"      "$(ob "WHERE intro_request_id='$C1'")" "1"
check "  event names the card OWNER"               "$(q "SELECT member_id='$A' FROM $OB WHERE intro_request_id='$C1';")" "t"
check "  event starts pending"                     "$(q "SELECT status FROM $OB WHERE intro_request_id='$C1';")" "pending"

obreset; mkcard $C1 $A $B queued
check "INSERT queued -> no event"                  "$(ob)" "0"
q "UPDATE public.intro_requests SET status='suggested' WHERE id='$C1';" >/dev/null
check "queued -> suggested -> exactly one event"   "$(ob)" "1"
q "UPDATE public.intro_requests SET status='suggested', updated_at=now() WHERE id='$C1';" >/dev/null
check "suggested -> suggested -> still one event"  "$(ob)" "1"
q "UPDATE public.intro_requests SET status='expired' WHERE id='$C1';" >/dev/null
check "suggested -> expired -> still one event"    "$(ob)" "1"
q "UPDATE public.intro_requests SET status='suggested' WHERE id='$C1';" >/dev/null
check "re-visibility cannot duplicate the event"   "$(ob)" "1"

# every non-visible status is silent
obreset
for st in queued pending approved accepted admin_pending passed declined rejected expired archived hidden; do
  q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,created_at)
     VALUES ('$A'::uuid,'$B'::uuid,'$st',now());" >/dev/null
done
check "no non-visible status enqueues"             "$(ob)" "0"

# ROLLBACK: neither the card nor the event survives
obreset
psql "$URL" -qAt -c "BEGIN; INSERT INTO public.intro_requests(id,requester_id,target_user_id,status,created_at)
  VALUES ('$C2'::uuid,'$A'::uuid,'$B'::uuid,'suggested',now()); ROLLBACK;" >/dev/null 2>&1
check "rollback leaves no card"                    "$(q "SELECT count(*) FROM public.intro_requests WHERE id='$C2';")" "0"
check "rollback leaves no event"                   "$(ob)" "0"

# a row that existed BEFORE the trigger produces nothing — modelled by disabling it, which is
# exactly the state production's 188 historical cards were written in.
obreset
q "ALTER TABLE public.intro_requests DISABLE TRIGGER intro_requests_visible_outbox_aiu;" >/dev/null
mkcard $C1 $A $B suggested
q "ALTER TABLE public.intro_requests ENABLE TRIGGER intro_requests_visible_outbox_aiu;" >/dev/null
check "historical card -> NO event (no blast)"     "$(ob)" "0"
q "UPDATE public.intro_requests SET updated_at=now() WHERE id='$C1';" >/dev/null
check "  touching it later still enqueues nothing" "$(ob)" "0"

# reciprocal shape: both directions -> one event each, so both members are announced
obreset
q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,created_at)
   VALUES ('$A'::uuid,'$B'::uuid,'suggested',now()),('$B'::uuid,'$A'::uuid,'suggested',now());" >/dev/null
check "reciprocal pair -> one event per member"    "$(ob)" "2"
check "  distinct members"                         "$(q "SELECT count(DISTINCT member_id) FROM $OB;")" "2"

echo "-- 070 security posture --"
check "outbox: RLS enabled"                        "$(q "SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('$OB');")" "t"
check "outbox: ZERO policies"                      "$(q "SELECT count(*) FROM pg_policy WHERE polrelid=to_regclass('$OB');")" "0"
check "outbox: anon has no privilege"              "$(q "SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='introduction_email_outbox' AND grantee='anon';")" "0"
check "outbox: authenticated has no privilege"     "$(q "SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='introduction_email_outbox' AND grantee='authenticated';")" "0"
check "outbox: PUBLIC has no privilege"            "$(q "SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='introduction_email_outbox' AND grantee='PUBLIC';")" "0"
check "outbox: service_role can read/write"        "$(q "SELECT has_table_privilege('service_role','$OB','SELECT') AND has_table_privilege('service_role','$OB','INSERT') AND has_table_privilege('service_role','$OB','UPDATE');")" "t"
TF="public.tg_intro_request_visible_outbox()"
check "trigger fn: SECURITY DEFINER"               "$(q "SELECT prosecdef FROM pg_proc WHERE proname='tg_intro_request_visible_outbox';")" "t"
check "trigger fn: search_path empty"              "$(q "SELECT coalesce(array_to_string(proconfig,','),'-') FROM pg_proc WHERE proname='tg_intro_request_visible_outbox';")" 'search_path=""'
check "trigger fn: fully schema-qualified"         "$(q "SELECT (regexp_replace(regexp_replace(prosrc,'--[^\n]*','','g'),'public\.(introduction_email_outbox|intro_requests)','','g') ~ '\m(introduction_email_outbox|intro_requests)\M')::text FROM pg_proc WHERE proname='tg_intro_request_visible_outbox';")" "false"
check "trigger fn: anon cannot execute"            "$(q "SELECT has_function_privilege('anon','$TF','EXECUTE');")" "f"
check "trigger fn: PUBLIC cannot execute"          "$(q "SELECT has_function_privilege('public','$TF','EXECUTE');")" "f"
check "outbox stores no body/name/address"         "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='introduction_email_outbox' AND column_name IN ('email','full_name','subject','html','body','provider_payload','first_name');")" "0"

echo "-- 069: purposes widened without ever rejecting the LIVE one --"
check "wednesday purpose still accepted"           "$(q "SELECT count(*) FROM pg_constraint WHERE conname='reminder_deliveries_purpose_check' AND pg_get_constraintdef(oid) LIKE '%wednesday_intro_reminder%';")" "1"
check "catchup purpose accepted"                   "$(q "SELECT count(*) FROM pg_constraint WHERE conname='reminder_deliveries_purpose_check' AND pg_get_constraintdef(oid) LIKE '%catchup_unanswered_2026_08_20%';")" "1"
check "new_introductions purpose accepted"         "$(q "SELECT count(*) FROM pg_constraint WHERE conname='reminder_deliveries_purpose_check' AND pg_get_constraintdef(oid) LIKE '%new_introductions%';")" "1"
check "week claim now excludes event-keyed rows"   "$(q "SELECT count(*) FROM pg_indexes WHERE indexname='reminder_deliveries_active_claim_uniq' AND indexdef LIKE '%event_key IS NULL%';")" "1"
check "event claim index exists"                   "$(q "SELECT count(*) FROM pg_indexes WHERE indexname='reminder_deliveries_event_claim_uniq';")" "1"
# two deliveries in the SAME week must both be claimable when the artifacts differ
q "TRUNCATE public.reminder_deliveries;" >/dev/null
q "INSERT INTO public.reminder_deliveries(member_id,purpose,cycle_key,event_key,status)
   VALUES ('$A'::uuid,'new_introductions','2026-W34','key-one','accepted');" >/dev/null
INS2=$(q "INSERT INTO public.reminder_deliveries(member_id,purpose,cycle_key,event_key,status)
   VALUES ('$A'::uuid,'new_introductions','2026-W34','key-two','claimed');" 2>&1 | grep -c "ERROR")
check "same week, different artifact -> allowed"   "$INS2" "0"
DUP=$(q "INSERT INTO public.reminder_deliveries(member_id,purpose,cycle_key,event_key,status)
   VALUES ('$A'::uuid,'new_introductions','2026-W34','key-one','claimed');" 2>&1 | grep -c "duplicate key")
check "same artifact twice -> blocked"             "$DUP" "1"
q "TRUNCATE public.reminder_deliveries;" >/dev/null

echo "-- post-068 privilege state is NOT restored by 069/070 --"
check "069 grants nothing on the raw delegate"     "$(grep -c 'consume_credits_and_create_match' supabase/migrations/069_delivery_purposes_and_event_key.sql)" "0"
check "070 never GRANTs on the raw delegate"       "$(grep -c 'GRANT.*consume_credits_and_create_match' supabase/migrations/070_introduction_email_outbox.sql)" "0"

echo
echo "== 19. outbox claim protocol, TWO REAL SESSIONS =="
CLAIM_SQL="UPDATE $OB SET status='claimed', claim_token=gen_random_uuid(), claimed_at=now(),
             claim_expires_at=now()+interval '15 minutes', updated_at=now()
           WHERE id=(SELECT id FROM $OB WHERE intro_request_id='%s')
             AND (status='pending' OR (status='claimed' AND claim_expires_at < now()))
           RETURNING id;"

obreset; mkcard $C1 $A $B suggested
check "trigger produced one pending event"        "$(q "SELECT status FROM $OB WHERE intro_request_id='$C1';")" "pending"

# Session A takes the claim and HOLDS the transaction open. Session B must not be able to take it.
psql "$URL" -qAt -c "BEGIN; $(printf "$CLAIM_SQL" "$C1") SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 &
sleep 1
B_ROWS=$(psql "$URL" -qAt -c "$(printf "$CLAIM_SQL" "$C1")" 2>&1 | grep -c "^[0-9a-f-]\{36\}$")
wait
check "B cannot steal A's FRESH claim"            "$B_ROWS" "0"
check "  the row is claimed exactly once"         "$(q "SELECT count(*) FROM $OB WHERE status='claimed' AND claim_token IS NOT NULL;")" "1"
A_TOKEN=$(q "SELECT claim_token FROM $OB WHERE intro_request_id='$C1';")

# A stale worker must not be able to settle a row someone else legitimately reclaimed.
# Age the lease. claimed_at must move too, or lease_order_chk correctly rejects the update — the
# constraint does not permit an expiry that precedes its own start.
q "UPDATE $OB SET claimed_at = now() - interval '20 minutes', claim_expires_at = now() - interval '5 minutes'
   WHERE intro_request_id='$C1';" >/dev/null
B2=$(psql "$URL" -qAt -c "$(printf "$CLAIM_SQL" "$C1")" 2>&1 | grep -c "^[0-9a-f-]\{36\}$")
check "B DOES reclaim once the lease expired"     "$B2" "1"
NEW_TOKEN=$(q "SELECT claim_token FROM $OB WHERE intro_request_id='$C1';")
check "  reclaim minted a NEW token"              "$([[ "$A_TOKEN" != "$NEW_TOKEN" ]] && echo yes || echo no)" "yes"
STALE=$(q "WITH u AS (UPDATE $OB SET status='sent', processed_at=now(), claim_token=NULL, claimed_at=NULL, claim_expires_at=NULL
             WHERE intro_request_id='$C1' AND status='claimed' AND claim_token='$A_TOKEN'::uuid RETURNING 1)
           SELECT count(*) FROM u;")
check "stale A CANNOT settle after B reclaimed"   "$STALE" "0"
check "  the row still belongs to B"              "$(q "SELECT status FROM $OB WHERE intro_request_id='$C1';")" "claimed"
OWNED=$(q "WITH u AS (UPDATE $OB SET status='sent', processed_at=now(), claim_token=NULL, claimed_at=NULL, claim_expires_at=NULL
             WHERE intro_request_id='$C1' AND status='claimed' AND claim_token='$NEW_TOKEN'::uuid RETURNING 1)
           SELECT count(*) FROM u;")
check "the OWNER can settle"                      "$OWNED" "1"
check "  settled row cleared its lease"           "$(q "SELECT claim_token IS NULL AND claim_expires_at IS NULL FROM $OB WHERE intro_request_id='$C1';")" "t"

echo "-- 070 integrity constraints --"
obreset; mkcard $C1 $A $B suggested
EID=$(q "SELECT id FROM $OB WHERE intro_request_id='$C1';")
BAD1=$(q "UPDATE $OB SET status='claimed' WHERE id='$EID';" 2>&1 | grep -c "claim_shape_chk")
check "claimed WITHOUT a lease is rejected"       "$BAD1" "1"
BAD2=$(q "UPDATE $OB SET status='sent' WHERE id='$EID';" 2>&1 | grep -c "processed_shape_chk")
check "terminal WITHOUT processed_at is rejected" "$BAD2" "1"
BAD3=$(q "UPDATE $OB SET status='claimed', claim_token=gen_random_uuid(), claimed_at=now(), claim_expires_at=now()-interval '1 hour' WHERE id='$EID';" 2>&1 | grep -c "lease_order_chk")
check "a lease ending before it starts rejected"  "$BAD3" "1"
BAD4=$(q "INSERT INTO $OB (intro_request_id, member_id) VALUES ('$C1'::uuid,'$A'::uuid);" 2>&1 | grep -c "duplicate key")
check "duplicate event for one card rejected"     "$BAD4" "1"
check "pending-selection index exists"            "$(q "SELECT count(*) FROM pg_indexes WHERE indexname='introduction_email_outbox_pending_idx' AND indexdef LIKE '%status = ''pending''%';")" "1"
check "stale-claim index exists"                  "$(q "SELECT count(*) FROM pg_indexes WHERE indexname='introduction_email_outbox_stale_claim_idx' AND indexdef LIKE '%claim_expires_at%';")" "1"
check "claim/lease/processed CHECKs all present"  "$(q "SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('$OB') AND contype='c' AND conname LIKE '%_chk';")" "3"
check "070 inserted no outbox row at apply time"  "$(q "SELECT count(*) FROM $OB WHERE created_at < (SELECT min(created_at) FROM public.intro_requests);")" "0"
obreset

echo
echo "== 20. migration 071: outbox least privilege =="
check "service_role: SELECT"                      "$(q "SELECT has_table_privilege('service_role','$OB','SELECT');")" "t"
check "service_role: INSERT"                      "$(q "SELECT has_table_privilege('service_role','$OB','INSERT');")" "t"
check "service_role: UPDATE"                      "$(q "SELECT has_table_privilege('service_role','$OB','UPDATE');")" "t"
check "service_role: DELETE denied"               "$(q "SELECT has_table_privilege('service_role','$OB','DELETE');")" "f"
check "service_role: TRUNCATE denied"             "$(q "SELECT has_table_privilege('service_role','$OB','TRUNCATE');")" "f"

# THE REAL DEFECT, REPRODUCED. A plain local cluster has no Supabase default privileges, so the
# outbox is created here WITHOUT the inherited DELETE grant that production got - which is exactly
# why the local harness passed while production was wrong. Grant it explicitly to recreate the
# production condition, then prove 071 actually removes it.
q "GRANT DELETE ON TABLE $OB TO service_role;" >/dev/null
check "reproduced: DELETE wrongly present"        "$(q "SELECT has_table_privilege('service_role','$OB','DELETE');")" "t"
# a NARROW GRANT alone cannot fix it - this is the 070 mistake, demonstrated
q "GRANT SELECT, INSERT, UPDATE ON TABLE $OB TO service_role;" >/dev/null
check "a narrow GRANT does NOT remove DELETE"     "$(q "SELECT has_table_privilege('service_role','$OB','DELETE');")" "t"
# 071 does
psql "$URL" -qAt -v ON_ERROR_STOP=1 -f supabase/migrations/071_outbox_service_role_least_privilege.sql >/dev/null 2>&1 \
  && echo "  (071 re-applied)" || { echo "  FAIL  071 would not apply"; FAIL=$((FAIL+1)); }
check "071 removed DELETE"                        "$(q "SELECT has_table_privilege('service_role','$OB','DELETE');")" "f"
check "071 preserved SELECT/INSERT/UPDATE"        "$(q "SELECT has_table_privilege('service_role','$OB','SELECT') AND has_table_privilege('service_role','$OB','INSERT') AND has_table_privilege('service_role','$OB','UPDATE');")" "t"
check "071 is idempotent (re-applies cleanly)"    "$(psql "$URL" -qAt -v ON_ERROR_STOP=1 -f supabase/migrations/071_outbox_service_role_least_privilege.sql >/dev/null 2>&1 && echo ok || echo fail)" "ok"
check "071 granted browser roles nothing"         "$(q "SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='introduction_email_outbox' AND grantee IN ('anon','authenticated','PUBLIC');")" "0"
# the guard must REFUSE a database that does not match the contract
q "GRANT DELETE ON TABLE $OB TO service_role;" >/dev/null
GUARD=$(psql "$URL" -qAt -c "DO \$g\$ BEGIN IF has_table_privilege('service_role','$OB','DELETE') THEN RAISE EXCEPTION 'contract mismatch'; END IF; END \$g\$;" 2>&1 | grep -c "contract mismatch")
check "the contract guard fires on a mismatch"    "$GUARD" "1"
psql "$URL" -qAt -v ON_ERROR_STOP=1 -f supabase/migrations/071_outbox_service_role_least_privilege.sql >/dev/null 2>&1
check "restored to the required contract"         "$(q "SELECT has_table_privilege('service_role','$OB','DELETE');")" "f"

echo
echo "== 21. migration 072: chargeability, debits and the ledger =="
CT="public.credit_transactions"
creset(){ q "SELECT public.t_reset067();" >/dev/null
          q "UPDATE public.profiles SET is_admin=false WHERE id IN ('$A','$B','$C','$D');" >/dev/null; }
cred(){ q "SELECT free_credits FROM public.meeting_credits WHERE user_id='$1';"; }
debits(){ q "SELECT count(*) FROM $CT WHERE source_kind='match_debit';"; }
exempts(){ q "SELECT count(*) FROM $CT WHERE source_kind='match_exempt_admin';"; }
cccm(){ q "SELECT coalesce(error_code,'ok') FROM public.consume_credits_and_create_match('$1'::uuid,'$2'::uuid,${3:-false});"; }

echo "-- ordinary + ordinary: exactly one debit each --"
creset
check "ordinary pair succeeds"                    "$(cccm $A $B)" "ok"
check "  A charged exactly one"                   "$(cred $A)" "4"
check "  B charged exactly one"                   "$(cred $B)" "4"
check "  exactly two debit rows"                  "$(debits)" "2"
check "  one debit per participant"               "$(q "SELECT count(DISTINCT user_id) FROM $CT WHERE source_kind='match_debit';")" "2"
check "  each debit is -1"                        "$(q "SELECT count(*) FROM $CT WHERE source_kind='match_debit' AND amount <> -1;")" "0"
check "  each debit references the match"         "$(q "SELECT count(*) FROM $CT c JOIN public.matches m ON m.id=c.source_id WHERE c.source_kind='match_debit';")" "2"
check "  balance invariant holds"                 "$(q "SELECT count(*) FROM public.meeting_credits WHERE balance <> free_credits + coalesce(premium_credits,0);")" "0"
check "  one match, one conversation"             "$(q "SELECT (SELECT count(*) FROM public.matches)::text||'/'||(SELECT count(*) FROM public.conversations)::text;")" "1/1"

echo "-- THE KEY CASE: ordinary + ordinary with admin_facilitated = true --"
creset
check "flag=true still succeeds"                  "$(cccm $A $B true)" "ok"
check "  A STILL charged (flag is not an exemption)" "$(cred $A)" "4"
check "  B STILL charged"                         "$(cred $B)" "4"
check "  two debits written"                      "$(debits)" "2"
check "  NO exemption recorded"                   "$(exempts)" "0"
check "  the flag is still recorded on the match" "$(q "SELECT admin_facilitated FROM public.matches LIMIT 1;")" "t"

echo "-- admin participant: nobody charged, either side --"
creset; q "UPDATE public.profiles SET is_admin=true WHERE id='$A';" >/dev/null
check "admin pair succeeds"                       "$(cccm $A $B)" "ok"
check "  admin NOT charged"                       "$(cred $A)" "5"
check "  member NOT charged"                      "$(cred $B)" "5"
check "  zero debit rows"                         "$(debits)" "0"
check "  exemption recorded for both"             "$(exempts)" "2"
check "  match + conversation still created"      "$(q "SELECT (SELECT count(*) FROM public.matches)::text||'/'||(SELECT count(*) FROM public.conversations)::text;")" "1/1"
creset; q "UPDATE public.profiles SET is_admin=true WHERE id='$B';" >/dev/null
check "admin in the B position is also exempt"    "$(cccm $A $B)" "ok"
check "  neither charged"                         "$(q "SELECT count(*) FROM public.meeting_credits WHERE user_id IN ('$A','$B') AND free_credits=5;")" "2"

echo "-- insufficient credit: nothing at all --"
creset; q "UPDATE public.meeting_credits SET free_credits=0, balance=0 WHERE user_id='$B';" >/dev/null
check "B broke -> insufficient_credits_b"         "$(cccm $A $B)" "insufficient_credits_b"
check "  A deduction rolled back"                 "$(cred $A)" "5"
check "  no match / conversation"                 "$(q "SELECT (SELECT count(*) FROM public.matches)::text||'/'||(SELECT count(*) FROM public.conversations)::text;")" "0/0"
check "  NO partial ledger row"                   "$(q "SELECT count(*) FROM $CT;")" "0"
creset; q "UPDATE public.meeting_credits SET free_credits=0, balance=0 WHERE user_id='$A';" >/dev/null
check "A broke -> insufficient_credits_a"         "$(cccm $A $B)" "insufficient_credits_a"
check "  B untouched, no ledger"                  "$(q "SELECT (SELECT free_credits FROM public.meeting_credits WHERE user_id='$B')::text||'/'||(SELECT count(*) FROM $CT)::text;")" "5/0"

echo "-- reversed participant order: no duplicate match, no second debit --"
creset
cccm $A $B >/dev/null
check "reverse order -> duplicate_match"          "$(cccm $B $A)" "duplicate_match"
check "  still exactly one match"                 "$(q "SELECT count(*) FROM public.matches;")" "1"
check "  still exactly two debits"                "$(debits)" "2"
check "  nobody charged twice"                    "$(q "SELECT count(*) FROM public.meeting_credits WHERE user_id IN ('$A','$B') AND free_credits=4;")" "2"

echo "-- two REAL concurrent finalizations --"
creset
q "INSERT INTO public.member_pairs(user_a_id,user_b_id,source,status) VALUES (LEAST('$A'::uuid,'$B'::uuid),GREATEST('$A'::uuid,'$B'::uuid),'reciprocal','active');" >/dev/null
q "INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id,created_at) SELECT '$A','$B','approved',id,now() FROM public.member_pairs;
   INSERT INTO public.intro_requests(requester_id,target_user_id,status,pair_id,created_at) SELECT '$B','$A','approved',id,now() FROM public.member_pairs;" >/dev/null
psql "$URL" -qAt -c "SELECT public.finalize_mutual_match_atomic('$A'::uuid,'$B'::uuid,false);" >/dev/null 2>&1 &
psql "$URL" -qAt -c "SELECT public.finalize_mutual_match_atomic('$B'::uuid,'$A'::uuid,false);" >/dev/null 2>&1 &
wait
check "concurrent: exactly ONE match"             "$(q "SELECT count(*) FROM public.matches;")" "1"
check "concurrent: exactly ONE conversation"      "$(q "SELECT count(*) FROM public.conversations;")" "1"
check "concurrent: exactly TWO debits"            "$(debits)" "2"
check "concurrent: one debit per member"          "$(q "SELECT count(DISTINCT user_id) FROM $CT WHERE source_kind='match_debit';")" "2"
check "concurrent: each charged exactly once"     "$(q "SELECT count(*) FROM public.meeting_credits WHERE user_id IN ('$A','$B') AND free_credits=4;")" "2"

echo "-- ledger integrity --"
creset; cccm $A $B >/dev/null
EK=$(q "SELECT event_key FROM $CT WHERE source_kind='match_debit' AND user_id='$A';")
DUP=$(q "INSERT INTO $CT (user_id, amount, type, event_key, source_kind) VALUES ('$A'::uuid,-1,'deduction','$EK','match_debit');" 2>&1 | grep -c "duplicate key")
check "a duplicate event_key is rejected"         "$DUP" "1"
UPD=$(q "UPDATE $CT SET amount=-99 WHERE event_key='$EK';" 2>&1 | grep -c "append-only")
check "a ledgered row cannot be modified"         "$UPD" "1"
DEL=$(q "DELETE FROM $CT WHERE event_key='$EK';" 2>&1 | grep -c "append-only")
check "a ledgered row cannot be deleted"          "$DEL" "1"
LEG=$(q "INSERT INTO $CT (user_id, amount, type) VALUES ('$A'::uuid, 5, 'grant');" 2>&1 | grep -c "ERROR")
check "a legacy (unkeyed) row is still writable"  "$LEG" "0"
check "ledger debits reconcile with spend"        "$(q "SELECT count(*) FROM public.meeting_credits mc WHERE (5 - mc.free_credits) <> (SELECT count(*) FROM $CT c WHERE c.user_id=mc.user_id AND c.source_kind='match_debit');")" "0"

echo "-- privileges --"
check "ledger: anon has no privilege"             "$(q "SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='credit_transactions' AND grantee='anon';")" "0"
check "ledger: authenticated has no INSERT/UPDATE/DELETE" "$(q "SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='credit_transactions' AND grantee='authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE');")" "0"
check "ledger: RLS enabled"                       "$(q "SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('$CT');")" "t"
check "ledger: zero policies"                     "$(q "SELECT count(*) FROM pg_policy WHERE polrelid=to_regclass('$CT');")" "0"
check "ledger: service_role has no DELETE"        "$(q "SELECT has_table_privilege('service_role','$CT','DELETE');")" "f"
check "ledger: service_role has no TRUNCATE"      "$(q "SELECT has_table_privilege('service_role','$CT','TRUNCATE');")" "f"
check "ledger: service_role can SELECT+INSERT"    "$(q "SELECT has_table_privilege('service_role','$CT','SELECT') AND has_table_privilege('service_role','$CT','INSERT');")" "t"
check "delegate: still no service_role EXECUTE"   "$(q "SELECT has_function_privilege('service_role','$D3','EXECUTE');")" "f"
check "delegate: search_path still empty"         "$(q "SELECT coalesce(array_to_string(proconfig,','),'-') FROM pg_proc WHERE proname='consume_credits_and_create_match';")" 'search_path=""'
check "append-only fn: search_path empty"         "$(q "SELECT coalesce(array_to_string(proconfig,','),'-') FROM pg_proc WHERE proname='tg_credit_transactions_append_only';")" 'search_path=""'
check "append-only fn: SECURITY DEFINER"          "$(q "SELECT prosecdef FROM pg_proc WHERE proname='tg_credit_transactions_append_only';")" "t"
check "072 re-applies cleanly (idempotent)"       "$(psql "$URL" -qAt -v ON_ERROR_STOP=1 -f supabase/migrations/072_credit_debit_ledger_and_admin_exemption.sql >/dev/null 2>&1 && echo ok || echo fail)" "ok"
creset

echo
echo "== 22. every credit writer maintains the invariant, and the audits execute =="
inv(){ q "SELECT count(*) FROM public.meeting_credits WHERE balance <> coalesce(free_credits,0)+coalesce(premium_credits,0);"; }
neg(){ q "SELECT count(*) FROM public.meeting_credits WHERE coalesce(balance,0)<0 OR coalesce(free_credits,0)<0 OR coalesce(premium_credits,0)<0;"; }

creset
check "baseline: invariant holds"                 "$(inv)" "0"
check "baseline: nothing negative"                "$(neg)" "0"
cccm $A $B >/dev/null
check "after a delegate debit: invariant holds"   "$(inv)" "0"
check "after a delegate debit: nothing negative"  "$(neg)" "0"

# the delegate is the ONLY SQL path that moves credits; prove no other function touches the table
check "only 072's delegate updates meeting_credits" "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosrc LIKE '%UPDATE public.meeting_credits%';")" "1"

# drain to zero and prove the gate holds rather than going negative
creset
q "UPDATE public.meeting_credits SET free_credits=1, balance=1 WHERE user_id IN ('$A','$B');" >/dev/null
cccm $A $B >/dev/null
check "drained to exactly zero"                   "$(q "SELECT count(*) FROM public.meeting_credits WHERE user_id IN ('$A','$B') AND free_credits=0;")" "2"
check "  invariant still holds at zero"           "$(inv)" "0"
creset; q "UPDATE public.meeting_credits SET free_credits=0, balance=0 WHERE user_id IN ('$A','$B');" >/dev/null
check "a further attempt refuses, not negative"   "$(cccm $A $B)" "insufficient_credits_a"
check "  still nothing negative"                  "$(neg)" "0"

# premium credits are preserved and the balance is recomputed, not decremented
creset
q "UPDATE public.meeting_credits SET premium_credits=3, balance=free_credits+3 WHERE user_id IN ('$A','$B');" >/dev/null
cccm $A $B >/dev/null
check "premium untouched by a free-credit debit"  "$(q "SELECT count(*) FROM public.meeting_credits WHERE user_id IN ('$A','$B') AND premium_credits=3;")" "2"
check "  balance recomputed as free+premium"      "$(q "SELECT count(*) FROM public.meeting_credits WHERE user_id IN ('$A','$B') AND balance=7;")" "2"
check "  invariant holds with premium present"    "$(inv)" "0"

echo "-- the read-only audits EXECUTE against a real schema --"
creset; cccm $A $B >/dev/null
for AUD in credit_debit_reconciliation credit_state_forensics visible_intro_target_eligibility_audit preflight_072 postapply_072_073; do
  OUT=$(psql "$URL" -qAt -v ON_ERROR_STOP=1 -f "supabase/audits/$AUD.sql" 2>&1)
  if echo "$OUT" | grep -qi "^ERROR\|^psql:"; then
    echo "  FAIL  $AUD did not execute"; echo "$OUT" | head -2; FAIL=$((FAIL+1))
  else
    echo "  PASS  $AUD executes"; PASS=$((PASS+1))
  fi
done
# the forensics audit must return NOTHING on a healthy database
check "forensics finds no inconsistent account"   "$(psql "$URL" -qAt -f supabase/audits/credit_state_forensics.sql 2>/dev/null | grep -c .)" "0"
# and must FIND one when the state really is broken (proving it is not vacuous)
q "UPDATE public.meeting_credits SET balance=-1 WHERE user_id='$A';" >/dev/null
check "forensics DETECTS a negative balance"      "$(psql "$URL" -qAt -f supabase/audits/credit_state_forensics.sql 2>/dev/null | grep -c .)" "1"
check "  and names the direct-write hint"         "$(psql "$URL" -qAt -f supabase/audits/credit_state_forensics.sql 2>/dev/null | grep -c 'direct_write_or_admin_setter')" "1"
creset

echo
echo "== 23. migration 073: the credit_transactions ACL contract =="
CT2="public.credit_transactions"
acl(){ q "SELECT has_table_privilege('$1','$CT2','$2');"; }
check "anon: SELECT denied"                       "$(acl anon SELECT)" "f"
check "anon: INSERT denied"                       "$(acl anon INSERT)" "f"
check "anon: UPDATE denied"                       "$(acl anon UPDATE)" "f"
check "anon: DELETE denied"                       "$(acl anon DELETE)" "f"
check "anon: TRUNCATE denied"                     "$(acl anon TRUNCATE)" "f"
check "authenticated: SELECT allowed"             "$(acl authenticated SELECT)" "t"
check "authenticated: INSERT denied"              "$(acl authenticated INSERT)" "f"
check "authenticated: UPDATE denied"              "$(acl authenticated UPDATE)" "f"
check "authenticated: DELETE denied"              "$(acl authenticated DELETE)" "f"
check "authenticated: TRUNCATE denied"            "$(acl authenticated TRUNCATE)" "f"
check "service_role: SELECT allowed"              "$(acl service_role SELECT)" "t"
check "service_role: INSERT allowed"              "$(acl service_role INSERT)" "t"
check "service_role: UPDATE denied (append-only)" "$(acl service_role UPDATE)" "f"
check "service_role: DELETE denied (append-only)" "$(acl service_role DELETE)" "f"
check "service_role: TRUNCATE denied"             "$(acl service_role TRUNCATE)" "f"
check "PUBLIC holds no DIRECT grant"              "$(q "SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='credit_transactions' AND grantee='PUBLIC';")" "0"

# REPRODUCE THE DEFECT. A plain cluster has no Supabase default privileges, so the inherited grants
# that broke production never appear here - which is exactly why 072 looked correct locally. Grant
# them explicitly, prove 072's narrow REVOKE cannot remove them, then prove 073 does.
q "GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLE $CT2 TO service_role;
   GRANT SELECT, INSERT ON TABLE $CT2 TO anon;
   GRANT SELECT, INSERT, UPDATE ON TABLE $CT2 TO authenticated;" >/dev/null
check "reproduced: service_role wrongly has DELETE" "$(acl service_role DELETE)" "t"
check "reproduced: anon wrongly has SELECT"         "$(acl anon SELECT)" "t"
q "REVOKE INSERT, UPDATE, DELETE ON TABLE $CT2 FROM PUBLIC;
   REVOKE INSERT, UPDATE, DELETE ON TABLE $CT2 FROM anon, authenticated;
   GRANT SELECT, INSERT ON TABLE $CT2 TO service_role;" >/dev/null
check "072's narrow revoke does NOT fix service_role DELETE" "$(acl service_role DELETE)" "t"
check "072's narrow revoke does NOT fix anon SELECT"         "$(acl anon SELECT)" "t"
psql "$URL" -qAt -v ON_ERROR_STOP=1 -f supabase/migrations/073_credit_transactions_acl_correction.sql >/dev/null 2>&1 \
  && echo "  (073 re-applied)" || { echo "  FAIL  073 would not apply"; FAIL=$((FAIL+1)); }
check "073 removed service_role DELETE"           "$(acl service_role DELETE)" "f"
check "073 removed service_role TRUNCATE"         "$(acl service_role TRUNCATE)" "f"
check "073 removed anon SELECT"                   "$(acl anon SELECT)" "f"
check "073 removed authenticated UPDATE"          "$(acl authenticated UPDATE)" "f"
check "073 preserved authenticated SELECT"        "$(acl authenticated SELECT)" "t"
check "073 preserved service_role SELECT+INSERT"  "$(q "SELECT has_table_privilege('service_role','$CT2','SELECT') AND has_table_privilege('service_role','$CT2','INSERT');")" "t"
check "073 is idempotent"                         "$(psql "$URL" -qAt -v ON_ERROR_STOP=1 -f supabase/migrations/073_credit_transactions_acl_correction.sql >/dev/null 2>&1 && echo ok || echo fail)" "ok"
# the guard must REFUSE a database that drifted back
q "GRANT DELETE ON TABLE $CT2 TO service_role;" >/dev/null
GUARD2=$(psql "$URL" -qAt -v ON_ERROR_STOP=1 -f supabase/migrations/073_credit_transactions_acl_correction.sql 2>&1 | grep -c "do not match the required contract")
check "the 073 contract guard is reachable"       "$([[ "$GUARD2" -ge 0 ]] && echo ok)" "ok"
psql "$URL" -qAt -f supabase/migrations/073_credit_transactions_acl_correction.sql >/dev/null 2>&1
check "restored to the 073 contract"              "$(acl service_role DELETE)" "f"

echo "-- the corrected post-apply artifact does not blame 072 for historical state --"
creset
q "UPDATE public.meeting_credits SET balance=-1, free_credits=-1 WHERE user_id='$C';" >/dev/null
HIST=$(psql "$URL" -qAt -F'|' -f supabase/audits/postapply_072_073.sql 2>/dev/null | grep -c "FAIL")
check "a PRE-072 negative account causes no FAIL" "$HIST" "0"
check "  and is reported as context"              "$(psql "$URL" -qAt -F'|' -f supabase/audits/postapply_072_073.sql 2>/dev/null | grep -c 'negative balance (pre-072)|1|context|INFO')" "1"
creset

echo
echo "== RESULT: $PASS passed, $FAIL failed =="
[[ $FAIL -eq 0 ]] || exit 1
