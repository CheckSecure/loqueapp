/**
 * Andrel BATCH match scoring (v2) — pairwise relevance for admin batch generation.
 *
 * Single source of truth for the batch route's scoreMatch, shared by the route,
 * the offline simulator, and tests. Every weight is a named constant in
 * SCORING_CONFIG so the model stays explainable and tunable without code edits.
 * (Distinct from lib/matching/scoring.ts, which is the onboarding 55/30/15 model.)
 *
 * What changed vs v1 (each is evidence-backed against production data):
 *
 *  1. Boost fix — v1 read candidate.boost_score / candidate.is_priority but the
 *     batch route never SELECTed those columns, so promotion was silently dead.
 *     They're included here; when both are 0/absent the score is identical to
 *     before (boostBonus = 0, no priority bump).
 *
 *  2. Rarity-weighted shared intent (IDF) — v1 gave every shared purpose a flat
 *     +12, but "Networking" is chosen by 57% of members, so a shared Networking
 *     (low information) counted as much as a shared "Fundraising" (7%). We weight
 *     each shared purpose/interest by inverse document frequency, rewarding
 *     uncommon, meaningful shared intent over near-universal selections.
 *     idf(df)=log((N+1)/(df+1))/log(N+1) ∈ (0,1]: df=1→≈1 (rare), df=N→0.
 *
 *  3. Diminishing returns — v1 grew purpose/interest LINEARLY and unbounded
 *     (6 shared purposes = +72). We sum the rarity weights rarest-first with a
 *     geometric decay so each additional shared item counts less. Bounded by
 *     scale·maxWeight/(1-decay). Expertise already had a cap + complementarity
 *     rule and is the network's dominant, legitimate signal (42% of score), so it
 *     is deliberately LEFT UNCHANGED to preserve the strongest matches.
 */

/**
 * Recommendation-engine version. BUMP whenever a change alters which suggestions
 * a batch would produce (scoring components, rarity/decay model, selection, or
 * exposure logic) — NOT for pure refactors. Stored on every generated batch so we
 * can compare historical batches, know exactly which algorithm produced one, and
 * evolve safely. `scoringModelVersion` tracks the scoreMatch model specifically.
 */
// v3.4: SAME-SIDE LEGAL PAIRS ARE ABSOLUTELY EXCLUDED. Two law-firm-side members are never
// introduced to each other — partner↔partner, partner↔attorney AND attorney↔attorney alike.
// This is a HARD GATE at pair construction, applied alongside eligibility and same-company, so
// no such edge is ever built and no selection pass can emit one however thin the pool gets.
// v3.3 shipped only a soft -32/-24 ranking preference and let 14 same-side partner pairs into
// one production review batch; ranking cannot express "never", because a penalised score still
// wins when nothing else is available. An interim two-pass draft excluded partner-involving
// edges from the primary pass but reintroduced them on residual capacity, and never covered
// attorney↔attorney at all. Both are superseded. The pairwise scoring
// model (scoreMatch / rarity / decay) is UNCHANGED — no score penalty is applied here
// (that would remove last-resort edges below the relevance gate), so SCORING_MODEL_VERSION
// stays v2.0.0; only RECOMMENDATION_ALGORITHM_VERSION bumps v3.3 → v3.4 per the contract.
// Lineage: v3 (reciprocal, greedy-only) → v3.1 (Pareto-safe augmenting-path phase) → v3.2
// (business-solution throttle fix) → v3.3 (soft cross-market preference) → v3.4 (absolute
// same-side legal exclusion at the gate).
// See app/api/admin/generate-batch/route.ts and lib/matching/legalSameSidePenalty.ts.

export const RECOMMENDATION_ALGORITHM_VERSION = 'v3.4'
export const SCORING_MODEL_VERSION = 'v2.0.0'

export type ScoringConfig = {
  purposeBase: number
  purposeDecay: number
  interestBase: number
  interestDecay: number
  rarityClampMin: number
  rarityClampMax: number
  boostMultiplier: number
  priorityBonus: number
}

/**
 * SCALE-PRESERVING calibration. Rarity is expressed as a factor CENTERED ON 1.0
 * for the *typical* shared item, so the average purpose/interest contribution is
 * unchanged from v1 — we redistribute weight (common→rare), we do NOT deflate
 * scores (deflating against a fixed threshold would just silently cut matches,
 * which the objective forbids). A gentle geometric decay tempers maximalist
 * multi-overlap without gutting it.
 */
