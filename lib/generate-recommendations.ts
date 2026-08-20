import { createAdminClient } from '@/lib/supabase/admin'
import { enqueueBatch, type BatchSource, type EnqueueResult, countUnresolvedRecommendations } from '@/lib/introductions/queue'
import { getEffectiveTier } from '@/lib/tier-override'
import { getReferralExclusionsForUser } from '@/lib/referrals/exclusions'
import { isBusinessSolutionProvider, maxBusinessSolutionCount } from '@/lib/matching/business-solutions'
import { isSameCompany } from '@/lib/matching/same-company'
import { applyVerticalBoost } from '@/lib/matching/vertical-boost'
import { applyExposureBalancing, exposureBalancingEnabled } from '@/lib/matching/exposure-balancing'
import { readScoringSignals } from '@/lib/matching/profileScoring'
import { selectFairCounterparts } from '@/lib/matching/reciprocalPair'
import { createReciprocalSuggestion, type ReciprocalOutcome } from '@/lib/matching/createReciprocalSuggestion'
import { legalSameSidePenalty, crossMarketFirstForLawFirm } from '@/lib/matching/legalSameSidePenalty'
import { getActiveIntroCap, RECOMMENDATIONS_PER_BATCH } from '@/lib/introductions/limits'
import { introReasonText } from '@/lib/match-signals'
import { parseExpertise } from '@/lib/parseExpertise'
import { applyMemberEligibility, filterEligible, assertAllEligible, isEligibleMember, ELIGIBILITY_COLUMNS } from '@/lib/matching/eligibility'
import { classifyIntroHistory, exhaustionThreshold, ACTIVE_STATUSES } from '@/lib/introRequests/history'
import { shouldNotifyVisibleBatch, notifyNewVisibleBatch } from '@/lib/notifications/engagement'
import { VISIBLE_STATUS, RESERVED_STATUS, NO_EXPOSURE, visibleSlotsFree, type CardCounts } from '@/lib/introductions/capacity'

// Unified scoring model for all tiers
// Final Score = Alignment (55%) + Network Value (30%) + Responsiveness (15%)

// Deterministic (no randomness) alignment score, 0–100. Exported so the one-time
// migration backfill can rank a member's EXISTING suggested candidates by the same
// dominant component the live model used, without invoking the random tier jitter.
// This does not change live generation — rankCandidatesForUser is untouched.
export function calculateAlignmentScore(userProfile: any, candidate: any): number {
  let alignmentScore = 0
  
  // Goal/preference overlap (30 points)
  const userPrefs: string[] = Array.isArray(userProfile.intro_preferences) ? userProfile.intro_preferences : []
  const candidateRole: string = candidate.role_type || ''
  
  const roleMatch = userPrefs.some((pref: string) => {
    const prefLower = pref.toLowerCase()
    const roleLower = candidateRole.toLowerCase()
    return prefLower.includes(roleLower) || roleLower.includes(prefLower)
  })
  
  if (roleMatch) {
    alignmentScore += 30
  }
  
  // Seniority fit (20 points)
  const userSeniority = userProfile.seniority || ''
  const candidateSeniority = candidate.seniority || ''
  
  if (userSeniority === candidateSeniority) {
    alignmentScore += 20
  } else if (
    (userSeniority === 'Mid-Level' && (candidateSeniority === 'Senior' || candidateSeniority === 'Junior')) ||
    (userSeniority === 'Senior' && (candidateSeniority === 'Executive' || candidateSeniority === 'Mid-Level'))
  ) {
    alignmentScore += 10
  }
  
  // Expertise overlap (15 points max, capped)
  // Parse expertise - handle arrays, JSON strings, and PostgreSQL arrays
  const parseExpertise = (exp: any): string[] => {
    if (Array.isArray(exp)) return exp
    if (typeof exp === 'string') {
      // Try JSON parse
      try {
        const parsed = JSON.parse(exp)
        if (Array.isArray(parsed)) return parsed
      } catch {}
      
      // Try PostgreSQL array format: {item1,item2} or {"item1","item2"}
      if (exp.startsWith('{') && exp.endsWith('}')) {
        return exp.slice(1, -1)
          .split(',')
          .map(s => s.replace(/^"|"$/g, '').trim())
          .filter(Boolean)
      }
    }
    return []
  }
  
  const userExpertise = parseExpertise(userProfile.expertise)
  const candidateExpertise = parseExpertise(candidate.expertise)
  
  const sharedExpertise = userExpertise.filter(e => candidateExpertise.includes(e))
  alignmentScore += Math.min(sharedExpertise.length * 5, 15)
  
  // Location preference (normalized: 15 same city, 10 same region, 5 anywhere)
  if (userProfile.city && candidate.city && 
      userProfile.city.toLowerCase() === candidate.city.toLowerCase()) {
    alignmentScore += 15
  } else if (userProfile.state && candidate.state && 
             userProfile.state.toLowerCase() === candidate.state.toLowerCase()) {
    alignmentScore += 10
  } else {
    alignmentScore += 5 // Always some location value
  }
  
  // Total max: 30 + 20 + 15 + 15 = 80 points
  // Normalize to 0-100 scale
  return (alignmentScore / 80) * 100
}


// ==========================================
// CONSULTANT/LAW FIRM THROTTLING CONFIG
// ==========================================
// Cap math lives in lib/matching/business-solutions.ts (maxBusinessSolutionCount).
// isBusinessSolutionProvider is imported from the same module.


// ==========================================
// MENTORSHIP & JUNIOR USER DISTRIBUTION
// ==========================================

interface MentorshipConfig {
  juniorMaxPercentage: number       // Max % of juniors in senior batches
  seniorityLevels: {
    junior: string[]
    mid: string[]
    senior: string[]
  }
}

const MENTORSHIP_CONFIG: MentorshipConfig = {
  juniorMaxPercentage: 0.20,  // Max 20% juniors in senior batches
  seniorityLevels: {
    junior: ['Junior'],
    mid: ['Mid-Level', 'Mid-level'],
    senior: ['Senior', 'Executive', 'C-Suite']
  }
}

/**
 * Classify user seniority level
 */
function getUserSeniorityLevel(profile: any): 'junior' | 'mid' | 'senior' {
  const seniority = profile.seniority || ''
  
  if (MENTORSHIP_CONFIG.seniorityLevels.junior.includes(seniority)) {
    return 'junior'
  } else if (MENTORSHIP_CONFIG.seniorityLevels.mid.includes(seniority)) {
    return 'mid'
  } else if (MENTORSHIP_CONFIG.seniorityLevels.senior.includes(seniority)) {
    return 'senior'
  }
  
  // Default to mid if no seniority specified
  return 'mid'
}

/**
 * Check if a candidate should be filtered due to mentorship rules
 */
