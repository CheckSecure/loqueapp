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
  for f in supabase/tests/063_fixture.sql \
           supabase/migrations/063_unified_introduction_capacity.sql \
           supabase/tests/064_fixture.sql \
           supabase/migrations/064_materialize_admin_pair.sql \
           supabase/tests/066_fixture.sql \
           supabase/migrations/066_expire_intro_pair.sql \
           supabase/migrations/067_finalize_mutual_match_atomic.sql; do
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
check "before 068: service_role CAN reach delegate" "$(q "SELECT has_function_privilege('service_role','$D3','EXECUTE');")" "t"
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
echo "== RESULT: $PASS passed, $FAIL failed =="
[[ $FAIL -eq 0 ]] || exit 1