/**
 * ─── ANDREL NEXT SCORING SEMANTICS ────────────────────────────────────────────────────────────
 *
 * The ONE term whose meaning differs by community, and the floor that term is measured against.
 *
 * WHY EXPERTISE MEANS SOMETHING ELSE FOR STUDENTS. For professionals, `expertise` is answered as
 * "what I do", and the scorer rewards COMPLEMENTARITY: partial overlap scores, an identical or
 * subset pair scores zero, because two people who do exactly the same thing are usually
 * competitors rather than a useful introduction. For an Andrel Next member the same column is
 * answered as "the areas of law I am interested in", and two students both specifically interested
 * in Privacy & Cybersecurity are one of the best introductions the cohort can make. Same column,
 * opposite meaning — which is why this is a semantics branch and not a weighting tweak.
 *
 * WHY IT REUSES overlapScore RATHER THAN INVENTING A FORMULA. Purposes and interests are already
 * scored as rarity-weighted overlap with geometric decay, and that machinery solves the small-cohort
 * problem for free: in a 50-student cohort a niche practice area is genuinely rare and earns up to
 * rarityClampMax x base, while a near-universal one is damped to rarityClampMin x base. A second
 * formula would be a second thing to calibrate, and a second thing to drift.
 *
 * ONE ACCURATE SELECTION IS ENOUGH. base is applied per shared item with no minimum-selection
 * requirement, so a student who honestly picks a single practice area gets a real signal. Nobody is
 * asked to over-select to satisfy the scorer.
 */
export const NEXT_SCORING_CONFIG = {
  /**
   * Per shared practice interest, before rarity. Slightly above purposeBase (12) because shared
   * professional direction is the strongest student signal available, and deliberately below the
   * 30/20 the intro-preference term is worth for professionals — a role-less member scores nothing
   * there, and this is not trying to replace it point for point.
   */
  expertiseBase: 14,
  /** The same geometric decay purposes and interests already use. One decay constant, three fields. */
  expertiseDecay: 0.75,
  /**
   * PROVISIONAL. The weekly-batch relevance floor for a Next cohort.
   *
   * Professional's 40 sits at roughly the 20-25th percentile of its observed distribution. A Next
   * pair cannot earn the intro-preference term at all (a student has no role_type), cannot earn the
   * seniority term (NULL), and earns nothing from tier, verification or trust while the cohort is
   * new — so its reachable range is far narrower, and 40 would sit near its 60th percentile.
   * 28 is the proportionally equivalent floor on that narrower range.
   *
   * WHAT 28 STILL EXCLUDES, which is the point: format alignment plus one near-universal shared
   * goal is 13, and that does not qualify. A pair must earn at least one substantive shared
   * signal — a practice area, two-plus interests, or geography plus a real goal.
   *
   * IT IS PROVISIONAL BECAUSE THERE IS NO PRODUCTION NEXT SCORE DISTRIBUTION YET. No Andrel Next
   * member exists. This number is derived from the reachable-range ratio, not measured, and the
   * per-community histogram added alongside it is what will let it be revisited against the first
   * real batch rather than argued about.
   */
  minRelevanceScore: 28,
} as const

export const SCORING_CONFIG: ScoringConfig = {
  purposeBase: 12,      // a TYPICAL shared purpose ≈ 12 (= old flat weight); rare > 12, "Networking" < 12
  purposeDecay: 0.75,   // each further shared purpose (rarest-first) = 75% of the previous
  interestBase: 10,     // a typical shared interest ≈ 10 (= old flat weight)
  interestDecay: 0.75,
  rarityClampMin: 0.25, // a near-universal shared item still counts ≥ 25% of base (never zero)
  rarityClampMax: 2.5,  // a singleton-rare shared item counts ≤ 2.5× base (never runaway)
  boostMultiplier: 2,   // boost_score (0–100) × 2 — unchanged mechanic, now actually applied
  priorityBonus: 50,    // is_priority flat bump — unchanged
}

/**
 * Batch selection / threshold knobs — the tuning values the generation loop uses
 * AROUND scoring. Centralized here (not scattered as literals in the route) so all
 * recommendation tuning lives in one documented place.
 */
