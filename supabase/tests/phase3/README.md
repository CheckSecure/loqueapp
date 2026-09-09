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

## Known limitation: this harness does not model Supabase's default privileges

The cluster these commands build is a **bare** PostgreSQL. Supabase production runs
`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated,
service_role`, so a function created there is born holding `EXECUTE` for all three roles. Here it is
born holding none.

```
bare cluster (this harness)   f1  anon=false  auth=false  service=false
+ ALTER DEFAULT PRIVILEGES    f2  anon=false  auth=false  service=true
```

**Consequence: an ACL measured here is a FLOOR, not the production state.** It proves what a
migration explicitly `REVOKE`s. It cannot prove the absence of a privilege the migration never
mentions — that privilege may be present in production and absent here.

Migration 099's two trigger functions are the worked example: `service_role EXECUTE` reads `false`
here and `true` in production, because 099 revokes `PUBLIC`/`anon`/`authenticated` and says nothing
about `service_role`. Harmless in that case — a trigger function cannot be invoked directly, and
trigger firing does not consult the caller's `EXECUTE` privilege. See
`docs/PHASE4A_NEXT_DESIGNATION.md`.

Where a privilege matters, assert it in the migration's own postapply block, which runs against the
real database, rather than inferring it from a run here.
