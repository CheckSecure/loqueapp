#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════════════════════
# R2 — DOES MIGRATION 100's `FOR SHARE` ACTUALLY SERIALISE AGAINST A CONCURRENT REVOKE?
#
# Catalog evidence that FOR SHARE appears in the function proves nothing about behaviour. This runs
# TWO GENUINELY INDEPENDENT CONNECTIONS and measures blocking from the server's own view
# (pg_stat_activity.wait_event_type + pg_blocking_pids), not from client output.
#
#   ./supabase/tests/phase4a2/concurrency_proof.sh
#
# ─── WHY A THIRD, MONITORING CONNECTION ───────────────────────────────────────────────────────
# psql writing to a file is block-buffered, so "no output yet" is not evidence of blocking. The
# monitor asks POSTGRES whether a backend is waiting on a lock and which pid holds it. That is the
# authoritative answer and it cannot be confused by buffering.
#
# ─── THE QUESTION SCENARIO 3 EXISTS TO SETTLE ─────────────────────────────────────────────────
# Serialising is only half of it. After the trigger's FOR SHARE unblocks, may_provision_profile —
# which is STABLE — has to observe the revoke that just committed, or the lock has merely delayed a
# stale read. The trigger is VOLATILE, so each SQL statement inside it should take a fresh snapshot,
# and the STABLE function should then inherit that fresh snapshot. SHOULD is not measured. Scenario
# 3 measures it.
# ═══════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_boot.sh
source "$HERE/_boot.sh"

RUN="${TMPDIR:-/tmp}/p4a2conc.$$"
PORT="${PHASE4A2_CONC_PORT:-55441}"
mkdir -p "$RUN"
cleanup() { pg_ctl -D "$RUN/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$RUN"; }
trap cleanup EXIT

echo "── booting disposable cluster"
p4a2_boot "$RUN" "$PORT" "conc" >/dev/null
PSQL=(psql -h "$P4A2_SOCK" -p "$PORT" -U postgres -d conc)
echo "   $("${PSQL[@]}" -tAc 'select version()' | cut -d, -f1)"

