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

**Consequence: an ACL measured on a bare cluster is a FLOOR, not the production state.** It proves
what a migration explicitly `REVOKE`s, and can never prove the absence of a privilege the migration
does not mention.

**This is now modelled.** `harness_schema.sql` runs the Supabase-equivalent statement after the
roles exist and before any `CREATE FUNCTION` — the ordering matters, because
`ALTER DEFAULT PRIVILEGES` applies only to objects created after it.

### Before / after, measured across 096, 098 and 099

| function | migration | anon | authenticated | service (bare) | service (now) |
| --- | --- | --- | --- | --- | --- |
| `community_pair_allowed` | 095 | false | false | true | true |
| `place_batch_rows` | 085/096 | false | false | true | true |
| `create_gated_match` | 096 | false | false | true | true |
| `create_support_match` | 096 | false | false | true | true |
| `consume_credits_and_create_match` | 087/**068** | false | false | **false** | **false** |
| `create_admin_intro_pair` | 098 | false | false | true | true |
| `resolve_intended_member_type` | 099 | false | false | true | true |
| `tg_profiles_member_type_immutable` | 099 | false | false | **false** | **true** |
| `tg_waitlist_intent_no_conflict` | 099 | false | false | **false** | **true** |

Only the two rows a migration never mentions moved, and they moved to the value production actually
reports. Three properties are worth reading off this table:

- **`anon` and `authenticated` are false everywhere, in both runs.** Explicit `REVOKE`s are
  unaffected by default privileges; the browser-role guarantee does not depend on this change.
- **`consume_credits_and_create_match` stays false**, because migration 068 revokes `service_role`
  *explicitly* and an explicit revoke still wins. A migration that means it can still say so.
- **The two `tg_*` rows now match production.** Harmless there and here: a trigger function cannot be
  invoked directly — `SELECT public.tg_profiles_member_type_immutable()` answers
  `ERROR: trigger functions can only be called as triggers` even holding `EXECUTE` — and trigger
  firing does not consult the caller's privilege. See `docs/PHASE4A_NEXT_DESIGNATION.md`.

Every behavioural result is unchanged: `community_pair_allowed` t/t/f/f, `create_gated_match`
created + ineligible/cross_community, `create_support_match` not_platform_account,
`create_admin_intro_pair` created + ineligible/cross_community, the 099 immutability refusal, the
still-permitted `INSERT` of `member_type='next'`, the resolver, the conflicting-intent refusal, and
zero cross-community `matches` or `intro_requests`.

Where a privilege matters, still assert it in the migration's own postapply block, which runs
against the real database. This harness is now a better model — it is not a substitute.
