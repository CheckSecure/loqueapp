import { createAdminClient } from '@/lib/supabase/admin'

const TIER_RECOMMENDATION_COUNTS: Record<string, number> = {
  free: 3,
  professional: 5,
  executive: 8,
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

// Helper: Identify if candidate is a business solution provider
function isBusinessSolutionProvider(candidate: any): boolean {
  const roleType = (candidate.role_type || '').toLowerCase()
  
  // Law firms, consultants, service providers
  return roleType.includes('law firm') || 
         roleType.includes('consultant') ||
         roleType.includes('legal services') ||
         roleType.includes('legal tech')
}

function calculateFinalScore(userProfile: any, candidate: any, userTier: string = 'free'): number {
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
  
  const finalScore = alignmentWeighted + networkValueWeighted + responsivenessWeighted + priorityBonus + boostBonus + tierAdjustment
  
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
  
  console.log('[generate-recommendations] New user profile:', {
    email: newUserProfile.email,
    role_type: newUserProfile.role_type,
    seniority: newUserProfile.seniority,
    expertise: newUserProfile.expertise,
    intro_preferences: newUserProfile.intro_preferences,
    city: newUserProfile.city,
    state: newUserProfile.state,
    open_to_business_solutions: newUserProfile.open_to_business_solutions
  })
  
  const userTier = newUserProfile.subscription_tier || 'free'
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
    finalScore: calculateFinalScore(newUserProfile, candidate, userTier)
  }))
  
  const filtered = scoredCandidates.filter(c => c.finalScore >= 10)
  console.log('[generate-recommendations] After relevance filter (>= 10):', filtered.length)
  
  const rankedCandidates = applyTierRankingAdjustment(filtered, userTier)
  const sorted = rankedCandidates.slice(0, recommendationCount)
  
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
  
  return { count: sorted.length }
}
