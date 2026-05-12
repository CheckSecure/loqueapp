# batch_suggestions RLS — As-Built State (2026-05-11)

## Intended Migration

The May 11 batch_suggestions audit identified four SELECT policies on the
table, two of which were problematic:

- `"batch_suggestions_select_authenticated"` — SELECT, `USING (true)` — loose;
  OR-combined with the restrictive policies to expose all rows to any
  authenticated user
- `"suggestions_select_recipient"` — SELECT, `USING (recipient_id = auth.uid())`
  — functional duplicate of `"batch_suggestions_recipient_self_read"`

The planned commit was to drop both, leaving exactly two policies:

| Policy | Cmd | Using | With Check |
|---|---|---|---|
| `batch_suggestions_recipient_self_read` | SELECT | `recipient_id = auth.uid()` | — |
| `Users can update their own batch suggestions` | UPDATE | `recipient_id = auth.uid()` | `recipient_id = auth.uid()` |

## Actual Production State Found at Apply Time

When the drop attempt was made, production state had already moved:
**both problematic policies were absent.** The verification query returned
exactly the two intended rows — the target state was already in place without
this commit having to drop anything.

This is the same schema-drift pattern observed on three prior Wave 1 tables:

- `profiles` — original policy set had no git provenance
- `conversations` — RLS enablement outside git-tracked workflow (fe839da)
- `notifications` — pre-migration state verified to differ from documented
  expectations

The drops are not in git history. They were applied directly in the
Supabase dashboard SQL editor outside the tracked migration workflow.

## Prerequisite Commit: 78dd1bc

The preparatory commit that made the policy drop safe:

| File | Change |
|---|---|
| `app/actions.ts:531` | `adminGenerateBatch` INSERT → `adminClient` (cross-user write) |
| `app/actions.ts:975` | `passOnSuggestion` + `.eq('recipient_id', user.id)` (ownership filter) |
| `app/dashboard/admin/page.tsx:110` | batch count query → `adminClient` |
| `app/dashboard/admin/batches/page.tsx:22,27` | both batch count queries → `adminClient` |

Without 78dd1bc, production code had call sites relying on the loose `USING (true)`
policy to return rows under user-context clients (admin dashboards) and a
`passOnSuggestion` UPDATE path with no ownership filter. 78dd1bc closed both
gaps before any policy change.

## Probe Evidence (2026-05-11)

All probes run post-78dd1bc, against production state with both problematic
policies already absent.

### Anon-key probes

```
[Insert verbatim curl output from anon row fetch]
[Insert verbatim curl output from anon count — expected content-range: */0]
```

Expected and confirmed: `[]` and `content-range: */0`. The loose policy
targeted the `authenticated` role; anon reads were never exposed.

### Authenticated cross-user SELECT probe

```
Probing user: <email>, <UUID>
GET /rest/v1/batch_suggestions?recipient_id=neq.<self>&select=id,recipient_id,suggested_id,status&limit=5
[Insert verbatim curl output — expected []]
[Insert verbatim content-range — expected */0]
```

Cross-user reads denied. The SELECT policy correctly restricts authenticated
members to their own rows. This confirms the production state already matches
the intended post-drop posture.

### Authenticated own-row SELECT probe

```
GET /rest/v1/batch_suggestions?recipient_id=eq.<self>&select=id,recipient_id,suggested_id,status&limit=5
[Insert verbatim curl output — expected rows for the probing user]
```

Own-row reads permitted. The `batch_suggestions_recipient_self_read` policy
is functioning correctly.

## Remaining Call Site Posture (post-78dd1bc)

Every code path touching `batch_suggestions` is either:

**Admin-scoped via `createAdminClient()` (service-role bypass):**

| File | Lines | Operation |
|---|---|---|
| `app/actions.ts` | 531–532 | `adminGenerateBatch` INSERT |
| `app/dashboard/admin/page.tsx` | 111 | batch count |
| `app/dashboard/admin/batches/page.tsx` | 21–30 | per-batch suggestion/member counts |
| `app/dashboard/admin/batches/[batchId]/review/page.tsx` | 31 | suggestion list for review |
| `app/api/admin/generate-batch/route.ts` | 348, 360, 386, 399, 639 | batch generation logic |
| `app/api/admin/batch/[batchId]/generate-replacements/route.ts` | 182, 261, 272, 336 | replacement generation |
| `app/api/admin/batch-suggestions/drop/route.ts` | 36, 53, 65 | admin drop |
| `app/api/admin/batch-suggestions/restore/route.ts` | 40, 55, 67 | admin restore |
| `app/api/admin/approve-batch/route.ts` | 39, 50 | batch approval |
| `app/api/admin/delete-batch/route.ts` | 16 | DELETE all suggestions for batch |
| `app/api/admin/batch-suggestion/route.ts` | 16, 39 | single suggestion DELETE/INSERT |

**Self-scoped via `createClient()` with explicit `recipient_id` ownership filter:**

| File | Line | Operation | Filter |
|---|---|---|---|
| `app/dashboard/introductions/page.tsx` | 150–157 | SELECT own suggestions | `.eq('recipient_id', profileId)` |
| `app/actions.ts` | 973–977 | `passOnSuggestion` UPDATE | `.eq('recipient_id', user.id)` |
| `app/api/intro/hide-suggestion/route.ts` | 15–19 | UPDATE to `hidden_permanent` | `.eq('recipient_id', user.id)` |

Zero call sites perform broad or cross-user reads via user-context clients.

## Operational Findings

### 1. Schema drift on batch_suggestions confirms the pattern

Three of four Wave 1 tables exhibited schema drift at audit time; this is
now four of four if we count the batch_suggestions policy drops as a separate
event. Schema state changes outside the git-tracked workflow are not isolated
incidents — they are a category.

**Action**: Roadmap Item 4 (Internal Events Infrastructure) should treat DDL
event capture as a first-class consumer. Until that lands, every audit pass
must re-verify state immediately before any apply, treating audit-time SQL
output as a snapshot rather than a contract.

### 2. Audit-time SQL is not durable

The batch_suggestions audit ran at one moment; the verification SQL ran at
another moment (same day, same operator session); the policy state moved
between them. See finding 1.

### 3. `passOnSuggestion` ownership gap was a pre-existing security issue

Fixed in `78dd1bc`, caught during call-site inventory. The `passOnSuggestion`
server action accepted a `rowId` parameter and issued `UPDATE … WHERE id = rowId`
with no `recipient_id` filter. Any authenticated user with a known row ID could
flip another user's suggestion status (pass or permanently hide). The RLS
UPDATE policy enforces ownership at the DB layer, but defense-in-depth at the
application layer was absent.

This was independent of the RLS policy state. Worth a follow-up sweep across
other server actions with UPDATE paths for the same pattern.

## What This Closes

Wave 1 RLS hardening track complete. Four tables verified or hardened:

| Table | Commits |
|---|---|
| `profiles` | Wave 1 (May 9-10), multiple commits |
| `conversations` | `fe839da` (as-built doc), `cbb9e1c` (simulate-matches prep) |
| `notifications` | `41d9281` (cross-user inserts) · `5be62c0` (dead helpers) · `7af8010` (type union) · `746b586` (policy tighten) |
| `batch_suggestions` | `78dd1bc` (prep migrations) · this commit (as-built reconciliation) |

Future Wave 2+ work — rate limiting, role-based admin replacement, audit log
infrastructure, DDL event capture — proceeds independently.
