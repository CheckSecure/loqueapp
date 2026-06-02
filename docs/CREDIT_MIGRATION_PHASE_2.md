# Credit Model Migration — Phase 2 Backlog

Phase 1 (commits 663265f + this commit) migrated the user-facing flows to
**pay-at-mutual-match via the `consume_credits_and_create_match` RPC**:
- `app/api/intro-requests/express-interest/route.ts` (mutual completion)
- `app/actions.ts updateIntroStatus` accept branch

The items below remain on the old single-user-pays-at-action model OR are
hygiene followups created by Phase 1 changes. Bundle into a single Phase 2 PR
once Wave 1 launch state is stable.

## Code paths still on the old model

### 1. `lib/introRequests/index.ts approveIntroRequest`
- Current: deducts `balance` from requester only at `:327-331` (non-atomic, balance-only).
- Hold logic still active: sets `status='accepted_pending_payment'` at `:200-211` if requester lacks credits.
- Trigger: `app/actions.ts adminApproveIntro` (`:113-120`) — admin clicks Approve on a user-initiated intro request.
- Phase 2: route through `consume_credits_and_create_match` RPC with `p_user_a=requester_id, p_user_b=target_user_id`. Retire the `accepted_pending_payment` hold here too — symmetry with `updateIntroStatus`.

### 2. `app/api/admin/facilitate-intro/route.ts`
- Current: requires mutual interest, then admin-triggers match. Deducts from first-by-timestamp user only at `:88-91` (non-atomic, balance-only).
- Note: largely redundant — `express-interest/route.ts` now self-facilitates mutual completion via the RPC.
- Phase 2: **recommend retire entirely**. If kept as an admin override, route through the RPC.

### 3. `app/actions.ts adminAdjustCredits` (`:384-409`)
- Current: admin manual delta, writes `balance` only via upsert. Drift risk: `free_credits` + `premium_credits` not updated to match.
- Phase 2: write all three fields atomically. Decide signed-delta policy (where to apply on free vs. premium).

### 4. `app/actions.ts adminUpdateUser` (`:1421-1430`)
- Current: admin sets `balance` directly via upsert in `meeting_credits`. Same drift as above.
- Phase 2: write all three fields atomically.

## RPC enhancement

### 5. `credit_transactions` audit-trail
- Phase 1 RPC `consume_credits_and_create_match` does NOT insert into `credit_transactions`. Pre-Phase-1 code paths (`actions.ts:327-331`, `lib/introRequests/index.ts:337-341`) did.
- Result: Phase 1 deductions have no row-level audit trail.
- Phase 2: extend the RPC to insert two `credit_transactions` rows (one per user) inside the same transaction, e.g. `type='deduction', note='mutual_match'`. Update any caller that reads `credit_transactions` to expect these new rows.

## Data + schema cleanups

### 6. `accepted_pending_payment` orphan rows
- Existing `intro_requests` with `status='accepted_pending_payment'` are now stuck — no UI path resolves them. Hold flow retired in Phase 1 (`updateIntroStatus`) and admin path still creates them via `approveIntroRequest` until item #1 lands.
- Phase 2 one-time SQL cleanup: review the rows; resolve to either `'rejected'` (let lapse) or `'accepted'` (RPC them through retroactively if both users currently have credits).
- Pre-cleanup query:
  ```sql
  SELECT id, requester_id, target_user_id, accepted_at, expires_at
  FROM intro_requests WHERE status = 'accepted_pending_payment';
  ```

### 7. `expires_at` + `credit_hold` columns on `intro_requests`
- No longer written by `updateIntroStatus` (Phase 1). Still written by `approveIntroRequest` until item #1 lands.
- Phase 2: after item #1 + item #6, schema migration to drop these columns. Verify no other code reads them first (`grep -rn 'expires_at\|credit_hold' app lib`).

### 8. `AdminIntroRequests.tsx:22` orphan label
- The `accepted_pending_payment` admin-table status label is intentionally kept in Phase 1 so admins can see orphan rows (item #6) for manual cleanup.
- Phase 2: remove the label entry after item #6 completes.

## Schema-as-code gap (pre-existing, compounded)

### 9. Migration-file record-keeping
- Phase 1 applied two DDL changes via the Supabase Dashboard SQL Editor with no corresponding migration file in `docs/migrations/`:
  - `CREATE UNIQUE INDEX matches_pair_uniq ON matches (LEAST(user_a_id, user_b_id), GREATEST(user_a_id, user_b_id)) WHERE status != 'removed'`
  - `CREATE OR REPLACE FUNCTION consume_credits_and_create_match(...)` (SECURITY DEFINER PL/pgSQL)
- Consistent with the existing migration-file gap (see prior memory: `launch_cohort` + `open_to_mentorship` backfills).
- Phase 2: batch a single migration-file cleanup PR that captures all undocumented schema changes from the past N commits.

### 10. `intro_requests.credit_charged` external-consumer audit
- The column has 3 writers (`updateIntroStatus`, `facilitate-intro`, `approveIntroRequest`) and **0 readers in the codebase** (`app/`, `lib/`, `components/`).
- Phase 1 kept the write for backward compatibility with potential external readers (Supabase Dashboard saved queries, dbt models, BI tools).
- Phase 2: audit external systems for usage. If confirmed unused, drop the writes and consider dropping the column. If used, document the dependency and either preserve or migrate the external readers.

## Dependency order for Phase 2

1. Item #1 (`approveIntroRequest` → RPC) and item #5 (RPC audit-trail) — together.
2. Item #2 (retire facilitate-intro).
3. Items #3 + #4 (admin credit writers — canonical writes).
4. Item #6 (`accepted_pending_payment` cleanup SQL).
5. Items #7 + #8 (column + label cleanup) — after #1 lands and #6 settles.
6. Item #10 (`credit_charged` external audit) — can run anytime in parallel; gates whether item #7 expands to drop `credit_charged` too.
7. Item #9 (migration files) — batch with whatever Phase 2 schema changes are added above.
