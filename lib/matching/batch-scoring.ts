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
// v3.2: reciprocal graph + augmenting-path coverage phase + corrected business-solution
// throttle. The pairwise scoring model (scoreMatch / rarity / decay) is unchanged —
// SCORING_MODEL_VERSION stays v2.0.0. Lineage: v3 (reciprocal, greedy-only) → v3.1 (adds
// Pareto-safe augmenting-path phase) → v3.2 (business-solution throttle fixed: provider↔
// provider peer edges exempted, and opted-in buyers guaranteed ≥1 provider at any cap, so
// providers are no longer mathematically unmatchable at the launch cap of 2). v3.2 alters
// which suggestions a batch produces, so it is bumped per the versioning contract below.
// See lib/matching/reciprocal-graph.ts and lib/matching/business-solutions.ts.
export const RECOMMENDATION_ALGORITHM_VERSION = 'v3.2'
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
export type ScoringContext = { memberCount: number; purposeRarity: RarityMap; interestRarity: RarityMap; config: ScoringConfig }

import { assertAllEligible } from '@/lib/matching/eligibility'
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
  for (const p of profiles) {
    for (const x of uniqLow(p.purposes)) purposeDf.set(x, (purposeDf.get(x) ?? 0) + 1)
    for (const x of uniqLow(p.interests)) interestDf.set(x, (interestDf.get(x) ?? 0) + 1)
  }
  return {
    memberCount: profiles.length,
    purposeRarity: buildRarity(purposeDf, profiles.length, config.rarityClampMin, config.rarityClampMax),
    interestRarity: buildRarity(interestDf, profiles.length, config.rarityClampMin, config.rarityClampMax),
    config,
  }
}

/** Pairwise score of `candidate` for `recipient` (direction matters). */
export function scoreMatch(recipient: any, candidate: any, ctx: ScoringContext): number {
  const cfg = ctx.config
  let score = 0

  // Promotion levers (0 when unset → identical to a non-promoted member).
  score += (Number(candidate.boost_score) || 0) * cfg.boostMultiplier
  if (candidate.is_priority) score += cfg.priorityBonus

  // 1–2. Intro-preference match (directional)
  const rPref = uniqLow(recipient.intro_preferences)
  const cPref = uniqLow(candidate.intro_preferences)
  if (rPref.includes(low(candidate.role_type))) score += 30
  if (cPref.includes(low(recipient.role_type))) score += 20

  // 3. Purpose alignment — rarity-weighted, diminishing returns
  const sharedPurposes = uniqLow(recipient.purposes).filter(p => uniqLow(candidate.purposes).includes(p))
  score += overlapScore(sharedPurposes, ctx.purposeRarity, cfg.purposeBase, cfg.purposeDecay)

  // 4. Expertise complementarity — UNCHANGED (core signal): partial overlap, capped at 5
  const rExp = uniqLow(parseList(recipient.expertise))
  const cExp = uniqLow(parseList(candidate.expertise))
  const expOverlap = rExp.filter(e => cExp.includes(e)).length
  if (expOverlap > 0 && expOverlap < Math.min(rExp.length, cExp.length)) score += Math.min(5, expOverlap) * 8

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
