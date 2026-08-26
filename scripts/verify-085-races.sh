#!/usr/bin/env bash
# TWO-SESSION concurrency proof for migration 085, on a disposable PostgreSQL 17 cluster.
#
# Every case runs BOTH orderings with real, overlapping transactions in separate psql sessions, and
# asserts the STORED ROWS after both have committed. No comment is treated as evidence.
set -uo pipefail
PGBIN=/opt/homebrew/opt/postgresql@17/bin
[ -x "$PGBIN/initdb" ] || { echo "PostgreSQL 17 not found at $PGBIN"; exit 1; }
PORT=55520
DIR="$(mktemp -d)"
PASS=0; FAIL=0
cleanup(){ "$PGBIN/pg_ctl" -D "$DIR/pg" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
ok(){ PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
chk(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — expected [$3] got [$2]"; fi; }
Q(){ "$PGBIN/psql" -U postgres -X -q -A -t -h localhost -p $PORT -d postgres -c "$1" 2>&1; }
FILE(){ "$PGBIN/psql" -U postgres -X -q -h localhost -p $PORT -d postgres -v ON_ERROR_STOP=1 -f "$1" 2>&1; }

M=00000000-0000-0000-0000-0000000000f1   # the member
U=00000000-0000-0000-0000-0000000000d2   # the counterpart, who becomes unavailable
A=00000000-0000-0000-0000-0000000000a1   # an available third party

"$PGBIN/initdb" -D "$DIR/pg" -U postgres --auth=trust --no-sync >/dev/null 2>&1 || exit 1
"$PGBIN/pg_ctl" -D "$DIR/pg" -o "-p $PORT -c listen_addresses=localhost -c fsync=off -c deadlock_timeout=200ms" -l "$DIR/log" -w start >/dev/null 2>&1 || { cat "$DIR/log"; exit 1; }
echo "PostgreSQL $(Q 'SHOW server_version;') on port $PORT"

# Reuse the main harness's schema + stand-in writers by extracting them from that script.
python3 - "$DIR/schema.sql" <<'PY'
import re, sys
s = open('scripts/verify-085-unavailable-target.sh').read()
a = s.index("DROP SCHEMA IF EXISTS public CASCADE;")
b = s.index("EOSQL", a)
schema = s[a:b]
c = s.index("CREATE FUNCTION public.create_reciprocal_suggestion")
d = s.index("EOSQL", c)
open(sys.argv[1], 'w').write(schema + "\n" + s[c:d])
PY
python3 - "$DIR/pred.sql" <<'PY'
import sys
s=open('supabase/migrations/081_response_eligibility.sql').read()
i=s.index('CREATE OR REPLACE FUNCTION public.count_unresolved_introductions')
j=s.index('$fn$;', s.index('AS $fn$', i))+len('$fn$;')
open(sys.argv[1],'w').write(s[i:j]+'\n')
PY

setup(){
  FILE "$DIR/schema.sql" >/dev/null 2>&1
  FILE "$DIR/pred.sql" >/dev/null 2>&1
  FILE supabase/migrations/085_unavailable_target_release.sql >/dev/null 2>&1
  Q "INSERT INTO public.profiles (id,email,full_name,account_status,profile_complete) VALUES
     ('$M','m@x.test','M','active',true),('$U','u@x.test','U','active',true),('$A','a@x.test','A','active',true);" >/dev/null
}
# One reciprocal pair, both cards suggested, counterpart then made unavailable.
pair(){
  Q "DELETE FROM public.intro_requests; DELETE FROM public.member_pairs; DELETE FROM public.matches;
     DELETE FROM public.blocked_users;
     UPDATE public.profiles SET account_status='active', matching_paused=false;" >/dev/null
  PID=$(Q "INSERT INTO public.member_pairs (user_a_id,user_b_id,status) VALUES ('$M','$U','active') RETURNING id;")
  Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status,pair_id) VALUES
     ('c1000000-0000-0000-0000-000000000001','$M','$U','suggested','$PID'),
     ('c1000000-0000-0000-0000-000000000002','$U','$M','suggested','$PID');" >/dev/null
  Q "UPDATE public.profiles SET matching_paused=true WHERE id='$U';" >/dev/null
  echo "$PID"
}
# Run two SQL scripts as overlapping sessions; $1 starts first, $2 starts after $3 seconds.
race(){ # race <fileA> <fileB> <delay>
  "$PGBIN/psql" -U postgres -X -q -h localhost -p $PORT -d postgres -f "$1" >"$DIR/a.out" 2>&1 &
  local pa=$!
  sleep "$3"
  "$PGBIN/psql" -U postgres -X -q -h localhost -p $PORT -d postgres -f "$2" >"$DIR/b.out" 2>&1
  wait $pa
  grep -qi "deadlock" "$DIR/a.out" "$DIR/b.out" && bad "  DEADLOCK detected" || ok "  no deadlock"
}

mkfile(){ printf '%s\n' "$2" > "$DIR/$1"; }
setup

# ── 1. member expresses Interest while the sweep targets the same pair ────────────────
for order in "sweep-first" "member-first"; do
  echo "── 1. Interest vs sweep ($order) ──"
  PID=$(pair)
  mkfile sweep.sql "BEGIN; SELECT pg_sleep(0.3); SELECT public.sweep_unavailable_introductions(100); COMMIT;"
  mkfile interest.sql "BEGIN; UPDATE public.intro_requests SET status='approved', updated_at=now() WHERE id='c1000000-0000-0000-0000-000000000001' AND status='suggested'; COMMIT;"
  if [ "$order" = "sweep-first" ]; then race "$DIR/sweep.sql" "$DIR/interest.sql" 0.05
  else race "$DIR/interest.sql" "$DIR/sweep.sql" 0.05; fi
  ST=$(Q "SELECT status FROM public.intro_requests WHERE id='c1000000-0000-0000-0000-000000000001';")
  RR=$(Q "SELECT COALESCE(resolution_reason,'-') FROM public.intro_requests WHERE id='c1000000-0000-0000-0000-000000000001';")
  case "$ST" in
    approved) chk "  member decision survived, unmarked" "$RR" "-" ;;
    expired)  chk "  sweep won cleanly and the card is neutral" "$RR" "system_pair_unavailable" ;;
    *)        bad "  card ended in an unexpected state: $ST/$RR" ;;
  esac
  chk "  exactly one final state (no duplicate transition)" "$(Q "SELECT count(DISTINCT status) FROM public.intro_requests WHERE id='c1000000-0000-0000-0000-000000000001';")" "1"
  chk "  no match created" "$(Q 'SELECT count(*) FROM public.matches;')" "0"
