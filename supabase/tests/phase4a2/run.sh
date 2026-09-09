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
# ─── WHY THE LOAD ORDER IS WHAT IT IS ─────────────────────────────────────────────────────────
# historical_fixtures.sql is loaded BEFORE migration 100, because production had 139 profiles when
# 100 was written and some of them predate the invitation architecture. A fixture created after the
# trigger would have had to satisfy it — which is the very property cases 12, 13 and 22 exist to
# measure.
#
# ─── WHY IT NEVER TRUNCATES ───────────────────────────────────────────────────────────────────
# 075's capture_profiles_truncate fires BEFORE TRUNCATE and calls record_account_deletion_event, so
# truncating profiles between cases would write ledger rows and, if the ledger were absent, fail
# outright. A fresh cluster per run is cheaper and cannot drift.
# ═══════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN="${TMPDIR:-/tmp}/phase4a2.$$"
PGDATA="$RUN/data"
PGSOCK="$RUN/sock"
PORT="${PHASE4A2_PORT:-55440}"

cleanup() {
  pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$RUN"
}
trap cleanup EXIT

mkdir -p "$PGDATA" "$PGSOCK"
initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
pg_ctl -D "$PGDATA" -o "-p $PORT -k $PGSOCK -c listen_addresses=''" -l "$RUN/pg.log" -w start >/dev/null
createdb -h "$PGSOCK" -p "$PORT" -U postgres phase4a2

psql() { command psql -h "$PGSOCK" -p "$PORT" -U postgres -d phase4a2 -v ON_ERROR_STOP=1 "$@"; }

echo "── PostgreSQL: $(psql -tAc 'select version()' | cut -d, -f1)"
echo "   (production is 17.x — properties that must hold THERE are asserted in migration 100's"
echo "    own postapply block, which runs against the real database.)"

step() { printf '   %-46s' "$1"; shift; "$@" >/dev/null; echo 'ok'; }

echo "── schema"
step "phase3 harness_schema.sql"      psql -q -f "$ROOT/supabase/tests/phase3/harness_schema.sql"
step "phase4a2 harness_schema_delta"  psql -q -f "$ROOT/supabase/tests/phase4a2/harness_schema_delta.sql"

echo "── migrations, verbatim"
step "095 member community foundation" psql -q -f "$ROOT/supabase/migrations/095_member_community_foundation.sql"
step "053 membership credit cycles"    psql -q -f "$ROOT/supabase/migrations/053_membership_credit_cycles.sql"
step "078 identity resolvers (extract)" psql -q -f "$ROOT/supabase/tests/phase4a2/resolvers_078.sql"
step "075 account deletion ledger"     psql -q -f "$ROOT/supabase/migrations/075_account_deletion_ledger.sql"
step "084 intro guidance enrollment"   psql -q -f "$ROOT/supabase/migrations/084_introduction_guidance_enrollment.sql"
step "099 next designation foundation" psql -q -f "$ROOT/supabase/migrations/099_next_community_designation_foundation.sql"

echo "── historical profiles (BEFORE 100, as production's were)"
step "historical_fixtures.sql"         psql -q -f "$ROOT/supabase/tests/phase4a2/historical_fixtures.sql"

echo "── the migration under test"
psql -f "$ROOT/supabase/migrations/100_provisioning_authorization_and_community_binding.sql" 2>&1 \
  | grep -E 'NOTICE|ERROR' | sed 's/^/   /' || true

echo "── case matrix"
psql -f "$ROOT/supabase/tests/phase4a2/cases.sql" 2>&1 \
  | grep -vE '^(DROP|CREATE|DO|SET|RESET|ALTER)' | sed 's/^/   /'