function shouldFilterByMentorship(
  userProfile: any,
  candidate: any,
  userSeniorityLevel: 'junior' | 'mid' | 'senior'
): boolean {
  const candidateSeniorityLevel = getUserSeniorityLevel(candidate)
  const userOpenToMentorship = userProfile.open_to_mentorship || false
  
  // Rule 1: Senior users with mentorship OFF should rarely see juniors
  if (userSeniorityLevel === 'senior' && candidateSeniorityLevel === 'junior') {
    if (!userOpenToMentorship) {
      // Strong suppression via scoring penalty (handled in scoring, not filtering)
      return false
    }
  }
  
  // Rule 2: Junior users should only see seniors if those seniors are open to mentorship
  if (userSeniorityLevel === 'junior' && candidateSeniorityLevel === 'senior') {
    const candidateOpenToMentorship = candidate.open_to_mentorship || false
    if (!candidateOpenToMentorship) {
      return true  // Filter out seniors who are NOT open to mentorship
    }
  }

  // Rule 3: Senior users default to peer matches. Mid-Level candidates surface
  // only when (a) the viewer has mentorship enabled, OR (b) the viewer's
  // intro_preferences explicitly include the candidate's role_type. Otherwise
  // filter. Unlike juniors (handled by scoring penalty + distribution cap),
  // Mid-Level candidates had no suppression of any kind — they freely flowed
  // to seniors with no opt-in signal. This rule closes that gap.
  if (userSeniorityLevel === 'senior' && candidateSeniorityLevel === 'mid') {
    if (userOpenToMentorship) return false
    const userPrefs: string[] = Array.isArray(userProfile.intro_preferences)
      ? userProfile.intro_preferences
      : []
    const candidateRole = String(candidate.role_type ?? '').toLowerCase()
    // Exact match (case-insensitive). Both fields store canonical role_type
    // strings; substring matching would create false positives if a non-role_type
    // value ever lands in intro_preferences.
    const explicitlyWanted = candidateRole !== '' && userPrefs.some((pref: string) =>
      pref.toLowerCase() === candidateRole
    )
    if (!explicitlyWanted) return true
  }

  return false
}

/**
 * Apply junior user distribution control to prevent overwhelming senior users
 */
function applyJuniorDistributionControl(
  candidates: any[],
  userProfile: any,
  userSeniorityLevel: 'junior' | 'mid' | 'senior',
  targetCount: number
): any[] {
  if (candidates.length === 0) return []
  
  // Only apply distribution control for senior users
  if (userSeniorityLevel !== 'senior') {
    return candidates
  }
  
  // Separate juniors from non-juniors
  const juniors = candidates.filter(c => getUserSeniorityLevel(c) === 'junior')
  const nonJuniors = candidates.filter(c => getUserSeniorityLevel(c) !== 'junior')
  
  // Calculate max allowed juniors
  const userOpenToMentorship = userProfile.open_to_mentorship || false
  let maxJuniors = 0
  
  if (userOpenToMentorship) {
    // If open to mentorship: allow up to 20% juniors
    maxJuniors = Math.floor(targetCount * MENTORSHIP_CONFIG.juniorMaxPercentage)
    // Ensure at least 1 junior if batch size >= 5
    if (maxJuniors === 0 && targetCount >= 5 && juniors.length > 0) {
      maxJuniors = 1
    }
  } else {
    // If NOT open to mentorship: no juniors allowed, no exceptions
    maxJuniors = 0
  }
  
  // Select juniors up to cap
  const selectedJuniors = juniors.slice(0, maxJuniors)
  
  // Fill remaining slots with non-juniors
  const remainingSlots = candidates.length - selectedJuniors.length
  const selectedNonJuniors = nonJuniors.slice(0, remainingSlots)
  
  // Interleave juniors among non-juniors (similar to business solution logic)
  const result = interleaveJuniors(selectedNonJuniors, selectedJuniors)
  
  console.log('[mentorship]', {
    user_seniority: userSeniorityLevel,
    open_to_mentorship: userOpenToMentorship,
    juniors_available: juniors.length,
    non_juniors_available: nonJuniors.length,
    max_juniors_allowed: maxJuniors,
    juniors_selected: selectedJuniors.length,
    non_juniors_selected: selectedNonJuniors.length,
    final_count: result.length
  })
  
  return result
}

/**
 * Place juniors after non-juniors (function name retained for caller compat).
 *
 * Previously this function interleaved juniors throughout the batch using
 * spacing = totalSlots / juniors.length. That had a bug: with juniors.length === 1,
 * juniorIndex=0 → position 0, so the lone junior was promoted ahead of every
 * higher-scoring non-junior. Since the distribution cap upstream allows at most
 * 0 (free/founding tier) or 1 (professional/executive tier) juniors today,
 * appending preserves junior representation without top-of-batch promotion.
 */
function interleaveJuniors(nonJuniors: any[], juniors: any[]): any[] {
  if (juniors.length === 0) return nonJuniors
  if (nonJuniors.length === 0) return juniors
  return [...nonJuniors, ...juniors]
}



// ==========================================
// TARGETED REQUEST SCORING (PREMIUM FEATURE)
// ==========================================

interface TargetedRequest {
  id: string
  role?: string
  industry?: string
  intent?: string
}

/**
 * Apply targeted request boost to candidates matching user's premium request
 * This is a ranking boost, not a filter - maintains curation
 */
function applyTargetedRequestBoost(
  candidate: any,
  targetedRequest: TargetedRequest | null
): number {
  if (!targetedRequest) return 0
  
  let boost = 0
  
  // Role matching (strongest signal)
  if (targetedRequest.role && candidate.role_type) {
    const requestRole = targetedRequest.role.toLowerCase()
    const candidateRole = candidate.role_type.toLowerCase()
    
    // Exact or partial match
    if (candidateRole.includes(requestRole) || requestRole.includes(candidateRole)) {
      boost += 15  // Strong boost for role match
    }
  }
  
  // Industry matching (moderate signal)
  if (targetedRequest.industry && candidate.industry) {
    const requestIndustry = targetedRequest.industry.toLowerCase()
    const candidateIndustry = candidate.industry.toLowerCase()
    
    if (candidateIndustry.includes(requestIndustry) || requestIndustry.includes(candidateIndustry)) {
      boost += 8  // Moderate boost for industry match
    }
  }
  
  // Intent matching affects business solution candidates
  if (targetedRequest.intent) {
    const intent = targetedRequest.intent.toLowerCase()
    const isBusinessSolution = isBusinessSolutionProvider(candidate)
    
    // "Looking for solutions" or "Exploring vendors" → boost business solutions
    if ((intent.includes('solution') || intent.includes('vendor')) && isBusinessSolution) {
      boost += 10
    }
    
    // "Peer networking" → penalize business solutions
    if (intent.includes('peer') && isBusinessSolution) {
      boost -= 5
    }
  }
  
  return boost
}


/**
 * Apply throttling to prevent consultant/law firm clustering
 * 
 * - Enforces max % cap per batch
 * - Prevents clustering (distributes business solutions)
 * - Respects user preference and tier
 */
