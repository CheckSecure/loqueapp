# Phase 3 Stage 1a — local SQL verification harness

Disposable. **Never point this at production.**

    initdb -D <tmp>/data -U postgres --auth=trust
    pg_ctl -D <tmp>/data -o "-p 55432 -k /tmp/p3pg -c listen_addresses=''" start
    createdb -h /tmp/p3pg -p 55432 -U postgres andrel_test
    psql ... -f harness_schema.sql
    psql ... -f pre096_baseline_functions.sql      # the six functions AS THEY ARE IN PRODUCTION
    psql ... -f ../../migrations/095_member_community_foundation.sql
    psql ... -f ../../migrations/096_community_boundary_enforcement.sql
    psql ... -f fixtures.sql

`harness_schema.sql` models the minimum real schema the six restated bodies actually touch. Where a
function needed a table or helper, the harness gained it — a function was never weakened to make the
harness simpler.

`pre096_baseline_functions.sql` is generated, not written: it is the six authoritative bodies
extracted verbatim plus the production ACLs from migrations 067/068/071/085/093. Loading it first is
what lets 096's preconditions and its CREATE OR REPLACE behave exactly as they will in production —
including the fact that CREATE OR REPLACE preserves privileges.

## Generating migration 096

`extract.py` -> `guards.py` -> `generate.py`, with `roundtrip.py` as the safety proof.

The extraction rule is mandatory and non-obvious. Anchor on the literal
`CREATE OR REPLACE FUNCTION public.<name>(` and take the LAST such definition in the authoritative
file. Do NOT anchor on a textual mention of the name: migration 085 lists
`place_batch_rows`/`promote_queued_rows`/`materialize_admin_pair` in a precondition VALUES block at
line 150, hundreds of lines before it defines them at 793/1053/1201, and an earlier extractor that
anchored on the first mention silently produced `create_reciprocal_suggestion`'s body labelled
`place_batch_rows`. `extract.py` therefore also asserts per-function must-contain / must-not-contain
identity markers, and `roundtrip.py` asserts that a no-guard reconstruction of each function is
byte-identical to its source before any guard is spliced in.
