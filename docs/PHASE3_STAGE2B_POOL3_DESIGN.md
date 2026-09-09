# Phase 3 Stage 2B — Pool 3: the global Admin/Thursday batch

**Not implemented. This is approved design context recorded alongside Stage 2A, which deliberately
did not touch `app/api/admin/generate-batch/route.ts`.**

## Launch invariant

**No Next/student member may be created until BOTH Stage 2A and Stage 2B are implemented, merged,
deployed and verified.** Stage 2A scopes six pools; Pool 3 is still unscoped, and it writes
`batch_suggestions` rows that `materialize_admin_pair` later turns into introductions. Creating a
Next member before 2B ships would put cross-community pairs into a reviewed batch.

The rule is also why Stage 2A alone is not enough for the opportunity surface: candidate rows
already written to `opportunity_candidates` keep being served by the For-you read
(`app/dashboard/opportunities/page.tsx`), which discloses the creator's name and company. Scoping
candidate *creation* is the correct fix and it is what Stage 2A does — it prevents NEW
cross-community rows. It does not retroactively remove rows that were written earlier, and it must
not be papered over with a presentation-layer filter.

## Why Pool 3 is different from the six Stage 2A pools

The other six are viewer-relative: one requester, many candidates, so scoping is a filter on the
candidate list. Pool 3 has **no viewer**. It builds one cohort of every eligible member and runs a
global b-matching over all pairs.

That makes the naive fix wrong. `lib/matching/batch-scoring.ts`:

```
buildScoringContext(profiles) -> { memberCount: profiles.length, purposeRarity, interestRarity }
idfWeight(df, memberCount)    -> log((N + 1) / (df + 1)) / log(N + 1)
```

**`N` is the cohort size.** Every Professional↔Professional score therefore depends on how many
members are in the corpus. Filtering cross-community *edges* after scoring would leave Next
membership silently altering Professional scores, tie-breaks, bucket boundaries and — through
`solveGlobalBMatching` — which pairs win scarce capacity.

## Approved direction

Partition **before** `buildScoringContext`:

- Professional community receives its normal weekly batch.
- Next community receives its own weekly batch.
- **Do not alternate communities by week.** Each runs every cycle.
- Each community runs independently against its **own cohort**, with its own `ScoringContext`.
- Neither community contributes to the other's scoring/IDF corpus.
- Professional-only behaviour must remain observationally equivalent: with one community present
  there is one partition of the same size, so `N` is unchanged and every score is identical.
- Both the primary and the **fallback** `solveGlobalBMatching` call must consume an
  already-partitioned edge set.

`partitionByCommunity` was deliberately **not** added to `lib/community/memberType.ts` in Stage 2A,
because Stage 2A has no caller for it and unused production code is where drift starts. Stage 2B is
where it belongs, built on the same `communityOf` / `sameCommunity` rule as `filterSameCommunity`
so there is still exactly one definition.

## Deferred item: `lib/introductions/poolHealth.ts`

**Disposition: B — defer to Stage 2B / pre-Next-launch cleanup.**

`loadPoolHealth` mirrors Pool 1's exclusions to gauge each member's fresh candidate pool, and it
does **not** apply community scoping. Once a Next member exists it will over-report availability:
an admin would see a member with candidates the ranker will never actually offer them.

It is deferred rather than fixed in Stage 2A because it is **admin-only diagnostic output**: it
creates no candidate, writes no row, and discloses nothing to a member. Its exclusion set is also a
deliberate approximation already (referral exclusions are omitted for cost, so it is documented as a
gauge rather than an exact count). Adding community scoping to it now would mean editing a file with
no security role during a security change.

It must be fixed **before the first Next member is created**, alongside Stage 2B, so operators are
not making decisions from inflated pool numbers.
