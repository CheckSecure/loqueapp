# Follow-up: flaky test in `generation-capacity.test.ts`

**Status:** open. Pre-existing and already deployed. Deliberately NOT changed by the
069/070 outbox work — it lives in the reviewed b-matching/capacity code.

## The test

`lib/__tests__/generation-capacity.test.ts`
→ `production shape: 98 eligible — 72 full, 14 at one card, 12 empty`
→ `the OLD deficit formula would have failed this very validator`

It feeds `solveGlobalBMatching` a deliberately wrong capacity map (the old
`visibleFree + reservedFree` formula) and asserts the validator rejects the result:

```ts
expect(v.ok).toBe(false)
expect(v.violations.member_already_full).toBeGreaterThan(0)
```

## Observed behaviour

| context | result |
|---|---|
| file run in isolation, 6 consecutive runs | 22/22 passed every time |
| inside the full suite, 5 observed runs | failed 3, passed 2 (~2 in 3) |
| **full suite at HEAD `952e06b`, changes absent, 3 runs** | **failed 2, passed 1 — identical** |

Reproduced on the committed tree with every uncommitted change removed
(`git checkout-index` export), so it is not caused by the outbox work.

## Likely cause — not yet confirmed

There is no `Math.random` in the test or in the solver, and vitest runs a file's tests in
declaration order, so ordering alone does not explain it. The load-dependence points at a
wall-clock budget inside `solveGlobalBMatching`: under full-suite contention the solver
likely exits early and returns a *different but still valid* selection, one that happens to
contain no `member_already_full` violation. The assertion then fails even though nothing is
wrong with the production code.

If that is right, the defect is in the test, not the optimiser: it asserts a specific
violation shape from a time-bounded search.

## Suggested fix

1. Confirm the hypothesis by logging the solver's iteration/deadline state on failure.
2. If confirmed, make the test deterministic — pin the solver's time budget for this case, or
   assert the weaker invariant that actually matters (`v.ok === false`) without requiring a
   particular violation counter to be non-zero.
3. Do **not** relax the validator itself. The validator catching the old formula is the point
   of the test; only the assertion's determinism is in question.

## Why it was not fixed here

Touching the capacity/b-matching suite inside an email-outbox change would mix two unrelated
review surfaces, and the failure is pre-existing in production rather than a regression.