function applyThrottling(
  candidates: any[],
  userProfile: any,
  userTier: string,
  targetCount: number
): any[] {
  if (candidates.length === 0) return []
  
  // 1. Separate business solutions from peers.
  // PEER EXEMPTION (v3.2): if the recipient is themselves a provider, every candidate —
  // including other providers — is PEER networking (provider↔provider) and is NOT
  // throttled. The quota only limits how many providers a NON-provider (potential buyer)
  // is shown. See lib/matching/business-solutions.ts.
  const recipientIsProvider = isBusinessSolutionProvider(userProfile)
  const businessSolutions = recipientIsProvider ? [] : candidates.filter(c => isBusinessSolutionProvider(c))
  const peers = recipientIsProvider ? candidates : candidates.filter(c => !isBusinessSolutionProvider(c))

  // 2. Calculate max allowed business solutions (shared helper — see lib/matching/business-solutions.ts)
  const userOpenToSolutions = userProfile.open_to_business_solutions || false
  const maxBusinessSolutions = maxBusinessSolutionCount(userOpenToSolutions, userTier, targetCount)
  
  // 4. Select business solutions up to cap
  const selectedBusinessSolutions = businessSolutions.slice(0, maxBusinessSolutions)
  
  // 5. Fill remaining slots with peers
  const remainingSlots = targetCount - selectedBusinessSolutions.length
  const selectedPeers = peers.slice(0, remainingSlots)
  
  // 6. Interleave to prevent clustering
  const result = interleaveBusinessSolutions(selectedPeers, selectedBusinessSolutions)
  
  console.log('[throttling]', {
    total_candidates: candidates.length,
    business_solutions_available: businessSolutions.length,
    peers_available: peers.length,
    max_business_allowed: maxBusinessSolutions,
    business_selected: selectedBusinessSolutions.length,
    peers_selected: selectedPeers.length,
    final_batch_size: result.length,
    user_open_to_solutions: userOpenToSolutions,
    tier: userTier
  })
  
  return result
}

/**
 * Interleave business solutions among peers to prevent clustering
 * Strategy: Distribute business solutions evenly throughout the batch
 */
function interleaveBusinessSolutions(peers: any[], businessSolutions: any[]): any[] {
  if (businessSolutions.length === 0) return peers
  if (peers.length === 0) return businessSolutions
  
  const result: any[] = []
  const totalSlots = peers.length + businessSolutions.length
  
  // Calculate spacing between business solutions
  const spacing = totalSlots / businessSolutions.length
  
  let peerIndex = 0
  let businessIndex = 0
  
  for (let i = 0; i < totalSlots; i++) {
    // Determine if this slot should be a business solution
    const businessSlotPosition = Math.floor(businessIndex * spacing)
    
    if (i === businessSlotPosition && businessIndex < businessSolutions.length) {
      result.push(businessSolutions[businessIndex])
      businessIndex++
    } else if (peerIndex < peers.length) {
      result.push(peers[peerIndex])
      peerIndex++
    }
  }
  
  return result
}



// ==========================================
// LAW-FIRM COMPOSITION POLICY (onboarding/live path)
// ==========================================
// A law-firm lawyer's batch must never be two other law-firm lawyers. Prefer
// in-house legal leaders, executives, investors, and other credible clients /
// referral sources. Allow at most ONE law-firm lawyer, and only when the match has
// a meaningful strategic rationale beyond shared seniority / overlapping expertise:
// complementary practice (little non-generic overlap) AND a local-referral signal
// (same metro). This lives here, in the onboarding/live ranker — it is independent
// of the reciprocal-batch peer exemption in lib/matching/reciprocal-graph.ts.

export function isLawFirmLawyer(profile: any): boolean {
  return /law firm/i.test(String(profile?.role_type ?? ''))
}

/**
 * CROSS-MARKET-FIRST composition for a law-firm-side viewer (the permanent product
 * rule). Partition the rank-ordered candidates into cross-market (non-law-firm) vs
 * same-side law firm, preserving score order within each group, and return cross-market
 * FIRST with same-side appended as a fallback. The downstream top-N slice therefore
 * fills a Law Firm Partner (or attorney) from cross-market candidates — GC / DGC / CLO /
 * In-House / Legal Ops / compliance / corporate / investor / government / board — before
 * ANY same-side law-firm peer; a same-side peer is used ONLY when there aren't enough
 * cross-market candidates to fill the batch. Non-law-firm viewers are unchanged. Scores
 * are untouched — only order. (Delegates to the shared helper reused by the batch engine.)
 */
export function applyLawFirmCompositionPolicy(candidates: any[], viewer: any): any[] {
  if (!isLawFirmLawyer(viewer)) return candidates
  return crossMarketFirstForLawFirm(candidates, viewer)
}

function calculateFinalScore(userProfile: any, candidate: any, userTier: string = 'free', targetedRequest: any = null): number {
  // All inputs are now 0-100 normalized
  const alignmentNormalized = calculateAlignmentScore(userProfile, candidate) // 0-100
  const alignmentWeighted = (alignmentNormalized / 100) * 55
  
  // Typed DB-boundary mapping: read the REAL snake_case columns (network_value_score /
  // responsiveness_score). The prior camelCase reads were always undefined → a constant 50.
  const signals = readScoringSignals(candidate)
  const networkValueWeighted = (signals.networkValueScore / 100) * 30

  const responsivenessWeighted = (signals.responsivenessScore / 100) * 15
  
  const priorityBonus = candidate.is_priority ? 5 : 0
  const boostBonus = (candidate.boost_score || 0) * 0.5
  
  // PHASE 1: Light tier weighting + preference-based boosting
  let tierAdjustment = 0
  
  // 1. Check if candidate matches user's intro preferences
  const userPrefs: string[] = Array.isArray(userProfile.intro_preferences) ? userProfile.intro_preferences : []
  const candidateRole = (candidate.role_type || '').toLowerCase()
  
  const matchesPreference = userPrefs.some((pref: string) => {
    const prefLower = pref.toLowerCase()
    return prefLower.includes(candidateRole) || candidateRole.includes(prefLower)
  })
  
  // 2. Preference-based boosting (overrides role type penalties)
  if (matchesPreference) {
    // User explicitly wants this type of person - boost them
    tierAdjustment += 4
  }
  
  // 3. Light tier-based adjustments (only for close calls)
  if (userTier === 'free') {
    // Free tier: minimal adjustment, mostly random discovery
    tierAdjustment += (Math.random() * 6) - 3 // ±3
  } else if (userTier === 'professional') {
    // Professional: slight preference for top candidates
    // Use base score percentile (before adjustments) to determine
    const baseScore = alignmentWeighted + networkValueWeighted + responsivenessWeighted
    if (baseScore > 60) {
      tierAdjustment += 2 + Math.random() * 2 // +2 to +4
    } else if (baseScore < 40) {
      tierAdjustment -= 2 + Math.random() // -2 to -3
    }
    tierAdjustment += (Math.random() * 4) - 2 // ±2 randomness
  } else if (userTier === 'executive') {
    // Executive: stronger top candidate preference
    const baseScore = alignmentWeighted + networkValueWeighted + responsivenessWeighted
    if (baseScore > 65) {
      tierAdjustment += 3 + Math.random() * 3 // +3 to +6
    } else if (baseScore < 35) {
      tierAdjustment -= 3 + Math.random() * 2 // -3 to -5
    }
    tierAdjustment += (Math.random() * 2) - 1 // ±1 randomness
  }
  
  // 5. Mentorship-based scoring adjustments
  let mentorshipAdjustment = 0
  const userSeniorityLevel = getUserSeniorityLevel(userProfile)
  const candidateSeniorityLevel = getUserSeniorityLevel(candidate)
  
  // Senior users with mentorship OFF: penalize junior candidates heavily
  if (userSeniorityLevel === 'senior' && candidateSeniorityLevel === 'junior') {
    const userOpenToMentorship = userProfile.open_to_mentorship || false
    if (!userOpenToMentorship) {
      mentorshipAdjustment = -15  // Strong penalty to suppress juniors
    } else {
      mentorshipAdjustment = -3   // Light penalty even when open (still prefer peers)
    }
  }
  
  // 6. Targeted request boost (premium feature)
  const targetedRequestBoost = applyTargetedRequestBoost(candidate, targetedRequest)
  
  const finalScore = alignmentWeighted + networkValueWeighted + responsivenessWeighted + priorityBonus + boostBonus + tierAdjustment + mentorshipAdjustment + targetedRequestBoost
  
  // 4. SAFEGUARD: Tier adjustments cannot flip matches with >15 point base score gap
  // This ensures relevance always wins over tier manipulation
  // (This safeguard is informational - implemented in ranking, not here)
  
  return finalScore
}