export const BATCH_CONFIG = {
  /** Pairs whose average score is below this are not considered at all. */
  minRelevanceScore: 40,
  /** score ≥ bucketHighMin → high_score bucket; ≥ bucketMidMin → mid_score; else low_score. */
  bucketHighMin: 70,
  bucketMidMin: 50,
  /** Max fraction of one member's batch that may share a single role_type (diversity). */
  maxSameRolePercent: 0.4,
  /** Suggestions per member by subscription tier: {high, mid, total} slots. */
  tierDistribution: {
    free: { high: 1, mid: 2, total: 3 },
    professional: { high: 3, mid: 2, total: 5 },
    executive: { high: 5, mid: 3, total: 8 },
  } as Record<string, { high: number; mid: number; total: number }>,
  /**
   * LAUNCH-PHASE cap on introductions per member across ALL tiers. An intentional
   * product decision for the small early network: deliver 2 exceptional intros
   * rather than a possibly-weaker 3rd, preserving inventory while the network
   * grows. Set to `null` to let each tier use its natural `total` (e.g. once the
   * network is dense enough to raise it back to 3+). One number to change.
   */
  // References the single central constant so onboarding, weekly releases, and the
  // admin reciprocal batch all deliver the same configured number per member.
  introductionsPerMemberCap: RECOMMENDATIONS_PER_BATCH as number | null,
}

/**
 * A tier's effective distribution AFTER applying the launch cap. `total` is capped
 * to `introductionsPerMemberCap`, and `high` can't exceed it; `mid` is advisory
 * (selection fills mid up to the remaining total). Single source of truth for both
 * the selection loop and the per-recipient limit invariant.
 */
export function effectiveTierDistribution(tier: string | null | undefined): { high: number; mid: number; total: number } {
  const nat = BATCH_CONFIG.tierDistribution[tier || 'free'] || BATCH_CONFIG.tierDistribution.free
  const cap = BATCH_CONFIG.introductionsPerMemberCap
  if (cap == null) return nat
  return { high: Math.min(nat.high, cap), mid: nat.mid, total: Math.min(nat.total, cap) }
}

export type Frequencies = Map<string, number>
/** Rarity factor per item, centered on 1.0 for the typical shared item (scale-preserving). */
export type RarityMap = Map<string, number>
/**
 * Which community's semantics a cohort is scored under.
 *
 * DERIVED, NEVER PASSED BY A CALLER. buildScoringContext reads it from the cohort's own
 * profiles.member_type — the column migration 100 binds at INSERT and migration 099 makes
 * immutable — which is the same value partitionByCommunity already used to build that cohort.
 * There is deliberately no parameter for a call site to get wrong, and nothing here can be
 * influenced by a request body, a URL, a UI prop or an email.
 */
export type ScoringSemantics = MemberType

export type ScoringContext = {
  memberCount: number
  purposeRarity: RarityMap
  interestRarity: RarityMap
  /**
   * Rarity for practice interests, built exactly like the other two. Present for every cohort so the
   * shape is uniform; only Next semantics read it, and for a Professional cohort it is inert.
   */
  expertiseRarity: RarityMap
  /** See ScoringSemantics. Fails closed to DEFAULT_MEMBER_TYPE. */
  semantics: ScoringSemantics
  config: ScoringConfig
}

import { assertAllEligible } from '@/lib/matching/eligibility'
import { communityOf, DEFAULT_MEMBER_TYPE, type MemberType } from '@/lib/community/memberType'
import { preferenceMatchesRole } from '@/lib/matching/introPreferenceMatch'
import { RECOMMENDATIONS_PER_BATCH } from '@/lib/introductions/limits'

const low = (s: unknown) => String(s ?? '').toLowerCase().trim()
const uniqLow = (arr: unknown): string[] => Array.isArray(arr) ? Array.from(new Set(arr.map(low).filter(Boolean))) : []

