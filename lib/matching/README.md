# Andrel recommendation engine

How members are matched into introduction batches. Read this before touching any
scoring, eligibility, or batch-generation code.

## Modules

| File | Responsibility |
|---|---|
| `eligibility.ts` | Canonical "who may participate" filter + fail-fast guard. |
| `batch-scoring.ts` | v2 pairwise scoring (rarity + diminishing returns), exposure balancing, and all tuning config (`SCORING_CONFIG`, `EXPOSURE_CONFIG`, `BATCH_CONFIG`). |
| `business-solutions.ts` | Consultant/law-firm throttle caps. |
| `same-company.ts` | Same-employer exclusion. |
| `scoring.ts` | *Separate* onboarding recommendation model (55/30/15) — not the batch model. |
| `score.ts` | `match_score` DB bounds + `sanitizeMatchScore` / `assertStorableScore`. |

Consumers: `app/api/admin/generate-batch` (main batch), `.../generate-replacements`
(fills dropped slots), `lib/generate-recommendations.ts` (onboarding → `intro_requests`,
also concierge ranking), `app/api/admin/simulate-matches` (admin tooling),
`lib/opportunities/matching.ts` (opportunity responders).

## 1. Eligibility pipeline (`eligibility.ts`)

Every path that could surface one member to another runs through the **single
canonical filter**, in two layers:

1. **`applyMemberEligibility(query)`** — narrows the DB query:
   `account_status='active' ∧ profile_complete=true ∧ is_test_account IS NOT true
   ∧ is_admin IS NOT true ∧ email≠ADMIN_EMAIL`.
   Excludes test / demo / seed / fake / dev / internal / admin / suspended /
   disabled / deactivated / deleted / incomplete-onboarding accounts.
   *Deliberately not used:* `is_approved` (only the admin has it → would exclude
   everyone) and `onboarding_complete` (always false → `profile_complete` is the
   real gate).
2. **`filterEligible(rows)` / `isEligibleMember(p)`** — an in-memory re-check
   applied before scoring, so an excluded account can never influence scoring,
   rarity/IDF, exposure, or simulation even if a query clause is dropped.
   `ELIGIBILITY_COLUMNS` must be selected for this to work.

**Fail-fast (`assertAllEligible`)** runs immediately before scoring and inside
`buildScoringContext` (the choke point all batch scoring flows through). If an
excluded account reaches scoring it **throws** with `id`, `email`, `reason`, and
`codePath` — it never silently filters. This makes it impossible to ship a bypass
of the canonical filter unnoticed.

## 2. Scoring pipeline (`batch-scoring.ts`)

`buildScoringContext(profiles)` computes cohort **rarity factors** once, then
`scoreMatch(recipient, candidate, ctx)` scores each ordered pair. Components:

- **Intro-preference** match (+30) / reverse (+20).
- **Purpose alignment** — rarity-weighted, diminishing returns (see below).
- **Expertise complementarity** — partial overlap only, capped at 5 items × 8.
  *Unchanged from v1 — the network's dominant, legitimate signal (~42% of score).*
- **Geography / meeting-format / seniority / interests / mentorship** — fixed bonuses.
- **Member-quality amplifiers** — tier, network, verification, trust.
- **Promotion** — `boost_score × boostMultiplier`, `is_priority → +priorityBonus`
  (0 when unset → identical to a non-promoted member).

Score is a finite integer, stored in `batch_suggestions.match_score` (`numeric(6,2)`).

### Purpose / interest: rarity weighting (IDF)

Common intents (e.g. "Networking", chosen by 57% of members) carry little signal;
rare shared intents (e.g. "Fundraising", 7%) mean much more. Each shared item is
weighted by its inverse document frequency, **centered on 1.0 for the typical
shared item** so the model is *scale-preserving* (we redistribute weight
common→rare, we do not deflate scores against the threshold):

```
idf(df)     = log((N+1)/(df+1)) / log(N+1)          # (0,1]: df=1→~1 rare, df=N→0 universal
rarity(p)   = clamp( idf(p) / E[idf over sharing-pairs], min, max )   # centered ~1.0
```

### Purpose / interest: diminishing returns

To stop a member who selected many purposes from dominating, shared items are
summed rarest-first with a geometric decay:

```
overlapScore = base · Σ_i rarity(item_i) · decay^i     # bounded by base·maxRarity/(1-decay)
```

Each additional shared item adds less. Expertise already has its own cap, so it is
left linear.

### Exposure balancing (`exposureAdjustedScore`)

