import { createAdminClient } from '@/lib/supabase/admin'

const TIER_RECOMMENDATION_COUNTS: Record<string, number> = {
  free: 3,
  professional: 5,
  executive: 8,
}

// Generate personalized introduction reasoning
function generateIntroReason(userProfile: any, candidate: any): string {
  const pronoun = candidate.full_name?.toLowerCase().endsWith('a') || 
                  candidate.full_name?.includes('Sarah') || 
                  candidate.full_name?.includes('Priya') ||
                  candidate.full_name?.includes('Alexandra') ? 'She' : 'He'
  
  const isLawFirm = candidate.role_type?.toLowerCase().includes('law firm')
  const isInHouse = candidate.role_type?.toLowerCase().includes('in-house')
  
  // Law firm attorney with expertise
  if (isLawFirm && Array.isArray(candidate.expertise) && candidate.expertise.length > 0) {
    const exp = candidate.expertise.slice(0, 2).join(' and ')
    if (candidate.seniority === 'Senior' || candidate.seniority === 'Executive') {
      return `${pronoun} practices ${exp} at ${candidate.company || 'a top firm'} and could be a great mentor`
    }
    return `${pronoun} focuses on ${exp} at ${candidate.company || 'a law firm'}`
  }
  
  // In-house counsel with company context
  if (isInHouse && candidate.company) {
    if (Array.isArray(candidate.expertise) && candidate.expertise.length > 0) {
      const exp = candidate.expertise[0]
      return `${pronoun} leads ${exp} strategy at ${candidate.company}`
    }
    if (candidate.seniority === 'Executive' || candidate.seniority === 'C-Suite') {
      return `${pronoun} oversees legal operations at ${candidate.company}`
    }
    return `${pronoun} works in-house at ${candidate.company}`
  }
  
  // Generic with expertise
  if (Array.isArray(candidate.expertise) && candidate.expertise.length > 0) {
    const exp = candidate.expertise.slice(0, 2).join(' and ')
    return `${pronoun} specializes in ${exp} and brings valuable experience`
  }
  
  // Fallback
  if (candidate.company) {
    return `${pronoun} works at ${candidate.company} and could be a valuable connection`
  }
  
  return `Could be a valuable connection`
}

function scoreMatch(newUser: any, candidate: any): number {
  let score = 0
  
  const boostBonus = (candidate.boost_score || 0) * 2
  score += boostBonus
  
  if (candidate.is_priority) {
    score += 50
  }
  
  const userPrefs: string[] = Array.isArray(newUser.intro_preferences) ? newUser.intro_preferences : []
  const candidateRole: string = candidate.role_type || ''
  
  // Fuzzy role matching - check if any preference is contained in the role or vice versa
  const roleMatch = userPrefs.some((pref: string) => {
    const prefLower = pref.toLowerCase()
    const roleLower = candidateRole.toLowerCase()
    return prefLower.includes(roleLower) || roleLower.includes(prefLower)
  })
  
  if (roleMatch) {
    score += 30
  }
  
  const userSeniority = newUser.seniority || ''
  const candidateSeniority = candidate.seniority || ''
  if (userSeniority === candidateSeniority) {
    score += 20
  }
  
  const userExpertise: string[] = Array.isArray(newUser.expertise) ? newUser.expertise : []
  const candidateExpertise: string[] = Array.isArray(candidate.expertise) ? candidate.expertise : []
  const sharedExpertise = userExpertise.filter(e => candidateExpertise.includes(e))
  score += sharedExpertise.length * 15
  
  if (newUser.city && candidate.city && 
      newUser.city.toLowerCase() === candidate.city.toLowerCase()) {
    score += 25
  }
  
  if (newUser.state && candidate.state && 
      newUser.state.toLowerCase() === candidate.state.toLowerCase() &&
      newUser.city?.toLowerCase() !== candidate.city?.toLowerCase()) {
    score += 10
  }
  
  return score
}


