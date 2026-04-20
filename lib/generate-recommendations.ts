import { createAdminClient } from '@/lib/supabase/admin'
import { getEffectiveTier } from '@/lib/tier-override'

const TIER_RECOMMENDATION_COUNTS: Record<string, number> = {
  free: 3,
  professional: 5,
  executive: 8,
  founding: 5,  // Same as professional
}

// Unified scoring model for all tiers
// Final Score = Alignment (55%) + Network Value (30%) + Responsiveness (15%)

function calculateAlignmentScore(userProfile: any, candidate: any): number {
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

interface ThrottlingConfig {
  baseCapPercentage: number      // Base max % of business solutions per batch
  tierMultipliers: Record<string, number>  // Tier-based adjustment
  preferenceAdjustment: number   // Reduction when user is NOT open to solutions
}

const THROTTLING_CONFIG: ThrottlingConfig = {
  baseCapPercentage: 0.30,  // 30% max business solutions by default
  tierMultipliers: {
    free: 1.0,          // Free: full 30%
    professional: 0.7,  // Professional: 21% (30% * 0.7)
    executive: 0.5,     // Executive: 15% (30% * 0.5)
    founding: 0.7       // Founding: same as professional
  },
  preferenceAdjustment: 0.5  // If NOT open: cut cap in half
}


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
    // If NOT open to mentorship: suppress juniors (but allow rare exceptions)
    // Allow 1 junior only if batch size >= 8
    if (targetCount >= 8 && juniors.length > 0) {
      maxJuniors = 1
    }
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
 * Interleave juniors among non-juniors to prevent clustering
 */
function interleaveJuniors(nonJuniors: any[], juniors: any[]): any[] {
  if (juniors.length === 0) return nonJuniors
  if (nonJuniors.length === 0) return juniors
  
  const result: any[] = []
  const totalSlots = nonJuniors.length + juniors.length
  const spacing = totalSlots / juniors.length
  
  let nonJuniorIndex = 0
  let juniorIndex = 0
  
  for (let i = 0; i < totalSlots; i++) {
    const juniorSlotPosition = Math.floor(juniorIndex * spacing)
    
    if (i === juniorSlotPosition && juniorIndex < juniors.length) {
      result.push(juniors[juniorIndex])
      juniorIndex++
    } else if (nonJuniorIndex < nonJuniors.length) {
      result.push(nonJuniors[nonJuniorIndex])
      nonJuniorIndex++
    }
  }
  
  return result
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
  
  // 1. Separate business solutions from peers
  const businessSolutions = candidates.filter(c => isBusinessSolutionProvider(c))
  const peers = candidates.filter(c => !isBusinessSolutionProvider(c))
  
  // 2. Calculate max allowed business solutions
  let maxBusinessSolutions = Math.floor(
    targetCount * THROTTLING_CONFIG.baseCapPercentage * (THROTTLING_CONFIG.tierMultipliers[userTier] || 1.0)
  )
  
  // 3. Reduce further if user is NOT open to business solutions
  const userOpenToSolutions = userProfile.open_to_business_solutions || false
  if (!userOpenToSolutions) {
    maxBusinessSolutions = Math.floor(maxBusinessSolutions * THROTTLING_CONFIG.preferenceAdjustment)
  }
  
  // Ensure at least 1 business solution can appear ONLY if user is open to solutions
  if (maxBusinessSolutions === 0 && targetCount >= 3 && businessSolutions.length > 0 && userOpenToSolutions) {
    maxBusinessSolutions = 1
  }
  
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


// Helper: Identify if candidate is a business solution provider
function isBusinessSolutionProvider(candidate: any): boolean {
  const roleType = (candidate.role_type || '').toLowerCase()
  
  // Law firms, consultants, service providers
  return roleType.includes('law firm') || 
         roleType.includes('consultant') ||
         roleType.includes('legal services') ||
         roleType.includes('legal tech')
}

function calculateFinalScore(userProfile: any, candidate: any, userTier: string = 'free', targetedRequest: any = null): number {
  // All inputs are now 0-100 normalized
  const alignmentNormalized = calculateAlignmentScore(userProfile, candidate) // 0-100
  const alignmentWeighted = (alignmentNormalized / 100) * 55
  
  const networkValueRaw = candidate.networkValueScore || 50
  const networkValueWeighted = (networkValueRaw / 100) * 30
  
  const responsivenessRaw = candidate.responsivenessScore || 50
  const responsivenessWeighted = (responsivenessRaw / 100) * 15
  
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

function generateIntroReason(userProfile: any, candidate: any): string {
  const pronoun = candidate.full_name?.toLowerCase().endsWith('a') || 
                  candidate.full_name?.includes('Sarah') || 
                  candidate.full_name?.includes('Priya') ||
                  candidate.full_name?.includes('Alexandra') ||
                  candidate.full_name?.includes('Emily') ||
                  candidate.full_name?.includes('Rachel') ? 'She' : 'He'
  
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
  
  const userSeniority = userProfile.seniority || ''
  const candidateSeniority = candidate.seniority || ''
  const userRole = userProfile.role_type || ''
  const candidateRole = candidate.role_type || ''
  
  // Helper to pick random phrase
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)]
  
  // Determine relationship type
  const isMentor = (userSeniority === 'Junior' && (candidateSeniority === 'Senior' || candidateSeniority === 'Executive')) ||
                   (userSeniority === 'Mid-Level' && candidateSeniority === 'Executive')
  const isPeer = userSeniority === candidateSeniority
  const userIsLawFirm = userRole.toLowerCase().includes('law firm')
  const candidateIsInHouse = candidateRole.toLowerCase().includes('in-house')
  const userIsInHouse = userRole.toLowerCase().includes('in-house')
  const candidateIsLawFirm = candidateRole.toLowerCase().includes('law firm')
  
  // CASE 1: Shared expertise + mentor
  if (sharedExpertise.length > 0 && isMentor && candidate.company) {
    const expertise = sharedExpertise[0]
    return pick([
      `${pronoun} has deep ${expertise} experience at ${candidate.company} and could accelerate your growth`,
      `${pronoun} specializes in ${expertise} at ${candidate.company} and would be an excellent mentor`,
      `${pronoun}'s ${expertise} expertise at ${candidate.company} could help shape your career trajectory`
    ])
  }
  
  // CASE 2: Shared expertise + peer
  if (sharedExpertise.length > 0 && isPeer && candidate.company) {
    const expertise = sharedExpertise.length > 1 ? sharedExpertise[0] : sharedExpertise[0]
    return pick([
      `${pronoun} tackles similar ${expertise} challenges at ${candidate.company}`,
      `${pronoun} works in ${expertise} at ${candidate.company} and faces parallel problems`,
      `${pronoun} specializes in ${expertise} at ${candidate.company} and could be a thought partner`
    ])
  }
  
  // CASE 3: Law firm → In-house (client development)
  if (userIsLawFirm && candidateIsInHouse && candidate.company) {
    if (candidateExpertise.length > 0) {
      const expertise = candidateExpertise[0]
      return pick([
        `${pronoun} leads ${expertise} matters at ${candidate.company} and could be a valuable client connection`,
        `${pronoun} manages ${expertise} in-house at ${candidate.company} and brings the client perspective`,
        `${pronoun} oversees ${expertise} at ${candidate.company}—potential client and strategic contact`
      ])
    }
    return pick([
      `${pronoun} manages legal strategy at ${candidate.company} and could be a valuable client connection`,
      `${pronoun} leads in-house counsel work at ${candidate.company}—potential client relationship`
    ])
  }
  
  // CASE 4: In-house → Law firm (outside counsel perspective)
  if (userIsInHouse && candidateIsLawFirm && candidate.company) {
    if (candidateExpertise.length > 0) {
      const expertise = candidateExpertise[0]
      return pick([
        `${pronoun} advises on ${expertise} from ${candidate.company} and offers outside counsel insight`,
        `${pronoun} practices ${expertise} at ${candidate.company} and brings law firm perspective`,
        `${pronoun} specializes in ${expertise} at ${candidate.company}—valuable advisor contact`
      ])
    }
    return pick([
      `${pronoun} brings outside counsel perspective from ${candidate.company}`,
      `${pronoun} advises clients at ${candidate.company} and offers law firm insight`
    ])
  }
  
  // CASE 5: Same role type (in-house to in-house)
  const sameInHouse = userRole.toLowerCase().includes('in-house') && candidateRole.toLowerCase().includes('in-house')
  if (sameInHouse && candidate.company) {
    return pick([
      `${pronoun} navigates similar in-house challenges at ${candidate.company}`,
      `${pronoun} handles comparable legal operations at ${candidate.company} and could share strategies`,
      `${pronoun} manages in-house matters at ${candidate.company} and faces parallel challenges`
    ])
  }
  
  // CASE 6: Different expertise (complementary learning)
  const uniqueExpertise = candidateExpertise.filter(e => !userExpertise.includes(e))
  if (uniqueExpertise.length > 0 && candidate.company) {
    const expertise = uniqueExpertise[0]
    return pick([
      `${pronoun} specializes in ${expertise} at ${candidate.company}—complementary expertise worth knowing`,
      `${pronoun} brings ${expertise} perspective from ${candidate.company} to broaden your network`,
      `${pronoun} works in ${expertise} at ${candidate.company} and offers different domain expertise`
    ])
  }
  
  // CASE 7: Peer relationship (same seniority)
  if (isPeer && candidate.company) {
    return pick([
      `${pronoun} operates at a similar level at ${candidate.company} and could be a valuable peer`,
      `${pronoun} navigates comparable challenges at ${candidate.company}`,
      `${pronoun} is building their career at ${candidate.company} and shares your trajectory`
    ])
  }
  
  // CASE 8: Just mentor relationship
  if (isMentor && candidate.company) {
    return pick([
      `${pronoun} has extensive experience at ${candidate.company} and could provide strategic guidance`,
      `${pronoun} brings senior perspective from ${candidate.company} and could help navigate your career`,
      `${pronoun} leads at ${candidate.company} and would be a valuable strategic advisor`
    ])
  }
  
  // CASE 9: Role-based even without other info
  if (candidateRole && candidate.company) {
    if (candidateRole.toLowerCase().includes('law firm')) {
      return pick([
        `${pronoun} practices at ${candidate.company} and brings law firm perspective`,
        `${pronoun} advises clients from ${candidate.company}`,
        `${pronoun} works at ${candidate.company} and offers outside counsel insight`
      ])
    }
    if (candidateRole.toLowerCase().includes('in-house')) {
      return pick([
        `${pronoun} manages legal matters at ${candidate.company}`,
        `${pronoun} leads in-house work at ${candidate.company} and brings client-side experience`,
        `${pronoun} handles legal operations at ${candidate.company}`
      ])
    }
  }
  
  // CASE 10: Company prestige/reputation
  if (candidate.company) {
    return pick([
      `${pronoun} brings valuable ${candidate.company} experience`,
      `${pronoun} works at ${candidate.company} and could be a strategic connection`,
      `${pronoun}'s work at ${candidate.company} offers industry perspective`
    ])
  }
  
  // Fallback
  return `${pronoun} could be a valuable addition to your network`
}

export async function generateOnboardingRecommendations(userId: string) {
  const adminClient = createAdminClient()
  
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
  const recommendationCount = TIER_RECOMMENDATION_COUNTS[userTier] || 3
  console.log('[generate-recommendations] User tier:', userTier, 'Count:', recommendationCount)
  
  const { data: allUsers, error: usersError } = await adminClient
    .from('profiles')
    .select('*')
    .eq('account_status', 'active')
    .eq('profile_complete', true)
    .neq('id', userId)
    .neq('email', 'bizdev91@gmail.com')
  
  if (usersError || !allUsers) {
    throw new Error('Failed to fetch users')
  }
  
  console.log('[generate-recommendations] All users count:', allUsers.length)
  
  // EXCLUSION LOGIC: Get users to exclude from matching
  
  // 1. Users already matched (bidirectional)
  const { data: existingMatches } = await adminClient
    .from('matches')
    .select('user_a_id, user_b_id')
    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)
  
  const matchedUserIds = new Set<string>()
  existingMatches?.forEach(m => {
    matchedUserIds.add(m.user_a_id)
    matchedUserIds.add(m.user_b_id)
  })
  matchedUserIds.delete(userId) // Remove self
  
  // 2. Users hidden or passed (bidirectional with cooldown)
  const cooldownDate = new Date()
  cooldownDate.setDate(cooldownDate.getDate() - 75) // 75 day cooldown
  
  const { data: hiddenOrPassed } = await adminClient
    .from('intro_requests')
    .select('requester_id, target_user_id, status, updated_at')
    .or(`requester_id.eq.${userId},target_user_id.eq.${userId}`)
    .in('status', ['hidden', 'passed'])
  
  const excludedUserIds = new Set<string>()
  hiddenOrPassed?.forEach(req => {
    // Hidden = permanent exclusion
    if (req.status === 'hidden') {
      const otherId = req.requester_id === userId ? req.target_user_id : req.requester_id
      excludedUserIds.add(otherId)
    }
    
    // Passed = temporary exclusion (75 day cooldown)
    if (req.status === 'passed') {
      const passedAt = new Date(req.updated_at)
      if (passedAt > cooldownDate) {
        const otherId = req.requester_id === userId ? req.target_user_id : req.requester_id
        excludedUserIds.add(otherId)
      }
    }
  })
  
  // 3. Users with existing intro requests
  const { data: existingIntros } = await adminClient
    .from('intro_requests')
    .select('target_user_id, requester_id')
    .or(`requester_id.eq.${userId},target_user_id.eq.${userId}`)
    .in('status', ['suggested', 'pending', 'accepted'])
  
  existingIntros?.forEach(req => {
    const otherId = req.requester_id === userId ? req.target_user_id : req.requester_id
    excludedUserIds.add(otherId)
  })
  
  console.log('[generate-recommendations] Excluded users:', {
    matched: matchedUserIds.size,
    hidden_or_passed: excludedUserIds.size,
    total_excluded: new Set([...Array.from(matchedUserIds), ...Array.from(excludedUserIds)]).size
  })
  
  const usersWithData = allUsers
    .filter(u => {
      // Exclude matched users
      if (matchedUserIds.has(u.id)) return false
      // Exclude hidden/passed/suggested users
      if (excludedUserIds.has(u.id)) return false
      // Continue with existing data validation
      return true
    })
    .filter(u => {
    const hasName = !!u.full_name
    const hasRole = !!u.role_type
    if (!hasName || !hasRole) return false
    if (Array.isArray(u.expertise)) return u.expertise.length > 0
    return true
  })
  
  console.log('[generate-recommendations] Users after filter:', usersWithData.length)
  
  const scoredCandidates = usersWithData.map(candidate => ({
    ...candidate,
    finalScore: calculateFinalScore(newUserProfile, candidate, userTier, targetedRequest)
  }))
  
  const filtered = scoredCandidates.filter(c => c.finalScore >= 10)
  console.log('[generate-recommendations] After relevance filter (>= 10):', filtered.length)
  
  // Apply mentorship filtering
  const mentorshipFiltered = filtered.filter(c => !shouldFilterByMentorship(newUserProfile, c, userSeniorityLevel))
  
  console.log('[generate-recommendations] After mentorship filter:', mentorshipFiltered.length)
  
  const rankedCandidates = applyTierRankingAdjustment(mentorshipFiltered, userTier)
  // Apply throttling to prevent consultant/law firm clustering
  const throttled = applyThrottling(
    rankedCandidates,
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
  
  const sorted = mentorshipControlled.slice(0, recommendationCount)
  
  console.log('[generate-recommendations] Top 3 final scores:', sorted.slice(0, 3).map(c => ({ email: c.email, score: c.finalScore.toFixed(1) })))
  
  if (sorted.length === 0) {
    return { count: 0 }
  }
  
  // Final safety: already handled by exclusion logic above
  const introRequests = sorted.map(candidate => ({
    requester_id: userId,
    target_user_id: candidate.id,
    status: 'suggested',
    match_reason: generateIntroReason(newUserProfile, candidate),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }))
  
  const { error: insertError } = await adminClient
    .from('intro_requests')
    .insert(introRequests)
  
  if (insertError) {
    throw new Error(`Failed to create recommendations: ${insertError.message}`)
  }
  
  // Mark targeted request as applied (premium feature)
  if (targetedRequest) {
    const { error: updateError } = await adminClient
      .from('targeted_requests')
      .update({
        status: 'applied',
        applied_at: new Date().toISOString()
      })
      .eq('id', targetedRequest.id)
      .eq('status', 'pending')  // ✅ Guard: only update if still pending
    
    if (updateError) {
      console.error('[generate-recommendations] CRITICAL: Failed to mark request as applied:', {
        request_id: targetedRequest.id,
        error: updateError
      })
      throw new Error(`Failed to mark targeted request as applied: ${updateError.message}`)
    } else {
      console.log('[generate-recommendations] Targeted request marked as applied:', {
        request_id: targetedRequest.id,
        user_id: userId,
        role: targetedRequest.role
      })
    }
  }
  
  return { count: sorted.length }
}