function applyTierRankingAdjustment(candidates: any[], userTier: string): any[] {
  const sorted = [...candidates].sort((a, b) => b.finalScore - a.finalScore)
  
  if (userTier === 'free') {
    // Free: ±3 variation for discovery
    return sorted.map((c) => ({
      ...c,
      rankingScore: c.finalScore + (Math.random() * 6) - 3
    })).sort((a, b) => b.rankingScore - a.rankingScore)
  }
  
  if (userTier === 'professional') {
    const top30Index = Math.floor(sorted.length * 0.3)
    const bottom30Index = Math.floor(sorted.length * 0.7)
    
    return sorted.map((c, idx) => {
      let adjustment = 0
      if (idx < top30Index) adjustment = 8
      else if (idx > bottom30Index) adjustment = -5
      
      // Add ±2 randomness
      const randomness = (Math.random() * 4) - 2
      
      return { ...c, rankingScore: c.finalScore + adjustment + randomness }
    }).sort((a, b) => b.rankingScore - a.rankingScore)
  }
  
  if (userTier === 'executive') {
    const top20Index = Math.floor(sorted.length * 0.2)
    const bottom40Index = Math.floor(sorted.length * 0.6) // Reduced from 50%
    
    return sorted.map((c, idx) => {
      let adjustment = 0
      if (idx < top20Index) adjustment = 15
      else if (idx > bottom40Index) adjustment = -8 // Reduced penalty
      
      // Add ±1 randomness
      const randomness = (Math.random() * 2) - 1
      
      return { ...c, rankingScore: c.finalScore + adjustment + randomness }
    }).sort((a, b) => b.rankingScore - a.rankingScore)
  }
  
  return sorted.map(c => ({ ...c, rankingScore: c.finalScore }))
}

// Deterministic, gender-neutral, network-wide reason for why `candidate` was
// suggested to the viewer. Delegates to the single shared builder in
// lib/match-signals.ts so every generation path tells a consistent story.
// Returns newline-joined bullets (rendered as a list) or a restrained fallback.
function generateIntroReason(userProfile: any, candidate: any): string {
  return introReasonText(userProfile, candidate)
}

/**
 * Pure, READ-ONLY candidate ranker. Runs the exact same pipeline that the batch
 * generator uses (pool fetch → exclusions → scoring → throttle → sort) but
 * performs NO writes and RETURNS the scored candidates (with match_reason).
 *
 * Behavior is identical to the previous inline pipeline — this is an extract,
 * not a scoring/matching change. generateOnboardingRecommendations (below) wraps
 * this and adds the persistence (intro_requests insert + targeted_requests mark).
 */
/**
 * Current active inbound recommendation counts, keyed by target user id — how many
 * members currently hold each person in their active window (status 'suggested',
 * in an active-state batch). Feeds exposure balancing so recommendations don't
 * over-concentrate on a few popular members. Only called when the balancing flag
 * is on, so it adds no cost to the default generation path.
 */
/**
 * A candidate's ACTIVE INBOUND EXPOSURE: how many live recommendation cards are currently
 * presenting that member to other members. Purely a fairness-ranking input — it never decides
 * eligibility and never touches the capacity contract.
 *
 * COUNTS a row when `target_user_id` is the candidate and `status` is 'suggested' or 'queued'
 * (ACTIVE_STATUSES — the same "live card" set the history classifier uses). Queued rows count
 * because they reserve imminent exposure. Everything terminal — pending, approved, passed,
 * declined, rejected, expired, archived, hidden, hidden_permanent, matched — contributes nothing,
 * as do formed matches, which are not intro_requests rows at all.
 *
 * WHY IT IS KEYED ON target_user_id: the fairness question is "how often is this candidate being
 * SHOWN to other people", which is the target side. Counting requester_id would measure how many
 * cards the candidate HOLDS — that is the capacity question, and a different contract.
 *
 * WHAT WAS WRONG. This previously required `batch_id && activeBatchIds.has(batch_id)`, and the
 * reciprocal RPC deliberately creates its pair cards with batch_id NULL (migration 050 step 8).
 * Every reciprocal card was therefore invisible here, so as reciprocal generation became the main
 * path the exposure penalty increasingly computed 0 for everyone and ordering collapsed to raw
 * compatibility score — the fair spread was inert for exactly the cards it existed to spread.
 * Measured on production at the time of the fix: 145 of 153 suggested rows counted, all 8
 * reciprocal rows ignored.
 *
 * The recommendation_batches join was ALSO measured to exclude nothing: every suggested row
 * carrying a batch_id belonged to an active batch (145/145, zero orphans), so the join filtered no
 * invalid legacy rows and is dropped rather than kept out of habit. That also removes a query.
 *
 * Bounded to the candidate ids under consideration when they are supplied, so this stays one
 * query over a small set rather than a full scan. The caller passes its deadline-bound admin
 * client, so this read is cancelled with the rest of the generation budget.
 */
/**
 * A candidate's ACTIVE INBOUND EXPOSURE, split into the two tiers that mean different things:
 * `visible` (status 'suggested' — already on someone's screen) and `reserved` (status 'queued' —
 * generated but shown to nobody yet). Purely a fairness-ranking input; it never decides eligibility
 * and never touches the capacity contract.
 *
 * KEYED ON target_user_id: the question is how often this candidate is being SHOWN to other people.
 * Counting requester_id would measure how many cards the candidate HOLDS, which is capacity — a
 * different contract with a different owner (the RPCs, under the member advisory lock).
 *
 * Two defects are corrected here. It previously required `batch_id && activeBatchIds.has(batch_id)`,
 * and the reciprocal RPC deliberately creates its pair cards with batch_id NULL (migration 050 step
 * 8) — so every reciprocal card was invisible to fairness and, as reciprocal generation became the
 * main path, the penalty increasingly computed zero for everyone and ordering collapsed to raw
 * compatibility. It also collapsed the two tiers into one number, which saturated the penalty for
 * 59% of candidates. The recommendation_batches join was measured to exclude nothing (145/145
 * suggested rows carrying a batch_id were in an active batch), so it is dropped rather than kept out
 * of habit — which also removes a query.
 *
 * One bounded query, restricted to the candidates actually being ranked, issued through the caller's
 * deadline-bound admin client so it is cancelled with the rest of the generation budget.
 */