A **continuous** penalty nudges ranking toward less-exposed candidates among
near-equals: `effective = raw − penaltyPerPick · min(timesPicked, penaltyCap)`
(≤6 pts). It only reorders genuine near-ties — it never changes bucket membership
or the relevance threshold (those use raw score), so a substantially better match
is never displaced. An **optional hard cap** (`maxPerBatch`) exists but is **off by
default**: a validation simulation showed a cap replaced genuinely superior
introductions (avg −9.4 pts) without improving candidate coverage. Quality-first.

## 3. Selection (in `generate-batch/route.ts`)

Per member (processed in a deterministic tier→id order): candidates are bucketed
by raw score (`BATCH_CONFIG.bucketHighMin/MidMin`), ranked by exposure-adjusted
score, then greedily filled to the tier quota (`BATCH_CONFIG.tierDistribution`),
honoring the same-role cap (`maxSameRolePercent`) and business-solution cap. All
ties break by id → deterministic, repeatable output. Batch row + suggestions are
written with compensating cleanup (no orphan batch on failure).

## 4. Configuration (all tuning lives in `batch-scoring.ts`)

| Constant | Purpose |
|---|---|
| `SCORING_CONFIG.purposeBase / interestBase` | Weight of a *typical* shared purpose/interest. |
| `SCORING_CONFIG.purposeDecay / interestDecay` | Diminishing-returns factor per additional overlap. |
| `SCORING_CONFIG.rarityClampMin / rarityClampMax` | Bounds on the rarity factor (never 0, never runaway). |
| `SCORING_CONFIG.boostMultiplier / priorityBonus` | Promotion levers. |
| `EXPOSURE_CONFIG.penaltyPerPick / penaltyCap` | Continuous exposure nudge (bounded). |
| `EXPOSURE_CONFIG.maxPerBatch` | Optional hard exposure cap (`null` = disabled). |
| `BATCH_CONFIG.minRelevanceScore` | Relevance threshold (pairs below are ignored). |
| `BATCH_CONFIG.bucketHighMin / bucketMidMin` | Score-bucket cutoffs. |
| `BATCH_CONFIG.maxSameRolePercent` | Role-diversity cap per member. |
| `BATCH_CONFIG.tierDistribution` | Suggestions per member by subscription tier. |

## 5. Algorithm versioning (reproducibility)

Every generated batch is stamped (columns on `introduction_batches`, migration 018)
with:

- `algorithm_version` (`RECOMMENDATION_ALGORITHM_VERSION`, e.g. `"v2"`),
- `scoring_model_version` (`SCORING_MODEL_VERSION`),
- `algorithm_config` — a full JSON snapshot of `SCORING_CONFIG` + `EXPOSURE_CONFIG` + `BATCH_CONFIG` (`algorithmSnapshot()`),
- `config_hash` — a deterministic FNV-1a hash of that snapshot (`algorithmConfigHash()`),
- `created_at` — the generation timestamp.

**Why:** so we can compare historical batches, know exactly which algorithm and
config produced any batch, reproduce results, evolve the algorithm safely, and
analyze performance across versions. The version + config hash are surfaced in the
admin batch UI and returned in the generation API response.

**How to introduce a new version:**

1. Make the algorithm change behind the existing config where possible.
2. **Bump `RECOMMENDATION_ALGORITHM_VERSION`** (e.g. `v2` → `v3`) whenever the change
   alters *which suggestions* a batch would produce — scoring components, the
   rarity/decay model, selection, or exposure logic. Bump `SCORING_MODEL_VERSION`
   for scoreMatch-model changes specifically. Do **not** bump for pure refactors
   (the config hash already distinguishes tuning changes within a version).
3. Validate the new version with the offline simulation/ablation before shipping,
   exactly as v2 was (rarity → diminishing returns → exposure → final).
4. Old batches keep their recorded version/config, so history stays interpretable.

The write is deploy-safe: if migration 018 isn't applied yet, the batch is still
created (without the version columns) and a warning is logged.

## 6. Scalability

Batch generation is **O(n²)** (all ordered pairs are scored). It is admin-triggered
(weekly), not per-request, so this is acceptable at current and near-term scale:

| Members | Pairs scored | Note |
|---|---|---|
| 46 (today) | ~2k | instant |
| 500 | ~250k | sub-second |
| 5,000 | ~25M | seconds; still fine for an offline admin job |
| 50,000 | ~2.5B | **needs blocking** — pre-filter candidates (by role/geo/expertise) before scoring, or shard by cohort. |

Do not optimize prematurely. When the network approaches ~10k members, replace the
all-pairs loop with a candidate-generation (blocking) step so only plausible pairs
are scored.