now() { python3 -c 'import time;print(f"{time.time():.3f}")'; }
mon()  { "${PSQL[@]}" -tAF'|' -c "
  SELECT a.application_name, a.state, coalesce(a.wait_event_type,'-'), coalesce(a.wait_event,'-'),
         coalesce(array_to_string(pg_blocking_pids(a.pid), ','), '')
  FROM pg_stat_activity a
  WHERE a.datname='conc' AND a.application_name IN ('sessionA','sessionB')
  ORDER BY a.application_name;"; }

# Is <app> waiting on a lock right now?
waiting() { mon | awk -F'|' -v a="$1" '$1==a && $3=="Lock"{print "yes"}'; }

# ── two long-lived connections, each fed through its own FIFO ────────────────────────────────
mkfifo "$RUN/a.in" "$RUN/b.in"
PGAPPNAME=sessionA psql -h "$P4A2_SOCK" -p "$PORT" -U postgres -d conc --echo-errors \
  < "$RUN/a.in" > "$RUN/a.out" 2>&1 &
PGAPPNAME=sessionB psql -h "$P4A2_SOCK" -p "$PORT" -U postgres -d conc --echo-errors \
  < "$RUN/b.in" > "$RUN/b.out" 2>&1 &
exec 7> "$RUN/a.in"
exec 8> "$RUN/b.in"
A() { printf '%s\n' "$*" >&7; }
B() { printf '%s\n' "$*" >&8; }
settle() { sleep "${1:-1}"; }

A "\\echo :: session A ready"; B "\\echo :: session B ready"; settle 1
echo "   sessions: $(mon | tr '\n' ' ')"

revoke_sql() {  # exactly what /api/admin/waitlist/revoke does: status + revoked_at, by id
  echo "UPDATE public.waitlist SET status='revoked', revoked_at=now()
         WHERE lower(btrim(coalesce(email,''))) = '$1';"
}
insert_sql() { # a genuine first-profile INSERT, member_type omitted
  echo "INSERT INTO public.profiles (id, email, full_name, profile_complete)
        VALUES ('$1', '$2', 'Conc', true);"
}

# ════════════════════════════════════════════════════════════════════════════════════════════
echo
echo "══ SCENARIO 1 — A inserts and holds; B revokes the same invitation; A COMMITS"
A "BEGIN;"; A "$(insert_sql c0000001-0000-4000-8000-000000000001 cand.pro@example.test)"; settle 2
echo "   A holds waitlist locks: $("${PSQL[@]}" -tAc "
  SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a USING (pid)
   WHERE a.application_name='sessionA' AND l.locktype='tuple' OR
         (a.application_name='sessionA' AND l.relation='public.waitlist'::regclass AND l.granted);")"
T0=$(now); B "BEGIN;"; B "$(revoke_sql cand.pro@example.test)"; settle 2
echo "   after 2s  → B waiting on lock: $(waiting sessionB){$(mon | grep sessionB | cut -d'|' -f3,4,5)}"
settle 2
echo "   after 4s  → B waiting on lock: $(waiting sessionB)"
A "COMMIT;"; settle 2; T1=$(now)
echo "   A committed → B waiting on lock: $(waiting sessionB) (was blocked ~$(python3 -c "print(f'{$T1-$T0:.1f}')")s)"
B "COMMIT;"; settle 1

# ════════════════════════════════════════════════════════════════════════════════════════════
echo
echo "══ SCENARIO 2 — same, but A ROLLS BACK"
A "BEGIN;"; A "$(insert_sql c0000014-0000-4000-8000-000000000014 cand.credit@example.test)"; settle 2
T0=$(now); B "BEGIN;"; B "$(revoke_sql cand.credit@example.test)"; settle 2
echo "   after 2s  → B waiting on lock: $(waiting sessionB)"
A "ROLLBACK;"; settle 2; T1=$(now)
echo "   A rolled back → B waiting on lock: $(waiting sessionB) (was blocked ~$(python3 -c "print(f'{$T1-$T0:.1f}')")s)"
B "COMMIT;"; settle 1
echo "   profile created by the rolled-back A: $("${PSQL[@]}" -tAc "SELECT count(*) FROM public.profiles WHERE id='c0000014-0000-4000-8000-000000000014';")  (expect 0)"

# ════════════════════════════════════════════════════════════════════════════════════════════
echo
echo "══ SCENARIO 3 — INVERSE: B revokes and holds; A inserts; B COMMITS  ← the stale-snapshot test"
B "BEGIN;"; B "$(revoke_sql cand.explicit@example.test)"; settle 2
T0=$(now); A "BEGIN;"; A "$(insert_sql c0000015-0000-4000-8000-000000000015 cand.explicit@example.test)"; settle 2
echo "   after 2s  → A waiting on lock: $(waiting sessionA){$(mon | grep sessionA | cut -d'|' -f3,4,5)}"
B "COMMIT;"; settle 3; T1=$(now)
echo "   B committed the revoke → A waiting: $(waiting sessionA) (A blocked ~$(python3 -c "print(f'{$T1-$T0:.1f}')")s)"
A "COMMIT;"; settle 1
echo "   profile created for the REVOKED invitation: $("${PSQL[@]}" -tAc "SELECT count(*) FROM public.profiles WHERE id='c0000015-0000-4000-8000-000000000015';")  (expect 0 = fail-closed)"

# ════════════════════════════════════════════════════════════════════════════════════════════
echo
echo "══ SCENARIO 4 — INVERSE, but B ROLLS BACK: A must proceed and be authorized"
B "BEGIN;"; B "$(revoke_sql cand.wrongtype@example.test)"; settle 2
T0=$(now); A "BEGIN;"; A "$(insert_sql c0000016-0000-4000-8000-000000000016 cand.wrongtype@example.test)"; settle 2
echo "   after 2s  → A waiting on lock: $(waiting sessionA)"
B "ROLLBACK;"; settle 3; T1=$(now)
echo "   B rolled back → A waiting: $(waiting sessionA) (A blocked ~$(python3 -c "print(f'{$T1-$T0:.1f}')")s)"
A "COMMIT;"; settle 1
echo "   profile created after the revoke was abandoned: $("${PSQL[@]}" -tAc "SELECT count(*) FROM public.profiles WHERE id='c0000016-0000-4000-8000-000000000016';")  (expect 1)"
echo "   its community: $("${PSQL[@]}" -tAc "SELECT coalesce(max(member_type),'<none>') FROM public.profiles WHERE id='c0000016-0000-4000-8000-000000000016';")"

# ── close both sessions so psql flushes, then show what each actually saw ────────────────────
A "\\q"; B "\\q"; exec 7>&-; exec 8>&-; wait 2>/dev/null || true
echo
echo "══ SESSION A transcript (errors and results)"
grep -vE '^\s*$' "$RUN/a.out" | sed 's/^/   A| /'
echo "══ SESSION B transcript"
grep -vE '^\s*$' "$RUN/b.out" | sed 's/^/   B| /'

echo
echo "══ DEADLOCK CHECK — any deadlock detected during the run?"
grep -c 'deadlock' "$RUN/pg.log" || true
