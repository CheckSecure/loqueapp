# Migration 063 is NOT visible in the migration-health dashboard

**State this plainly rather than implying deployment ordering is monitored: it is not.**

## What is missing

`lib/db/migrationHealth.ts` exposes `SCHEMA_EXPECTATIONS`, which `/api/admin/migration-health` and
the admin banner probe on every load. **Migration 063 has no entry there**, so an operator who
deploys the application code without first applying 063 will see a green migration-health panel.

## Why it was left out

Registering an RPC requires `kind: 'function'`, `fn`, and `probeArgs` on `SchemaExpectation`, plus
the matching branch in `probeExpectation`. At the time this was written **that machinery did not
exist on `main`**: it was part of an unrelated, in-progress company-admin change (migrations
033/034, `merge_companies`) sitting uncommitted in the working tree, so a 063 entry would have been
inseparable from that work and would not have compiled on its own.

Mixing them was the worse option. The capacity change stayed independently reviewable and
independently revertible, at the cost of one missing dashboard row.

> **UPDATE — the prerequisite has landed.** The company-admin change never merged, but the
> `kind: 'function'` machinery this document specified was implemented directly for the Phase 3
> Stage 1 prerequisites (`create_gated_match`, `create_support_match`, `create_admin_intro_pair`),
> including the separate `FN_ABSENT_RE` classifier described below. **The blocker in this section
> no longer applies.** 063 and 064 remain unregistered because nobody has decided to register
> them — a choice, not an obstacle — and the "what protects the ordering" reasoning below is still
> the accurate account of why the gap is tolerable. Registering them is now the one-array-element
> change this document already describes.

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

## The smallest registration, now unblocked

`kind: 'function'` support exists. This is the entire follow-up — one array element in
`lib/db/migrationHealth.ts`, no other file touched — plus deleting the assertion in
`lib/__tests__/unified-introduction-capacity.test.ts` that currently pins its absence:

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
PostgREST returns `PGRST202`, which `probeExpectation`'s `FN_ABSENT_RE` classifies as absent.

Note that `p_source: 'weekly'` and `p_rows: []` are **not** NULL, so registering 063 would also
require adding `place_batch_rows` to `READ_ONLY_PROBE_FUNCTIONS` in
`lib/__tests__/migration-health.test.ts`, with the justification that `p_member_id: null` trips the
first guard before either value is used. That is the all-NULL writer rule doing its job: it forces
the exemption to be argued rather than assumed.

A test asserting the entry's absence lives in `lib/__tests__/unified-introduction-capacity.test.ts`
so that re-adding it is a deliberate act rather than an accident.