export async function getActiveInboundExposure(
  adminClient: ReturnType<typeof createAdminClient>,
  candidateIds?: string[],
): Promise<Map<string, CardCounts>> {
  const exposure = new Map<string, CardCounts>()
  // An explicitly empty candidate set has no exposure to measure — skip the round trip entirely.
  if (candidateIds && candidateIds.length === 0) return exposure

  let query = adminClient
    .from('intro_requests')
    .select('target_user_id, status')
    .in('status', [VISIBLE_STATUS, RESERVED_STATUS])
  if (candidateIds && candidateIds.length > 0) query = query.in('target_user_id', candidateIds)

  const { data: rows, error } = await query
  // Fail OPEN to neutral ordering (every candidate at zero): a fairness input must never block
  // generation. Class only — never ids, never the raw error text.
  if (error) {
    console.error('[reciprocal-exposure] read failed (class):', (error as any).code ?? 'unknown')
    return exposure
  }

  for (const r of (rows ?? []) as Array<{ target_user_id: string | null; status: string | null }>) {
    if (!r?.target_user_id) continue
    const cur = exposure.get(r.target_user_id) ?? { visible: 0, reserved: 0 }
    if (r.status === VISIBLE_STATUS) cur.visible += 1
    else if (r.status === RESERVED_STATUS) cur.reserved += 1
    exposure.set(r.target_user_id, cur)
  }
  return exposure
}

export async function rankCandidatesForUser(userId: string, maxCount?: number, admin?: ReturnType<typeof createAdminClient>) {
  // A caller may inject a deadline-bound admin client so ALL of this function's reads are cancelled
  // when the caller's generation budget expires (see generateReciprocalBatchForMember).
  const adminClient = admin ?? createAdminClient()

  const { data: newUserProfile, error: profileError } = await adminClient
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()
  
  if (profileError || !newUserProfile) {
    throw new Error('User not found')
  }
  
  const userSeniorityLevel = getUserSeniorityLevel(newUserProfile)
  
  // Fetch pending targeted request (premium feature) - exclude expired
  const { data: targetedRequest } = await adminClient
    .from('targeted_requests')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())  // ✅ Exclude expired requests
    .order('created_at', { ascending: false })
    .maybeSingle()
  
  if (targetedRequest) {
    console.log('[generate-recommendations] Targeted request active:', {
      request_id: targetedRequest.id,
      user_id: userId,
      role: targetedRequest.role,
      industry: targetedRequest.industry,
      intent: targetedRequest.intent,
      created_at: targetedRequest.created_at,
      expires_at: targetedRequest.expires_at
    })
  }
  
  console.log('[generate-recommendations] New user profile:', {
    email: newUserProfile.email,
    role_type: newUserProfile.role_type,
    seniority: newUserProfile.seniority,
    seniority_level: userSeniorityLevel,
    expertise: newUserProfile.expertise,
    intro_preferences: newUserProfile.intro_preferences,
    city: newUserProfile.city,
    state: newUserProfile.state,
    open_to_business_solutions: newUserProfile.open_to_business_solutions,
    open_to_mentorship: newUserProfile.open_to_mentorship,
    is_founding_member: newUserProfile.is_founding_member
  })
  
  const userTier = getEffectiveTier(newUserProfile)
  const recommendationCount = getActiveIntroCap(userTier)
  console.log('[generate-recommendations] User tier:', userTier, 'Count:', recommendationCount)
  
  // Canonical eligibility (adds internal/admin-flag exclusion); exclude self.
  const rawUsers = await applyMemberEligibility(adminClient
    .from('profiles')
    .select('*')
    .neq('id', userId))
  const allUsers = filterEligible(rawUsers.data as any[]) // in-memory defense
  assertAllEligible(allUsers, 'generate-recommendations') // fail-fast before scoring
  const usersError = rawUsers.error

  if (usersError || !allUsers) {
    throw new Error('Failed to fetch users')
  }
  
  console.log('[generate-recommendations] All users count:', allUsers.length)
  
  // EXCLUSION LOGIC: Get users to exclude from matching
  
  // 1. Users already matched (bidirectional), except soft-removed matches past the 180-day cooldown
  const { data: existingMatches } = await adminClient
    .from('matches')
    .select('user_a_id, user_b_id, status, removed_at')
    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)

  const REMOVAL_COOLDOWN_MS = 180 * 24 * 60 * 60 * 1000
  const nowMs = Date.now()
  const matchedUserIds = new Set<string>()
  existingMatches?.forEach(m => {
    // Removed matches past the cooldown are considered historical and no longer exclude
    if (m.status === 'removed' && m.removed_at) {
      const removedMs = new Date(m.removed_at).getTime()
      if (!Number.isNaN(removedMs) && (nowMs - removedMs) > REMOVAL_COOLDOWN_MS) {
        return
      }
    }
    matchedUserIds.add(m.user_a_id)
    matchedUserIds.add(m.user_b_id)
  })
  matchedUserIds.delete(userId) // Remove self

  // 1b. Blocked users (either direction)
  const { data: blockRows } = await adminClient
    .from('blocked_users')
    .select('user_id, blocked_user_id')
    .or(`user_id.eq.${userId},blocked_user_id.eq.${userId}`)

  const blockedUserIds = new Set<string>()
  for (const row of blockRows || []) {
    if (row.user_id === userId) blockedUserIds.add(row.blocked_user_id)
    else blockedUserIds.add(row.user_id)
  }
  
  // 2b. Referral pairs — bidirectional: referrer cannot appear in referred's batch and vice versa
  const referralExcludedIds = await getReferralExclusionsForUser(userId)

  // 2 + 3. Introduction history — tiered & bidirectional (see lib/introRequests/history.ts).
  //   HARD (permanent): active window (suggested/queued) + engagement/commitment/
  //     explicit-signal statuses (pending/accepted/admin_pending/approved/declined/
  //     rejected/hidden/hidden_permanent). matches/blocked/referrals merged in below.
  //   SOFT (releasable by the exhaustion valve): passed, expired, and archived rows
  //     from a real displayed batch (genuinely shown, no commitment).
  //   ARTIFACT (not history): archived rows with no batch_id — the migration/backfill
  //     mass-archive, never genuinely presented → never blocks a pair.
  // A discarded-before-shown queued batch is DELETEd, so it isn't present here.
  const { data: introHistory } = await adminClient
    .from('intro_requests')
    .select('requester_id, target_user_id, status, batch_id')
    .or(`requester_id.eq.${userId},target_user_id.eq.${userId}`)

  const { hardExcluded, softExcluded } = classifyIntroHistory(userId, introHistory)
  // matches / blocked / referrals are HARD (permanent) too — merge them in.
  for (const id of Array.from(matchedUserIds)) hardExcluded.add(id)
  for (const id of Array.from(blockedUserIds)) hardExcluded.add(id)
  for (const id of Array.from(referralExcludedIds)) hardExcluded.add(id)
  for (const id of Array.from(softExcluded)) if (hardExcluded.has(id)) softExcluded.delete(id) // keep disjoint

  const dataValid = (u: any) =>
    !!u.full_name && !!u.role_type && parseExpertise(u.expertise).length > 0
  // HARD + same-company are always excluded; SOFT is excluded unless the exhaustion
  // safety valve engages for this member (fresh pool below the configured threshold).
  const base = allUsers.filter((u: any) => !hardExcluded.has(u.id) && !isSameCompany(newUserProfile, u) && dataValid(u))
  const afterSoft = base.filter((u: any) => !softExcluded.has(u.id))
  const threshold = exhaustionThreshold()
  const valveActive = threshold > 0 && afterSoft.length < threshold
  const usersWithData = valveActive ? base : afterSoft

  console.log('[generate-recommendations] Excluded users:', {
    hard: hardExcluded.size,
    soft: softExcluded.size,
    poolAfterSoft: afterSoft.length,
    exhaustionValve: valveActive ? `ACTIVE (< ${threshold})` : (threshold > 0 ? 'armed' : 'disabled'),
    usersWithData: usersWithData.length,
  })
  
  const scoredCandidates = usersWithData.map(candidate => ({
    ...candidate,
    finalScore: calculateFinalScore(newUserProfile, candidate, userTier, targetedRequest)
  }))
  
  const filtered = scoredCandidates.filter(c => c.finalScore >= 10)
  console.log('[generate-recommendations] After relevance filter (>= 10):', filtered.length)
  
  // Apply mentorship filtering
  const mentorshipFiltered = filtered.filter(c => !shouldFilterByMentorship(newUserProfile, c, userSeniorityLevel))

  console.log('[generate-recommendations] After mentorship filter:', mentorshipFiltered.length)

  // Same-side legal marketplace penalty (PART 5) — a STRONG RANKING penalty applied
  // AFTER the >=10 relevance gate, so a law-firm ↔ law-firm pair is demoted below any
  // cross-market alternative (GC / in-house / corporate / investor / gov / board) but
  // is NEVER hard-banned: it stays in the pool and can still be picked when no better
  // candidate exists. Shared helper — identical policy in the batch scorer. No-op for
  // any pair where at least one side is not a law-firm role_type.
  for (const c of mentorshipFiltered) {
    const pen = legalSameSidePenalty(newUserProfile, c)
    if (pen) c.finalScore += pen
  }

  const rankedCandidates = applyTierRankingAdjustment(mentorshipFiltered, userTier)
  // Matching V2 — rank-only desired-connections boost. Applied AFTER the >=10
  // eligibility gate (line 902) and after tier-ranking, BEFORE truncation, so
  // it cannot pull ineligible candidates into the batch. Flag-gated; no-op
  // when MATCHING_V2_VERTICAL_BOOST !== '1' or the viewer has no preference.
  const boostedCandidates = applyVerticalBoost(rankedCandidates, newUserProfile)
  // Exposure balancing — rank-only, flag-gated (RECOMMENDATION_EXPOSURE_BALANCING).
  // Subtracts a small capped penalty from candidates who already hold many active
  // inbound recommendations, so near-ties break toward under-exposed members and
  // no handful of people absorbs the network's introductions. Deterministic
  // alignment core is untouched; the cap keeps meaningfully-higher-fit candidates
  // ahead. Runs BEFORE law-firm composition so hard composition rules still win.
  // NOTE ON THE TWO EXPOSURE SYSTEMS. This flag-gated ranker has its own tuning (softFloor 2,
  // 1.5/unit, cap 6) built around a single COMBINED active-card count, which is exactly what
  // getActiveInboundExposure used to return. It is deliberately left alone here: collapsing the two
  // tiers back to one total preserves its behaviour byte-for-byte, and only the reciprocal fair
  // selection below adopts the new two-tier penalty. Retuning this one is separate work.
  const exposureBalanced = exposureBalancingEnabled()
    ? applyExposureBalancing(
        boostedCandidates,
        new Map(
          Array.from(
            (await getActiveInboundExposure(adminClient, boostedCandidates.map((c: any) => c.id))).entries(),
          ).map(([id, counts]) => [id, counts.visible + counts.reserved] as const),
        ),
      )
    : boostedCandidates
  // Law-firm composition policy: a law-firm lawyer never gets two other law-firm
  // lawyers — at most one, only with a strategic (complementary-practice + local)
  // rationale, and never in the first slot. Reorders BEFORE truncation so excess
  // peers fall below the batch size.
  const composed = applyLawFirmCompositionPolicy(exposureBalanced, newUserProfile)
  // Apply throttling to prevent consultant/law firm clustering
  const throttled = applyThrottling(
    composed,
    newUserProfile,
    userTier,
    recommendationCount
  )
  
  // Apply junior user distribution control
  const mentorshipControlled = applyJuniorDistributionControl(
    throttled,
    newUserProfile,
    userSeniorityLevel,
    recommendationCount
  )
  
  const sorted = mentorshipControlled.slice(0, maxCount ?? recommendationCount)
  
  console.log('[generate-recommendations] Top 3 final scores:', sorted.slice(0, 3).map(c => ({ email: c.email, score: c.finalScore.toFixed(1) })))

  // Attach a human-readable match reason per candidate — single source of truth
  // shared by the read-only consumers and the persisting writer below.
  const candidates = sorted.map(candidate => ({
    ...candidate,
    match_reason: generateIntroReason(newUserProfile, candidate),
  }))

  return { candidates, newUserProfile, targetedRequest }
}