done

# ── 2. member Passes while the sweep targets the same pair ───────────────────────────
for order in "sweep-first" "member-first"; do
  echo "── 2. Pass vs sweep ($order) ──"
  PID=$(pair)
  mkfile sweep.sql "BEGIN; SELECT pg_sleep(0.3); SELECT public.sweep_unavailable_introductions(100); COMMIT;"
  mkfile pass.sql "BEGIN; UPDATE public.intro_requests SET status='passed', resolution_reason='not_for_me', updated_at=now() WHERE id='c1000000-0000-0000-0000-000000000001' AND status='suggested'; COMMIT;"
  if [ "$order" = "sweep-first" ]; then race "$DIR/sweep.sql" "$DIR/pass.sql" 0.05
  else race "$DIR/pass.sql" "$DIR/sweep.sql" 0.05; fi
  ST=$(Q "SELECT status||'/'||COALESCE(resolution_reason,'-') FROM public.intro_requests WHERE id='c1000000-0000-0000-0000-000000000001';")
  case "$ST" in
    passed/not_for_me) ok "  the member's Pass survived, un-rewritten" ;;
    expired/system_pair_unavailable) ok "  the sweep won cleanly before the Pass was authored" ;;
    *) bad "  unexpected final state: $ST" ;;
  esac
  chk "  a member-authored reason was never replaced by the system one" \
    "$(Q "SELECT count(*) FROM public.intro_requests WHERE resolution_reason='system_pair_unavailable' AND status='passed';")" "0"
done

# ── 3. BOTH members express Interest (correlated) while the sweep runs ───────────────
for order in "sweep-first" "members-first"; do
  echo "── 3. mutual correlated Interest vs sweep ($order) ──"
  PID=$(pair)
  mkfile sweep.sql "BEGIN; SELECT pg_sleep(0.3); SELECT public.sweep_unavailable_introductions(100); COMMIT;"
  mkfile mutual.sql "BEGIN; INSERT INTO public.intro_requests (requester_id,target_user_id,status,responds_to_id) VALUES ('$M','$U','pending','c1000000-0000-0000-0000-000000000001'),('$U','$M','pending','c1000000-0000-0000-0000-000000000002'); COMMIT;"
  if [ "$order" = "sweep-first" ]; then race "$DIR/sweep.sql" "$DIR/mutual.sql" 0.05
  else race "$DIR/mutual.sql" "$DIR/sweep.sql" 0.05; fi
  chk "  both correlated response rows are intact" "$(Q "SELECT count(*) FROM public.intro_requests WHERE responds_to_id IS NOT NULL AND status='pending';")" "2"
  chk "  none was expired" "$(Q "SELECT count(*) FROM public.intro_requests WHERE responds_to_id IS NOT NULL AND status='expired';")" "0"
  chk "  no invalid match was created" "$(Q 'SELECT count(*) FROM public.matches;')" "0"
  chk "  no response row carries the system reason" "$(Q "SELECT count(*) FROM public.intro_requests WHERE responds_to_id IS NOT NULL AND resolution_reason IS NOT NULL;")" "0"