/** Robust list normalizer (array | JSON | pg-array | csv | single), matching parseExpertise. */
export function parseList(value: unknown): string[] {
  if (value == null) return []
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean)
  if (typeof value !== 'string') return []
  let t = value.trim()
  if (!t || t === '{}' || t === '[]') return []
  if (t.startsWith('[') && t.endsWith(']')) { try { const j = JSON.parse(t); if (Array.isArray(j)) return j.map((x: any) => String(x).trim()).filter(Boolean) } catch { /* fall through */ } }
  if (t.startsWith('{') && t.endsWith('}')) t = t.slice(1, -1)
  return t.split(',').map(x => x.replace(/^"|"$/g, '').trim()).filter(Boolean)
}

/** Inverse document frequency normalized to (0,1]. df=1→≈1 (rare), df=N→0 (universal). */
export function idfWeight(df: number, memberCount: number): number {
  const N = Math.max(1, memberCount)
  return Math.log((N + 1) / (Math.max(0, df) + 1)) / Math.log(N + 1)
}

/**
 * Build the per-item rarity factor for one field, CENTERED ON 1.0 for the typical
 * shared item so the model is scale-preserving. The typical shared item is the
 * pairs-weighted average (a purpose selected by d members yields ~C(d,2) sharing
 * pairs), so:  factor(p) = clamp( idf(p) / E[idf over sharing pairs], min, max ).
 * Common items land below 1, rare items above 1, and the average stays ≈ 1.
 */
export function buildRarity(df: Frequencies, memberCount: number, min: number, max: number): RarityMap {
  const out: RarityMap = new Map()
  let wsum = 0, psum = 0
  for (const [, d] of Array.from(df.entries())) { const pairs = d >= 2 ? (d * (d - 1)) / 2 : 0; wsum += pairs * idfWeight(d, memberCount); psum += pairs }
  const E = psum > 0 ? wsum / psum : 1 // fallback: no item shared by ≥2 → neutral
  for (const [item, d] of Array.from(df.entries())) {
    const factor = (idfWeight(d, memberCount) / (E || 1))
    out.set(item, Math.max(min, Math.min(max, factor)))
  }
  return out
}

/**
 * Rarity-weighted, diminishing-returns overlap score. Deterministic: shared items
 * are weighted by their rarity factor, sorted rarest-first (tie-break by name),
 * then summed with a geometric decay.  score = base · Σ_i rarity(item_i)·decay^i
 * A single typical shared item ≈ base; each additional shared item counts less.
 */
export function overlapScore(shared: string[], rarity: RarityMap, base: number, decay: number): number {
  if (shared.length === 0) return 0
  const weighted = shared
    .map(item => ({ item, w: rarity.get(item) ?? 1 }))
    .sort((a, b) => b.w - a.w || a.item.localeCompare(b.item))
  let sum = 0
  for (let i = 0; i < weighted.length; i++) sum += weighted[i].w * Math.pow(decay, i)
  return base * sum
}

/**
 * Build the cohort context (rarity factors) scoreMatch needs. This is the single
 * choke point for all batch scoring, so it FAILS FAST if any excluded account
 * reached the pool — an excluded member can never influence rarity/IDF, scoring,
 * or exposure balancing without the generation aborting loudly.
 */
export function buildScoringContext(profiles: any[], config: ScoringConfig = SCORING_CONFIG, codePath = 'buildScoringContext'): ScoringContext {
  assertAllEligible(profiles, codePath)
  const purposeDf: Frequencies = new Map()
  const interestDf: Frequencies = new Map()
  const expertiseDf: Frequencies = new Map()
  for (const p of profiles) {
    for (const x of uniqLow(p.purposes)) purposeDf.set(x, (purposeDf.get(x) ?? 0) + 1)
    for (const x of uniqLow(p.interests)) interestDf.set(x, (interestDf.get(x) ?? 0) + 1)
    for (const x of uniqLow(parseList(p.expertise))) expertiseDf.set(x, (expertiseDf.get(x) ?? 0) + 1)
  }
  return {
    memberCount: profiles.length,
    purposeRarity: buildRarity(purposeDf, profiles.length, config.rarityClampMin, config.rarityClampMax),
    interestRarity: buildRarity(interestDf, profiles.length, config.rarityClampMin, config.rarityClampMax),
    expertiseRarity: buildRarity(expertiseDf, profiles.length, config.rarityClampMin, config.rarityClampMax),
    semantics: cohortSemantics(profiles, codePath),
    config,
  }
}

