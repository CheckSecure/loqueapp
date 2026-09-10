#!/usr/bin/env bash
# Shared boot for the Phase 4A-2 harness. Sourced by run.sh and concurrency_proof.sh so both load
# EXACTLY the same stack — a second copy of the load order would drift.
#
# Defines: p4a2_boot <run-dir> <port> <dbname>   → starts a disposable cluster, loads everything,
#                                                  and exports P4A2_SOCK / P4A2_PORT / P4A2_DB.
# DISPOSABLE. Never point this at production: it takes no connection string.

p4a2_root() { cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd; }

p4a2_boot() {
  local run="$1" port="$2" db="$3"
  local root; root="$(p4a2_root)"
  export P4A2_SOCK="$run/sock" P4A2_PORT="$port" P4A2_DB="$db"

  mkdir -p "$run/data" "$P4A2_SOCK"
  initdb -D "$run/data" -U postgres --auth=trust >/dev/null
  pg_ctl -D "$run/data" -o "-p $port -k $P4A2_SOCK -c listen_addresses=''" -l "$run/pg.log" -w start >/dev/null
  createdb -h "$P4A2_SOCK" -p "$port" -U postgres "$db"

  local q=(psql -h "$P4A2_SOCK" -p "$port" -U postgres -d "$db" -v ON_ERROR_STOP=1 -q -f)

  # Schema, then the real migrations verbatim, then the historical profiles, then the migration
  # under test. The fixtures load BEFORE 100 because production's 139 profiles predate it.
  "${q[@]}" "$root/supabase/tests/phase3/harness_schema.sql"
  "${q[@]}" "$root/supabase/tests/phase4a2/harness_schema_delta.sql"
  "${q[@]}" "$root/supabase/migrations/095_member_community_foundation.sql"
  "${q[@]}" "$root/supabase/migrations/053_membership_credit_cycles.sql"
  "${q[@]}" "$root/supabase/tests/phase4a2/resolvers_078.sql"
  "${q[@]}" "$root/supabase/migrations/075_account_deletion_ledger.sql"
  "${q[@]}" "$root/supabase/migrations/084_introduction_guidance_enrollment.sql"
  "${q[@]}" "$root/supabase/migrations/099_next_community_designation_foundation.sql"
  "${q[@]}" "$root/supabase/tests/phase4a2/historical_fixtures.sql"
  "${q[@]}" "$root/supabase/migrations/100_provisioning_authorization_and_community_binding.sql"
}