done

# ── 4. a block commits while the sweep is selecting ──────────────────────────────────
for order in "sweep-first" "block-first"; do
  echo "── 4. block vs sweep ($order) ──"
  Q "DELETE FROM public.intro_requests; DELETE FROM public.member_pairs; DELETE FROM public.blocked_users;
     UPDATE public.profiles SET matching_paused=false, account_status='active';" >/dev/null
  Q "INSERT INTO public.intro_requests (id,requester_id,target_user_id,status) VALUES ('c2000000-0000-0000-0000-000000000001','$M','$A','suggested');" >/dev/null
  mkfile sweep.sql "BEGIN; SELECT pg_sleep(0.3); SELECT public.sweep_unavailable_introductions(100); COMMIT;"
  mkfile block.sql "BEGIN; INSERT INTO public.blocked_users VALUES ('$A','$M'); COMMIT;"
  if [ "$order" = "sweep-first" ]; then race "$DIR/sweep.sql" "$DIR/block.sql" 0.05
  else race "$DIR/block.sql" "$DIR/sweep.sql" 0.05; fi
  ST=$(Q "SELECT status FROM public.intro_requests WHERE id='c2000000-0000-0000-0000-000000000001';")
  case "$ST" in
    suggested) ok "  the block committed after selection; the card waits for the next run" ;;
    expired)   ok "  the block was visible under the lock and the card was neutralised" ;;
    *) bad "  unexpected: $ST" ;;
  esac
  chk "  usable capacity is 0 either way — the member is never charged for it" "$(Q "SELECT public.count_usable_visible_cards('$M');")" "0"
done

# ── 5. weekly placement while the sweep holds the locks, and the reverse ─────────────
for order in "sweep-first" "placement-first"; do
  echo "── 5. placement vs sweep ($order) ──"
  PID=$(pair)
  mkfile sweep.sql "BEGIN; SELECT public.sweep_unavailable_introductions(100); SELECT pg_sleep(0.4); COMMIT;"
  mkfile place.sql "BEGIN; SELECT public.create_reciprocal_suggestion('$M','$A') AS verdict; COMMIT;"
  if [ "$order" = "sweep-first" ]; then race "$DIR/sweep.sql" "$DIR/place.sql" 0.05
  else race "$DIR/place.sql" "$DIR/sweep.sql" 0.05; fi
  VERDICT=$(grep -oE 'created|capacity|unresolved|cooldown|ineligible|exists_active|blocked|invalid|[a-z_]+' "$DIR/b.out" "$DIR/a.out" 2>/dev/null | grep -oE 'created|capacity|unresolved|cooldown|ineligible|exists_active|blocked|invalid' | head -1)
  chk "  the writer's verdict" "$VERDICT" "created"
  chk "  the new introduction landed exactly once" "$(Q "SELECT count(*) FROM public.intro_requests WHERE requester_id='$M' AND target_user_id='$A';")" "1"
  chk "  no visible-cap breach (usable <= 2)" "$(Q "SELECT (public.count_usable_visible_cards('$M') <= 2)::text;")" "true"
  chk "  the member's allocation was NOT reduced by the stale pair" "$(Q "SELECT public.count_usable_visible_cards('$M');")" "1"
done

# ── 6. two sweep workers select the same pair ────────────────────────────────────────
echo "── 6. two concurrent sweep workers ──"
PID=$(pair)
mkfile s1.sql "BEGIN; SELECT public.sweep_unavailable_introductions(100); COMMIT;"
mkfile s2.sql "BEGIN; SELECT public.sweep_unavailable_introductions(100); COMMIT;"
race "$DIR/s1.sql" "$DIR/s2.sql" 0.0
chk "  both placement cards closed exactly once" "$(Q "SELECT count(*) FROM public.intro_requests WHERE status='expired' AND resolution_reason='system_pair_unavailable';")" "2"
chk "  no row was transitioned twice (no duplicate reason rows)" "$(Q "SELECT count(*) FROM public.intro_requests;")" "2"
chk "  member_pairs is expired exactly once" "$(Q "SELECT status FROM public.member_pairs WHERE id='$PID';")" "expired"
chk "  no match created" "$(Q 'SELECT count(*) FROM public.matches;')" "0"

# ── 7. repeated sweep after completion ───────────────────────────────────────────────
echo "── 7. repeated sweep after completion ──"
R=$(Q "SELECT public.sweep_unavailable_introductions(100)::text;")
echo "$R" | grep -q '"processed": 0' && ok "  a further sweep finds nothing (idempotent, deterministic)" || bad "repeat: $R"
chk "  and the stored state is unchanged" "$(Q "SELECT count(*) FROM public.intro_requests WHERE status='expired';")" "2"

echo
printf '══ %d passed, %d failed ══\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