/**
 * The community a cohort is scored as, read from the cohort itself.
 *
 * ─── FAIL CLOSED, ON EVERY UNCERTAINTY ────────────────────────────────────────────────────────
 * An empty cohort, a cohort whose members disagree, or any member whose member_type is absent or
 * unrecognised all yield DEFAULT_MEMBER_TYPE — Professional, which is what every existing member
 * is and what today's semantics already produce. The dangerous direction would be the reverse:
 * a cohort silently scored under Next semantics would change Professional results.
 *
 * A DISAGREEING COHORT SHOULD BE IMPOSSIBLE. The generate-batch route calls this once per
 * partitionByCommunity partition, and those partitions are disjoint by construction. The assertion
 * exists because "impossible by construction" is a property of today's caller, not of the function,
 * and a future caller that hoisted the wrong variable would otherwise score a mixed cohort silently.
 * It reports and degrades rather than throwing: a batch that still runs under Professional
 * semantics is a better failure than a batch that does not run.
 */
export function cohortSemantics(profiles: any[], codePath = 'cohortSemantics'): ScoringSemantics {
  if (!Array.isArray(profiles) || profiles.length === 0) return DEFAULT_MEMBER_TYPE
  const first = communityOf(profiles[0])
  if (first === null) {
    console.warn(`[${codePath}] cohort semantics: unrecognised member_type; scoring as ${DEFAULT_MEMBER_TYPE}`)
    return DEFAULT_MEMBER_TYPE
  }
  for (const p of profiles) {
    if (communityOf(p) !== first) {
      // Aggregate only — no member id, name, email or company.
      console.error(`[${codePath}] cohort semantics: MIXED COMMUNITY cohort; scoring as ${DEFAULT_MEMBER_TYPE}`)
      return DEFAULT_MEMBER_TYPE
    }
  }
  return first
}

/**
 * The weekly-batch relevance floor for a cohort's community.
 *
 * Selected from the cohort's own derived semantics, never from an argument a caller supplies.
 * Professional is BATCH_CONFIG.minRelevanceScore and is unchanged at 40.
 */
export function relevanceFloorFor(semantics: ScoringSemantics): number {
  return semantics === 'next' ? NEXT_SCORING_CONFIG.minRelevanceScore : BATCH_CONFIG.minRelevanceScore
}

