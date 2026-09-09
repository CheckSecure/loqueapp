# Phase 3 Stage 2 — candidate-pool segmentation, as shipped

**Status: complete.** This supersedes the pre-implementation design that previously lived here.
It describes what is in the codebase, not what was planned.

Stage 1 remains the **authoritative** boundary: `community_pair_allowed` (migration 095) is
evaluated inside the SQL that writes a relationship, under the participants' advisory locks, in the
same transaction (migrations 096 and 098). Stage 2 is **candidate-pool isolation** — defence in
depth. Its job is to stop a cross-community member entering a pool, consuming a top-N slot,
influencing ranking, or having their identity disclosed, all of which happen *before* the database
ever sees the pair.

## The seven ordinary candidate pools

| # | Pool | Where community is enforced |
|---|---|---|
| 1 | Reciprocal introduction ranker | `lib/generate-recommendations.ts` — `filterSameCommunity` on the candidate universe |
| 2 | Concierge admin candidate list | inherits pool 1; the route adds no filter of its own, on purpose |
| 3 | Admin/Thursday weekly batch | `app/api/admin/generate-batch/route.ts` — `partitionByCommunity` before the cohort is scored |
| 4 | Replacement suggestions | `.../generate-replacements/route.ts` — `filterSameCommunity` per **recipient** |
| 5 | Opportunity hiring | `lib/opportunities/matching.ts` `selectCandidates` |
| 6 | Opportunity business | `lib/opportunities/matching.ts` `selectProviders` |
| 7 | Opportunity recruiter | `lib/opportunities/matching.ts` `selectRecruiters` |

Pools 1, 2 and 4–7 are **viewer-relative**: one requester, many candidates, so scoping is a filter
(Stage 2A). Pool 3 has no viewer — it builds one cohort and solves a global graph — so it needed a
**partition** instead (Stage 2B).

## Pool 3 architecture

**One persistent weekly `introduction_batches` record. Two independent computations inside it.**

```
load profiles
  → applyMemberEligibility → filterEligible
  → partitionByCommunity                       ← the boundary
  → Professional cohort:  buildScoringContext(Professionals only)
                          pair construction → scoring → sort
                          capacity → primary solve → fallback solve → suggestions
  → Next cohort:          buildScoringContext(Next only)
                          … the same pipeline, over its own cohort …
  → concatenate: Professional suggestions FIRST, then Next
  → validate combined result
  → create ONE batch row → stamp ONE batch_id → one batch_suggestions insert
```

The partition happens **before** `buildScoringContext`, scoring, candidate-graph construction,
`reduceComponent`, capacity assignment, the primary solve and the fallback solve. Everything from
the scoring context to the finished suggestion rows runs inside `computeCohortSuggestions`, once per
community.

### Why filter-after-scoring is forbidden

Dropping cross-community edges *after* scoring is not sufficient. Two independent channels let one
community change the other's Professional↔Professional results even when no cross-community pair
survives:

1. **IDF / `memberCount`.** `buildScoringContext` takes `memberCount` from the cohort, and
   `idfWeight(df, N) = log((N+1)/(df+1)) / log(N+1)`. `N` is the cohort size, so every score depends
   on how many members of the *other* community happen to exist.
2. **`reduceComponent` / `MAX_COMPONENT_EDGES`.** `solveGlobalBMatching` keeps each member's top-`k`
   edges and **halves `k`** until a connected component fits `MAX_COMPONENT_EDGES`. A mixed cohort
   forms one larger component, so Professionals would get a more aggressive edge reduction than they
   do today — worse matches, with no cross-community pair anywhere in the output.

Both close by never putting the two communities in the same call. There is no variable in scope
holding a combined cohort, so the rejected shape cannot be written without deliberately undoing the
partition. A test asserts `buildScoringContext` is called exactly once in the route, on `cohort`.

### Why separate persistent batch records were rejected

`app/api/admin/approve-batch/route.ts` runs
`UPDATE introduction_batches SET status='completed' WHERE status='active'` — unscoped, across all
batches — before activating the batch being approved. With two records per cycle, approving the Next
batch would silently complete the Professional batch mid-review. Two records would therefore have
required changing the approval lifecycle, i.e. changing existing Professional operations.

The batch row is also already created **once and late**, after every invariant passes, so
partitioning above it and concatenating below it needed no lifecycle change at all.

### Professional-only equivalence

Required, and tested: on an all-Professional network the partition returns the input array **object
for object**, so the existing algorithm receives the same profiles in the same order, the same
`ScoringContext` and `memberCount`, the same rarity maps, the same pair scores, the same solver
inputs, the same selected edges in the same order, and the same `exact` / `nodesExplored`.

