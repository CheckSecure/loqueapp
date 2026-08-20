# Migration 063 is NOT visible in the migration-health dashboard

**State this plainly rather than implying deployment ordering is monitored: it is not.**

## What is missing

`lib/db/migrationHealth.ts` exposes `SCHEMA_EXPECTATIONS`, which `/api/admin/migration-health` and
the admin banner probe on every load. **Migration 063 has no entry there**, so an operator who
deploys the application code without first applying 063 will see a green migration-health panel.

## Why it was left out

Registering an RPC requires `kind: 'function'`, `fn`, and `probeArgs` on `SchemaExpectation`, plus
the matching branch in `probeExpectation`. **That machinery does not exist on `main`.** It is part of
an unrelated, in-progress company-admin change (migrations 033/034, `merge_companies`) currently
sitting uncommitted in the working tree. A 063 entry would therefore be inseparable from that work:
staging it alone would not compile.

Mixing them was the worse option. The capacity change stays independently reviewable and
independently revertible, at the cost of one missing dashboard row.

## What protects the ordering in the meantime

Not the dashboard — these, and they are worth being precise about:

1. **Placement throws.** `enqueueBatch` converts any RPC error into a thrown
   `place_batch_rows failed (PGRST202)`. With 063 unapplied, onboarding and weekly generation fail
   loudly and place **nothing**. The failure mode is "no recommendations", never "over-capacity
   recommendations".
2. **Promotion returns not-promoted** and logs the error class. Queued batches are simply not
   revealed; nothing is lost or duplicated.
3. **The migration header** says `NOT YET APPLIED` and states the apply-before-deploy requirement.

So the risk of deploying out of order is a visible outage of generation, not silent data damage.
That is an acceptable failure mode, but it is **not** monitoring, and nobody should treat the green
banner as evidence that 063 is applied.

## The smallest future registration, once the prerequisite lands

After the company-admin change (which brings `kind: 'function'` support) is merged, this is the
entire follow-up — one array element in `lib/db/migrationHealth.ts`, no other file touched, no test
changes required:

```ts
{
  migration: '063_unified_introduction_capacity.sql',
  kind: 'function',
  table: 'intro_requests',
  fn: 'place_batch_rows',
  // p_member_id NULL trips the first guard and returns 'invalid' BEFORE any read or write.
  // p_source and p_rows have no SQL defaults, so they must be supplied for PostgREST to resolve
  // the function at all — omitting them would look like "function not found" and false-alarm.
  probeArgs: { p_member_id: null, p_source: 'weekly', p_rows: [] },
  feature: 'Transactional introduction capacity (place_batch_rows + promote_queued_rows)',
  impact:
    'REQUIRED before deploying the unified-capacity queue. enqueueBatch and promoteIfResolved ' +
    'delegate to these RPCs, which take the per-member advisory lock and enforce the two card caps ' +
    "(max 2 visible 'suggested', max 2 reserved 'queued'). Until applied, every placement THROWS " +
    'and every promotion returns not-promoted: generation places NOTHING and queued batches are ' +
    'never revealed. Recommendations are unavailable, not silently over-issued. Apply 063 BEFORE ' +
    'deploying this code.',
}
```

Verified against the real database: with 063 applied, that probe returns
`{"placed": false, "reason": "invalid"}` without reading or writing a row; with it unapplied,
PostgREST returns `PGRST202`, which `probeExpectation`'s `FN_ABSENT_RE` already classifies as absent.
A test asserting the entry's absence lives in `lib/__tests__/unified-introduction-capacity.test.ts`
so that re-adding it is a deliberate act rather than an accident.
