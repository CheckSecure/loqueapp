# Migration 097 is NOT visible in migration health — an accepted gap

**State this plainly rather than letting a green dashboard imply more than it checks: migration
health does not verify 097, and after the Phase 3 Stage 1 work it does not verify every security
property of 096 or 098 either.**

## What migration health now covers, and what it does not

`kind: 'function'` probes were added for the Phase 3 Stage 1 prerequisites. They answer exactly one
question per entry — *does this RPC exist and resolve?* — for the three functions the application
calls by name:

| Migration | Object | Covered? |
| --- | --- | --- |
| 096 | `create_gated_match` | ✅ existence |
| 096 | `create_support_match` | ✅ existence |
| 098 | `create_admin_intro_pair` | ✅ existence |
| 096 | the six community guards spliced into `create_reciprocal_suggestion`, `place_batch_rows`, `promote_queued_rows`, `materialize_admin_pair`, `finalize_mutual_match_atomic`, `consume_credits_and_create_match` | ❌ |
| 096 / 098 | `SECURITY DEFINER`, `search_path=''`, anon/authenticated `EXECUTE` revocation, the `consume_credits_and_create_match` service_role seal | ❌ |
| **097** | **browser `UPDATE` revocation on `public.batch_suggestions`** | ❌ |

Existence is not enforcement. A probe that finds `place_batch_rows` cannot tell a **guarded** copy
from the pre-096 **unguarded** one — both resolve, both return the same shape. Nobody should read
`ok: true` as "the community boundary is enforced".

## Why 097 in particular cannot be probed

097 revokes a *table privilege*: `REVOKE UPDATE ON TABLE public.batch_suggestions FROM PUBLIC, anon,
authenticated`, and drops the now-unreachable permissive UPDATE policy.

1. **There is no function to call.** The `kind: 'function'` probe works by invoking an RPC; a grant
   is not callable.
2. **PostgREST cannot introspect it.** `pg_catalog` / `information_schema` are not in the exposed
   schema, so the service-role client migration health uses cannot read `has_table_privilege` or
   `pg_policies` at all.
3. **There is no behavioural signal.** `app/api/intro/hide-suggestion/route.ts` now authorizes with
   `getUser()` and performs the UPDATE as `service_role`, scoped by both the row id and the caller's
   own `recipient_id`. It behaves **identically** whether or not the browser grant was revoked. An
   unapplied 097 is completely silent from the application's point of view.

## Why we are not adding an introspection RPC

Exposing this to migration health would mean shipping a new production migration whose only purpose
is to create a `SECURITY DEFINER` function that reads `pg_catalog` and reports privilege state — a
new callable surface, on the production database, to populate a dashboard row.

That is disproportionate, and it would buy less than it appears to:

- **The property was already asserted transactionally, by 097 itself.** Its postapply block re-reads
  the live catalog and `RAISE`s — rolling the whole migration back — unless the browser `UPDATE` is
  gone, the permissive policy is gone, `batch_suggestions_recipient_self_read` survives,
  `authenticated` still holds `SELECT`, and `service_role` still holds `UPDATE`. 097 either applied
  with all of that true, or it did not apply.
- **It was verified independently in production** after the apply: `anon` UPDATE `false`,
  `authenticated` UPDATE `false`, `service_role` UPDATE `true`, SELECT preserved, policy count `1`.
- **Nothing in the application can undo it.** No code path issues `GRANT`. Only an operator running
  SQL by hand could restore the privilege, and a dashboard probe is not the control for that —
  change management is.

So the residual risk is narrow: an operator manually re-granting browser `UPDATE`, or 097 never
being applied to some *other* environment. Neither is worth a permanent production introspection
function.

## What actually protects each uncovered property

| Property | What protects it |
| --- | --- |
| 097's revocation | 097's own postapply assertions (transactional, rollback on failure) + the one-time production verification + no application code that grants |
| 096's six community guards | The apply-time postapply proof in 096 (per function: `SECURITY DEFINER`, pinned `search_path`, return type, guard present, original identity markers intact, browser `EXECUTE` denied) |
| `consume_credits_and_create_match` sealed from `service_role` | Asserted at apply time by both 096 and 098 |
| The three registered RPCs existing | **Migration health** — and, independently, every caller fails closed: `outcome: 'error'` → "Could not create match" / `internal` / `insert_failed`, with no partial write and no notification |

## If this is ever revisited

The smallest honest option is **not** an introspection RPC but a periodic operator check: run the
same `has_table_privilege` / `pg_policies` queries 097's postapply block already contains, from the
Supabase SQL editor, as part of whatever schema-drift review this project adopts. This repository
already documents that drift is a recurring category here
(`docs/migrations/2026-05-11_batch_suggestions_rls_as_built.md`), and that is the right place for a
grant-level control to live — not in an application health endpoint.