Order preservation is load-bearing, not tidiness: the generator builds pairs with a nested `i < j`
loop and then sorts with a comparator that returns 0 for pairs within a ±10 relevance band and equal
mutual score. Ties fall through to `Array.prototype.sort` stability — that is, to the cohort array's
order. **The non-total comparator was deliberately left alone**; "fixing" it would change which
Professional pairs win ties.

Professional output is also proven invariant to adding 10 and 500 Next members — including
`nodesExplored`, which is the direct evidence the Professional component never grew and channel 2 is
closed.

The Professional golden baseline (`lib/__tests__/professional-golden-baseline.test.ts`) is unchanged
and was never regenerated.

### Unknown or malformed `member_type` fails closed

Such a row enters **neither** cohort. It contributes to no scoring context, no `memberCount`, no
capacity, and receives no suggestion. It is never defaulted to Professional. The count is reported as
`membersSkippedUnknownCommunity` — an identity-free aggregate in the JSON response and the
`[generate-batch] partition:` log. It is never thrown: `profiles.member_type` is `NOT NULL DEFAULT
'professional'` with a CHECK constraint (migration 095), so a non-zero value means schema drift, and
an operator should see the number.

Metrics (`usersMatched`, `avgBatchSize`) divide by the recognised member total rather than the raw
profile count, so a skipped row cannot deflate the average. On today's database that number is
`profiles.length`.

A cohort with fewer than two members produces no suggestions and is skipped silently. It never fails
the other cohort or the batch. An empty or tiny Next community at launch is expected, not an error.

### Diagnostics

`pairComposition` and `underfillReasons` are **per-cohort arrays**, not merged. Statistics from two
independent computations are not comparable, and a one-element array on a Professional-only network
accurately represents that exactly one computation ran.

## Pool health

`lib/introductions/poolHealth.ts` is community-aware. It counts only same-community candidates, so an
operator is not told a Professional has fifty candidates when thirty are unreachable. It fails closed
on both sides via `sameCommunity`. This is **diagnostic correctness, not the boundary** — nothing
downstream reads these numbers.

Deliberately not changed: its hand-rolled eligibility filter and by-name exclusion. Pre-existing, out
of scope, and asserted still present so the change cannot grow into a refactor.

## Admin review

One batch, one approval lifecycle, unchanged. The review page adds a community label per recipient
group and a per-community count in the existing header. No tabs, no split screens, no second review
route, no per-community approval. An unreadable `member_type` renders as **Unknown** and is counted
separately — never as Professional. Approval itself knows nothing about community; Stage 1's gates
remain the write-time authority.

## Boundaries that must not move

- **Stage 1 is authoritative.** Stage 2 never replaces it. A TypeScript check runs in another
  process against a snapshot; `service_role` bypasses RLS; only the SQL that writes can bind.
- **Ordinary candidate pools stay same-community permanently.** All seven, forever.
- **One definition of the rule.** `communityOf` / `sameCommunity` in `lib/community/memberType.ts`.
  `filterSameCommunity` and `partitionByCommunity` delegate to it and never re-implement it.
- **No exceptions live in the ordinary rule.** No mentorship, no recruiting/hiring, no admin bypass,
  no generic cross-community flag.

### Future bridges

Mentorship and Recruiting/Hiring will each be an **explicit, separate cross-community candidate
source** — its own predicate (e.g. `open_to_next_mentorship` + a Next member seeking it + mutual
interest), its own gated SQL writer, unioned in *above* the ordinary rule. Neither may weaken
`sameCommunity`, `filterSameCommunity`, `partitionByCommunity`, ordinary weekly matching, or the
Stage 1 database gates. Students will not initially receive the Professional Business Opportunities
experience.

## Facts of record

- **No migration was required for Stage 2B.** No candidate pool is generated in SQL; every pool is
  TypeScript. `profiles.member_type` already existed (migration 095, applied). No schema change to
  `introduction_batches` or `batch_suggestions` — community is derivable from the recipient.
- **No Next member existed during Stage 2B implementation or testing.** Every mixed-cohort test uses
  in-memory fixtures. Nothing in the production codebase writes `profiles.member_type` at all, so no
  code path can currently create one; new profiles are Professional by database default.
- **Launch gate:** the "no Next member until community scoping ships" rule is satisfied for
  candidate-pool segmentation. Creating the first Next member is a separate, deliberate act that
  needs a writer to exist first.