// Re-exported from the queue service so existing importers keep resolving to the
// single source of truth for "how many recommendations are still open."
export { countUnresolvedRecommendations }

/**
 * Rank + ENQUEUE a batch for one member through the unified queue. This is the one
 * generation entry point shared by every producer (onboarding, the weekly engine,
 * admin-initiated regeneration). It never writes intro_requests directly — placement
 * (active vs queued), the active-window cap, and admin precedence are owned by
 * enqueueBatch. Marks any active targeted_request 'applied' when its recommendations
 * are actually placed.
 */
export async function generateBatchForMember(
  userId: string,
  source: BatchSource,
  maxCount?: number,
): Promise<EnqueueResult> {
  const adminClient = createAdminClient()
  const { candidates: sorted, targetedRequest } = await rankCandidatesForUser(userId, maxCount)

  if (sorted.length === 0) return { placed: false, reason: 'empty', visiblePlaced: 0, reservedPlaced: 0, dropped: 0 }

  const result = await enqueueBatch(adminClient, {
    memberId: userId,
    source,
    rows: sorted.map((c: any) => ({ target_user_id: c.id, match_reason: c.match_reason })),
  })

  // Only mark the targeted request applied when its recommendations were actually
  // placed into the queue (active or queued) — not when the batch was rejected/empty.
  if (targetedRequest && result.placed) {
    const { error: updateError } = await adminClient
      .from('targeted_requests')
      .update({ status: 'applied', applied_at: new Date().toISOString() })
      .eq('id', targetedRequest.id)
      .eq('status', 'pending')
    if (updateError) {
      console.error('[generate-recommendations] CRITICAL: Failed to mark request as applied:', {
        request_id: targetedRequest.id, error: updateError,
      })
      throw new Error(`Failed to mark targeted request as applied: ${updateError.message}`)
    }
    console.log('[generate-recommendations] Targeted request marked as applied:', {
      request_id: targetedRequest.id, user_id: userId, role: targetedRequest.role,
    })
  }

  // Announce the batch (in-app + email) only for cards that actually landed in the VISIBLE tier.
  // Reserved rows are hidden, so they stay silent until promotion (see promoteIfResolved callers).
  // Idempotent + best-effort.
  if (shouldNotifyVisibleBatch(result) && result.activeBatchId) {
    // Announce the VISIBLE part only. One call can also have reserved rows; those stay silent until
    // promotion reveals them, so the member is never emailed about a card they cannot open.
    await notifyNewVisibleBatch(userId, result.activeBatchId, result.visiblePlaced)
  }

  return result
}