// Apply tier-based quality boosts for premium users
function applyTierQualityBoost(baseScore: number, candidate: any, userTier: string): number {
  let boostedScore = baseScore
  
  // Free tier gets no boosts - basic matching only
  if (userTier === 'free') {
    return boostedScore
  }
  
  // Professional tier boosts
  if (userTier === 'professional') {
    // Boost for high-value network connections
    if (candidate.networkValueScore && candidate.networkValueScore > 70) {
      boostedScore += 15
    }
    
    // Boost for responsive candidates
    if (candidate.responsivenessScore && candidate.responsivenessScore > 70) {
      boostedScore += 10
    }
    
    // Boost for priority/verified candidates
    if (candidate.is_priority) {
      boostedScore += 25
    }
    
    // Boost for senior professionals
    if (candidate.seniority === 'Senior') {
      boostedScore += 10
    }
  }
  
  // Executive tier boosts (higher than professional)
  if (userTier === 'executive') {
    // Premium boost for top network value
    if (candidate.networkValueScore && candidate.networkValueScore > 70) {
      boostedScore += 35
    } else if (candidate.networkValueScore && candidate.networkValueScore > 50) {
      boostedScore += 15
    }
    
    // Premium boost for responsiveness
    if (candidate.responsivenessScore && candidate.responsivenessScore > 70) {
      boostedScore += 25
    } else if (candidate.responsivenessScore && candidate.responsivenessScore > 50) {
      boostedScore += 10
    }
    
    // Strong boost for priority candidates
    if (candidate.is_priority) {
      boostedScore += 50
    }
    
    // Heavily prioritize C-suite and executives
    if (candidate.seniority === 'Executive' || candidate.seniority === 'C-Suite') {
      boostedScore += 30
    } else if (candidate.seniority === 'Senior') {
      boostedScore += 15
    }
  }
  
  return boostedScore
}

// Tier-based minimum score thresholds
const TIER_SCORE_THRESHOLDS: Record<string, number> = {
  free: 20,         // Only show solid matches
  professional: 10, // More permissive, quality-boosted
  executive: 5      // Most permissive, heavily boosted
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
    state: newUserProfile.state
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
  console.log('[generate-recommendations] Sample user:', allUsers[0])
  
  const usersWithData = allUsers.filter(u => {
    const hasName = !!u.full_name
    const hasRole = !!u.role_type
    console.log('[filter]', u.email, 'name:', hasName, 'role:', hasRole, 'expertise:', u.expertise)
    if (!hasName || !hasRole) return false
    if (Array.isArray(u.expertise)) return u.expertise.length > 0
    return true
  })
  console.log('[generate-recommendations] Users after filter:', usersWithData.length)
  
  const scoredCandidates = usersWithData
    .map(candidate => {
      const baseScore = scoreMatch(newUserProfile, candidate)
      const boostedScore = applyTierQualityBoost(baseScore, candidate, userTier)
      return {
        ...candidate,
        relevance_score: boostedScore,
        base_score: baseScore  // Keep for debugging
      }
    })
  console.log('[generate-recommendations] After scoring:', scoredCandidates.length, 'candidates')
  console.log('[generate-recommendations] Sample scores:', scoredCandidates.slice(0, 3).map(c => ({ email: c.email, score: c.relevance_score })))
  
  const scoreThreshold = TIER_SCORE_THRESHOLDS[userTier] || 20
  const filtered = scoredCandidates
    .filter(c => c.relevance_score >= scoreThreshold)
  console.log('[generate-recommendations] Score threshold for tier:', userTier, '=', scoreThreshold)
  console.log('[generate-recommendations] After tier-based filter:', filtered.length)
  console.log('[generate-recommendations] Top 3 scores:', filtered.slice(0, 3).map(c => ({ email: c.email, base: c.base_score, boosted: c.relevance_score })))
  
  const sorted = filtered
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, recommendationCount)
  
  if (sorted.length === 0) {
    return { count: 0 }
  }
  
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
