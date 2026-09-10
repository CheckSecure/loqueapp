#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════════════════════
# Phase 4A-2 — migration 100 verification harness.
#
# DISPOSABLE. Builds a throwaway PostgreSQL cluster, loads the real migrations, and runs the case
# matrix. NEVER point this at production: it takes no connection string and cannot be aimed.
#
#   ./supabase/tests/phase4a2/run.sh
#
# Exit status is the verdict — cases.sql raises if any assertion failed.
#
# The load order lives in _boot.sh, shared with concurrency_proof.sh so the two cannot drift.
# ═══════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_boot.sh
source "$HERE/_boot.sh"

RUN="${TMPDIR:-/tmp}/phase4a2.$$"
PORT="${PHASE4A2_PORT:-55440}"
mkdir -p "$RUN"
cleanup() { pg_ctl -D "$RUN/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$RUN"; }
trap cleanup EXIT

echo "── booting disposable cluster and loading the real stack"
# NOT piped: p4a2_boot exports P4A2_SOCK/PORT/DB, and a pipeline would run it in a subshell where
# those exports are lost.
p4a2_boot "$RUN" "$PORT" "phase4a2" > "$RUN/boot.log" 2>&1
grep -E 'NOTICE:  100:|ERROR' "$RUN/boot.log" | sed 's/^/   /' || true

PSQL=(psql -h "$P4A2_SOCK" -p "$PORT" -U postgres -d phase4a2)
echo "   $("${PSQL[@]}" -tAc 'select version()' | cut -d, -f1)"
echo "   (production is 17.x — properties that must hold THERE are asserted in migration 100's"
echo "    own postapply block, which runs against the real database.)"

echo "── case matrix"
"${PSQL[@]}" -v ON_ERROR_STOP=1 -f "$(p4a2_root)/supabase/tests/phase4a2/cases.sql" 2>&1 \
  | grep -vE '^(DROP|CREATE|DO|SET|RESET|ALTER)' | sed 's/^/   /'