/**
 * Onboarding / manual generation entry point (signature preserved for existing
 * callers). A newly onboarded member has no active batch, so this places their first
 * batch as ACTIVE. For members who already hold a batch it enqueues behind them,
 * upholding the active-window invariant. Returns { count } = recommendations placed.
 */
export async function generateOnboardingRecommendations(userId: string, maxCount?: number) {
  // Routed through the ONE reciprocal, concurrency-safe path (not the legacy one-sided enqueue).
  const result = await generateReciprocalBatchForMember(userId, 'onboarding', maxCount)
  return { count: result.count, outcome: result.outcome, retryable: result.retryable }
}

// Default number of reciprocal pairs to create per member batch.
const RECIPROCAL_BATCH_SIZE = 5
// Broad fit-ranked pool to fair-select from, so live exposure can influence WHICH members pair
// (not just their order) — this is what spreads new members across good-fit counterparts.
const RECIPROCAL_CANDIDATE_POOL = 50

/**
 * HARD limits on a single interactive generation — bound candidate count, RPC calls, and wall time
 * so onboarding can never burst the DB or hang. `maxCandidateAttempts=2` (initial + one retry).
 *
 * `maxRpcCalls=8` — rationale: the onboarding target is RECOMMENDATIONS_PER_BATCH (2) cards, so 8 is
 * 4× the target. The candidate list is FAIR-ORDERED (exposure-weighted), which is what prevents the
 * global-top concentration bug — NOT the cap size — so a smaller cap does not reconcentrate. 8 lets
 * a brand-new member absorb up to ~6 capacity/ineligible skips while still creating 2 pairs, and
 * bounds worst-case interactive latency (≤8 sequential RPCs + one transient retry) well under the
 * time budget. No measurement justified the previous 12; lowered to the safer 8.
 */
export const GEN_TIME_BUDGET_MS = 4000
export const WALK_LIMITS = { maxRpcCalls: 8, maxCandidateAttempts: 2, timeBudgetMs: GEN_TIME_BUDGET_MS, backoffMs: 100 } as const

/**
 * Unambiguous, privacy-safe generation outcomes (derived ONLY from counts + RPC codes, never from
 * any identity):
 *   created              — ≥1 reciprocal pair created
 *   noop_at_capacity     — the member already holds the allowed number of visible cards
 *   empty_pool           — candidate selection returned zero candidates
 *   capacity             — candidates existed but every safe attempt was blocked by capacity/exists_active
 *   no_compatible_candidate — candidates existed but eligibility/history/blocking/cooldown rejected all
 *   ineligible           — the NEW member itself is ineligible (no RPC attempted)
 *   transient_error      — a real DB/RPC exception or 'error' response prevented a conclusive result
 */
export type GenerationOutcome =
  | 'created' | 'noop_at_capacity' | 'empty_pool' | 'capacity' | 'no_compatible_candidate' | 'ineligible' | 'transient_error'

export interface GenerationResult {
  count: number
  considered: number
  outcome: GenerationOutcome
  /** True when the result is not definitive/terminal — the member may be retried later by a
   *  SEPARATELY-AUTHORIZED, explicitly-targeted operation (no automatic global sweep exists). */
  retryable: boolean
  rpcCalls: number
}

/** Whether an outcome is a candidate for a later, explicitly-targeted retry (never an auto-sweep). */
export function retryableFor(outcome: GenerationOutcome): boolean {
  return outcome === 'transient_error' || outcome === 'capacity' ||
    outcome === 'empty_pool' || outcome === 'no_compatible_candidate'
}

/**
 * Reduce the FINAL per-candidate outcomes (after the bounded transient-retry) to ONE outcome. A
 * residual transient 'error' — even mixed with deterministic skips — yields transient_error, never a
 * false empty/definitive result. Pure + fully unit-tested.
 */
export function classifyGenerationOutcome(
  finalOutcomes: ReciprocalOutcome[],
  opts: { createdCount: number; candidatesEmpty: boolean; memberIneligible: boolean; timedOut: boolean },
): GenerationOutcome {
  if (opts.createdCount > 0) return 'created'
  if (opts.memberIneligible) return 'ineligible'
  if (opts.candidatesEmpty) return 'empty_pool'
  if (opts.timedOut) return 'transient_error'                 // uncertain — never a definitive empty
  if (finalOutcomes.includes('error')) return 'transient_error' // residual/mixed transient uncertainty
  if (finalOutcomes.length === 0) return 'empty_pool'
  if (finalOutcomes.every((o) => o === 'capacity' || o === 'exists_active')) return 'capacity'
  return 'no_compatible_candidate'                            // deterministic non-capacity rejections
}

/** Structured, privacy-safe log line. NEVER includes email, UUID, name, candidate identity, profile
 *  data, or raw errors. `cid` is an ephemeral, non-identifying per-invocation correlation token. */
function logReciprocalGeneration(event: string, source: string, fields: Record<string, unknown> = {}) {
  console.log('[reciprocal-gen]', JSON.stringify({ event, source, ...fields }))
}

// Ephemeral, non-identifying per-invocation correlation token (ties the invoked + outcome log lines
// of one generation together). NOT derived from any member/candidate identity.
let genSeq = 0
function nextCorrelationId(): string { genSeq = (genSeq + 1) % 1_000_000; return genSeq.toString(36) }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface WalkResult { created: number; considered: number; rpcCalls: number; finalOutcomes: ReciprocalOutcome[]; timedOut: boolean }

/**
 * Bounded candidate traversal — the testable core. Walks the fair-ordered candidate ids ONCE,
 * calling createFn per candidate; a per-candidate 'error' is TRANSIENT and its id is retried ONCE
 * afterwards (never the whole list). Deterministic skips (capacity/exists_active/cooldown/ineligible/
 * invalid) are NEVER retried. Every pass is bounded by remaining slots, `maxRpcCalls`, and a wall-clock
 * `timeBudgetMs` (via the injected clock) — on expiry it stops and reports timedOut. Fully injectable
 * (createFn / clock / sleep) so limits, timeouts, and continue-past-capacity are unit-tested.
 */