/** Pairwise score of `candidate` for `recipient` (direction matters). */
export function scoreMatch(recipient: any, candidate: any, ctx: ScoringContext): number {
  const cfg = ctx.config
  let score = 0

  // Promotion levers (0 when unset → identical to a non-promoted member).
  score += (Number(candidate.boost_score) || 0) * cfg.boostMultiplier
  if (candidate.is_priority) score += cfg.priorityBonus

  // 1–2. Intro-preference match (directional)
  //
  // These two columns hold DIFFERENT VOCABULARIES. intro_preferences stores role CATEGORIES
  // ('Legal', 'Executive / C-Suite') or relationships ('Founders'); role_type stores job TITLES
  // ('General Counsel', 'Law Firm Partner'). The previous test was array membership on the
  // lowercased title, so 'Legal' never matched 'General Counsel' and this bonus — 50 of the 40
  // points needed to clear MIN_RELEVANCE_SCORE — fired for essentially nobody. On production
  // exactly ONE member held a role_type that literally equalled a preference value.
  //
  // preferenceMatchesRole resolves the title to its taxonomy category (lib/role-taxonomy.ts,
  // already the source of truth for every edit surface) and compares THAT. Unknown preference
  // values fall back to the old exact match, so nothing that worked before stops working.
  //
  // SCOPE: deliberately wired here only. lib/generate-recommendations.ts (3 sites) and
  // app/api/admin/batch/[batchId]/generate-replacements/route.ts still compare raw strings with
  // their own semantics, so the admin batch can be measured on its own. See
  // docs/FOLLOWUP_INTRO_PREFERENCE_VOCABULARY.md.
  const rPref = parseList(recipient.intro_preferences)
  const cPref = parseList(candidate.intro_preferences)
  if (rPref.some((p) => preferenceMatchesRole(p, candidate.role_type))) score += 30
  if (cPref.some((p) => preferenceMatchesRole(p, recipient.role_type))) score += 20

  // 3. Purpose alignment — rarity-weighted, diminishing returns
  const sharedPurposes = uniqLow(recipient.purposes).filter(p => uniqLow(candidate.purposes).includes(p))
  score += overlapScore(sharedPurposes, ctx.purposeRarity, cfg.purposeBase, cfg.purposeDecay)

  // 4. Expertise — THE ONE TERM WHOSE MEANING DEPENDS ON THE COMMUNITY.
  //
  // PROFESSIONAL: complementarity, byte-for-byte unchanged. Partial overlap scores min(5,n)x8;
  // an identical or subset pair scores ZERO, because two professionals who do exactly the same
  // thing are usually competitors rather than a useful introduction. Every branch of this is
  // frozen in lib/__tests__/professional-scoring-golden.test.ts.
  //
  // NEXT: similarity. The same column is answered as "the areas of law I am interested in", and two
  // students both specifically interested in Privacy & Cybersecurity are one of the best
  // introductions the cohort can make — so a shared item is a POSITIVE signal, and an identical
  // single-item pair is the strongest case rather than the weakest. Scored with the same
  // rarity-weighted, geometric-decay machinery purposes and interests already use, so a niche
  // practice area in a small cohort is automatically worth more than a near-universal one, and one
  // honestly-chosen area is enough. No overlap contributes zero — never a rejection, just no signal.
  // An empty set on either side shares nothing and therefore scores zero, which is exactly how
  // "still exploring" is intended to behave without ever being stored as a value.
  //
  // ctx.semantics is DERIVED from the cohort's own immutable member_type (see cohortSemantics);
  // there is no argument here a caller could get wrong, and it fails closed to professional.
  const rExp = uniqLow(parseList(recipient.expertise))
  const cExp = uniqLow(parseList(candidate.expertise))
  const sharedExpertise = rExp.filter(e => cExp.includes(e))
  if (ctx.semantics === 'next') {
    score += overlapScore(sharedExpertise, ctx.expertiseRarity,
      NEXT_SCORING_CONFIG.expertiseBase, NEXT_SCORING_CONFIG.expertiseDecay)
  } else {
    const expOverlap = sharedExpertise.length
    if (expOverlap > 0 && expOverlap < Math.min(rExp.length, cExp.length)) score += Math.min(5, expOverlap) * 8
  }

  // 5. Geographic alignment
  const scope = recipient.geographic_scope || 'us-wide'
  const sameCity = !!low(recipient.city) && low(recipient.city) === low(candidate.city)
  const sameState = !!low(recipient.state) && low(recipient.state) === low(candidate.state)
  if (scope === 'local' && (sameCity || sameState)) score += 15
  else if (sameCity) score += 8
  else if (sameState) score += 5

  // 6. Meeting-format alignment
  const rFmt = recipient.meeting_format_preference || 'both'
  const cFmt = candidate.meeting_format_preference || 'both'
  if (rFmt === cFmt) score += 10
  else if (rFmt === 'both' || cFmt === 'both') score += 5

  // 7. Seniority strategic pairing
  const rSen = low(recipient.seniority), cSen = low(candidate.seniority)
  const senior = ['senior', 'executive', 'c-suite']
  if (rSen === 'junior' && senior.includes(cSen)) score += 12
  else if (senior.includes(rSen) && cSen === 'junior') score += 8
  else if (rSen === cSen && rSen) score += 5

  // 8. Interests overlap — rarity-weighted, diminishing returns
  const sharedInterests = uniqLow(recipient.interests).filter(i => uniqLow(candidate.interests).includes(i))
  score += overlapScore(sharedInterests, ctx.interestRarity, cfg.interestBase, cfg.interestDecay)

  // 9. Mentorship compatibility
  const rM = low(recipient.mentorship_role), cM = low(candidate.mentorship_role)
  if ((rM === 'mentor' && cM === 'mentee') || (rM === 'mentee' && cM === 'mentor')) score += 25

  // 10–13. Member-quality amplifiers (candidate desirability)
  const tierBoost: Record<string, number> = { executive: 15, professional: 8, free: 0 }
  score += tierBoost[candidate.subscription_tier] ?? 0
  if (candidate.networkValueScore) score += Math.round((candidate.networkValueScore / 100) * 15)
  if (candidate.responsivenessScore) score += Math.round((candidate.responsivenessScore / 100) * 5)
  const verif: Record<string, number> = { high_confidence: 12, verified: 15, pending: 0, flagged: -20 }
  score += verif[candidate.verification_status] ?? 0
  if (candidate.trust_score) score += Math.round((candidate.trust_score / 100) * 10)

  // NOTE: the cross-market-first legal rule is enforced in the batch route's TWO-PASS
  // SELECTION (primary pass excludes partner-involving same-side edges; the coverage
  // fallback re-adds them only when a partner can't otherwise be seated). It is
  // deliberately NOT a scoreMatch penalty here: a score penalty would drop a same-side
  // edge below the relevance gate and REMOVE it from the candidate pool, which would
  // eliminate the last-resort fallback (a member left with 0 intros instead of one
  // same-side pair). Keeping scoreMatch penalty-free preserves true relevance so the
  // fallback can seat those members. See app/api/admin/generate-batch/route.ts.

  return Math.round(score)
}