export async function walkCandidates(
  candidateIds: string[],
  remaining: number,
  createFn: (id: string) => Promise<ReciprocalOutcome>,
  clock: () => number,
  sleepFn: (ms: number) => Promise<void>,
  limits: { maxRpcCalls: number; maxCandidateAttempts: number; timeBudgetMs: number; backoffMs: number },
  signal?: AbortSignal,
): Promise<WalkResult> {
  const deadline = clock() + limits.timeBudgetMs
  const outcomeById = new Map<string, ReciprocalOutcome>()
  const transientIds: string[] = []
  let created = 0, considered = 0, rpcCalls = 0, timedOut = false
  // Never START a DB op with no budget left (point 4): out of time OR the deadline signal fired.
  const outOfBudget = () => clock() >= deadline || signal?.aborted === true

  // Pass 1 — each candidate once, in fair order.
  for (const id of candidateIds) {
    if (created >= remaining) break
    if (rpcCalls >= limits.maxRpcCalls) break
    if (outOfBudget()) { timedOut = true; break }
    considered++; rpcCalls++
    const o = await createFn(id)
    outcomeById.set(id, o)
    if (o === 'created') created++
    else if (o === 'error') transientIds.push(id)   // ONLY transient errors are retry-eligible
  }

  // Pass 2 — retry ONLY the transient-failed candidates, once, within the remaining time + RPC budget.
  if (created < remaining && transientIds.length > 0 && !timedOut &&
      !outOfBudget() && limits.maxCandidateAttempts > 1) {
    const remainingMs = deadline - clock()
    if (remainingMs > 0) await sleepFn(Math.min(limits.backoffMs, remainingMs)) // short bounded backoff
    for (const id of transientIds) {
      if (created >= remaining) break
      if (rpcCalls >= limits.maxRpcCalls) break
      if (outOfBudget()) { timedOut = true; break }
      rpcCalls++
      const o = await createFn(id)
      outcomeById.set(id, o) // final outcome supersedes the transient one (aborted RPC → exists_active on retry)
      if (o === 'created') created++
    }
  }

  return { created, considered, rpcCalls, finalOutcomes: Array.from(outcomeById.values()), timedOut }
}

/**
 * THE single idempotent automatic-generation entry point (onboarding + weekly). Ranks the eligible
 * pool for fit, fair-selects counterparts using LIVE inbound exposure, and creates each as a canonical
 * reciprocal pair via the transactional RPC (both directions atomic; concurrency-safe advisory locks).
 * It NEVER creates a one-sided intro_request.
 *
 * INCIDENT NOTE: the prior implementation collapsed errors, deterministic skips, and an empty pool
 * into `count:0` with no reason. Root cause of the reported zero-result: generation produced no rows
 * and the old code erased the reason.
 *
 * DEADLINE ENFORCEMENT: one AbortController is established at entry and a timer aborts it at
 * GEN_TIME_BUDGET_MS. A deadline-bound admin client (createAdminClient({signal})) attaches that signal
 * to EVERY request it issues — eligibility read, capacity read, all ranker/profile reads (the ranker
 * receives this client), and every create_reciprocal_suggestion RPC — so a hung operation is genuinely
 * cancelled, not merely un-awaited. The walk also refuses to START an op past the deadline. On
 * abort/timeout the outer catch maps to transient_error, retryable:true (never a false empty pool).
 * The timer is always cleared and the controller aborted in `finally`, so no promise or timer lingers
 * after the function returns. An aborted RPC is outcome-ambiguous (it may have committed server-side);
 * the idempotent RPC makes any retry safe — a re-attempt returns exists_active rather than duplicating.
 */
export async function generateReciprocalBatchForMember(
  userId: string,
  source: 'onboarding' | 'weekly' | 'onboarding_retry',
  maxCount?: number,
): Promise<GenerationResult> {
  const cid = nextCorrelationId()
  logReciprocalGeneration('invoked', source, { cid })
  const target = maxCount ?? RECOMMENDATIONS_PER_BATCH
  // member_pairs.source only permits a fixed set (migration 050 CHECK); an onboarding retry is still
  // an 'onboarding' pair. Map for the RPC while logging the true generation source above.
  const pairSource = source === 'weekly' ? 'weekly' : 'onboarding'

  // ONE overall deadline for the whole generation; the signal cancels every DB op via the client.
  const controller = new AbortController()
  const deadlineAt = Date.now() + GEN_TIME_BUDGET_MS
  const timer = setTimeout(() => controller.abort(), GEN_TIME_BUDGET_MS)
  const adminClient = createAdminClient({ signal: controller.signal })

  const finish = (outcome: GenerationOutcome, count: number, considered: number, rpcCalls: number): GenerationResult => {
    logReciprocalGeneration(outcome, source, { cid, created: count, considered, rpcCalls })
    return { count, considered, outcome, retryable: retryableFor(outcome), rpcCalls }
  }

  try {
    // The NEW member's own eligibility — if ineligible, make NO RPC calls. (deadline-bound read)
    const { data: me, error: meErr } = await adminClient
      .from('profiles').select(`id, ${ELIGIBILITY_COLUMNS}`).eq('id', userId).maybeSingle()
    if (meErr) return finish('transient_error', 0, 0, 0)         // uncertain read → retryable
    if (!me || !isEligibleMember(me)) return finish('ineligible', 0, 0, 0)

    // Respect the member's own VISIBLE-card limit: only fill free visible slots. (deadline-bound)
    //
    // This used to count 'suggested' + 'queued' together against one cap of 2, which is wrong in
    // both directions: it let a member holding two reservations look full and receive nothing,
    // while never actually bounding how many visible cards they could accumulate. A reservation
    // occupies a reserved slot and no visible one — see lib/introductions/capacity.
    const { count: aVisible, error: capErr } = await adminClient
      .from('intro_requests').select('id', { count: 'exact', head: true })
      .eq('requester_id', userId).eq('status', VISIBLE_STATUS)
    if (capErr) return finish('transient_error', 0, 0, 0)        // uncertain read → retryable
    // This read is ADVISORY only — it avoids pointless RPC calls. The authoritative check happens
    // inside create_reciprocal_suggestion under the member advisory lock, which is what makes two
    // concurrent generators safe.
    const remaining = Math.min(target, visibleSlotsFree({ visible: aVisible ?? 0, reserved: 0 }))
    if (remaining === 0) return finish('noop_at_capacity', 0, 0, 0) // idempotent re-run — already has cards

    if (Date.now() >= deadlineAt || controller.signal.aborted) return finish('transient_error', 0, 0, 0)

    // Ranker + exposure use the SAME deadline-bound client → all their reads are cancellable.
    const { candidates } = await rankCandidatesForUser(userId, RECIPROCAL_CANDIDATE_POOL, adminClient)
    if (!candidates.length) return finish('empty_pool', 0, 0, 0)

    const exposure = await getActiveInboundExposure(adminClient, candidates.map((c: any) => c.id))
    const ordered = selectFairCounterparts(
      candidates.map((c: any) => ({ id: c.id, score: c.finalScore ?? 0, exposure: exposure.get(c.id) ?? NO_EXPOSURE })),
      candidates.length,
    ).map((c) => c.id)

    // Each RPC is issued through the deadline-bound client (cancelled at the deadline) and the walk
    // refuses to start one past the deadline. Remaining budget bounds the walk's own clock check.
    const walk = await walkCandidates(
      ordered, remaining,
      (id) => createReciprocalSuggestion(adminClient, userId, id, { source: pairSource }).then((r) => r.outcome),
      () => Date.now(), sleep,
      { ...WALK_LIMITS, timeBudgetMs: Math.max(0, deadlineAt - Date.now()) },
      controller.signal,
    )
    const outcome = classifyGenerationOutcome(walk.finalOutcomes, {
      createdCount: walk.created, candidatesEmpty: false, memberIneligible: false, timedOut: walk.timedOut,
    })
    return finish(outcome, walk.created, walk.considered, walk.rpcCalls)
  } catch {
    // Any exception incl. an AbortError from a cancelled op → conclusive uncertainty, never empty pool.
    return finish('transient_error', 0, 0, 0)
  } finally {
    // No timer or in-flight request may outlive the response (point 7).
    clearTimeout(timer)
    controller.abort()
  }
}