/**
 * Deterministic exposure-balancing config (Part 4), validated against production.
 *
 *   - penaltyPerPick/penaltyCap: a GENTLE, continuous ranking nudge so that among
 *     candidates of near-equal quality the less-exposed one is preferred. Bounded
 *     nudge = penaltyPerPick × min(picks, penaltyCap) = 6 pts max → only reorders
 *     genuine near-ties; a substantially better match is never displaced. This is
 *     the sole balancing mechanism (adds +2 distinct candidates at ~0 quality cost).
 *
 *   - maxPerBatch: an OPTIONAL hard exposure cap, DISABLED by default (null).
 *     A validation simulation (continuous-only vs cap=8) showed a cap of 8 changed
 *     14 introductions with an average −9.4-pt quality drop and replaced 2 clearly
 *     superior matches (e.g. a 121-score best match swapped for an 85), while NOT
 *     improving candidate coverage (distinct/never-suggested were unchanged — the
 *     cap merely redistributes among already-visible candidates). Because that
 *     violates quality-first ("fewer, not weaker"), the cap is left OFF. The
 *     mechanism is retained + configurable in case a future, larger, less
 *     homogeneous network needs a high safety bound.
 */
export type ExposureConfig = { penaltyPerPick: number; penaltyCap: number; maxPerBatch: number | null }
export const EXPOSURE_CONFIG: ExposureConfig = { penaltyPerPick: 2, penaltyCap: 3, maxPerBatch: null }

/**
 * Effective ranking score used ONLY to ORDER candidates during selection — it
 * never changes bucket membership or the MIN_RELEVANCE gate (those use raw score),
 * so no weak match is introduced. Bounded nudge = penaltyPerPick × min(picked, cap).
 */
export function exposureAdjustedScore(rawScore: number, timesPicked: number, cfg: ExposureConfig = EXPOSURE_CONFIG): number {
  return rawScore - cfg.penaltyPerPick * Math.min(timesPicked, cfg.penaltyCap)
}

// ─────────────────────────── Versioning / reproducibility ───────────────────────────

/** Full, serializable snapshot of the algorithm version + every tuning config. */
export function algorithmSnapshot() {
  return {
    version: RECOMMENDATION_ALGORITHM_VERSION,
    scoringModelVersion: SCORING_MODEL_VERSION,
    scoring: SCORING_CONFIG,
    // The Next semantics are part of what produced a batch, so they belong in the reproducibility
    // snapshot. Including them CHANGES THE CONFIG HASH for Professional batches too — accepted
    // deliberately: the hash is a provenance stamp, and the configuration genuinely changed. It is
    // not a scoring change, and the Professional golden fixtures prove that separately.
    next: NEXT_SCORING_CONFIG,
    exposure: EXPOSURE_CONFIG,
    batch: BATCH_CONFIG,
  }
}

/** Canonical JSON with sorted keys, so the hash is stable regardless of key order. */
function canonicalJson(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',')}}`
}

/**
 * Deterministic short hash (FNV-1a) of the config snapshot — stored alongside the
 * full JSON so batches produced by identical configs share a hash and any config
 * change is instantly visible. Dependency-free (no node crypto), stable across
 * runs and environments.
 */
export function algorithmConfigHash(): string {
  const json = canonicalJson(algorithmSnapshot())
  let h = 0x811c9dc5
  for (let i = 0; i < json.length; i++) { h ^= json.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}
