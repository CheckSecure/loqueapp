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
  
  // Goal/preference overlap (30 points max)
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
  
  // Seniority fit (20 points max)
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
  
  // Expertise overlap (15 points max)
  const userExpertise: string[] = Array.isArray(userProfile.expertise) ? userProfile.expertise : []
  const candidateExpertise: string[] = Array.isArray(candidate.expertise) ? candidate.expertise : []
  const sharedExpertise = userExpertise.filter(e => candidateExpertise.includes(e))
  alignmentScore += Math.min(sharedExpertise.length * 5, 15)
  
  // Location preference (25 points max for same city, 10 for same state)
  if (userProfile.city && candidate.city && 
      userProfile.city.toLowerCase() === candidate.city.toLowerCase()) {
    alignmentScore += 25
  } else if (userProfile.state && candidate.state && 
             userProfile.state.toLowerCase() === candidate.state.toLowerCase()) {
    alignmentScore += 10
  }
  
  return alignmentScore
}

function calculateFinalScore(userProfile: any, candidate: any): number {
  const alignmentRaw = calculateAlignmentScore(userProfile, candidate)
  const alignmentWeighted = (alignmentRaw / 90) * 55
  
  const networkValueRaw = candidate.networkValueScore || 50
  const networkValueWeighted = (networkValueRaw / 100) * 30
  
  const responsivenessRaw = candidate.responsivenessScore || 50
  const responsivenessWeighted = (responsivenessRaw / 100) * 15
  
  const priorityBonus = candidate.is_priority ? 5 : 0
  const boostBonus = (candidate.boost_score || 0) * 0.5
  
  return alignmentWeighted + networkValueWeighted + responsivenessWeighted + priorityBonus + boostBonus
}

function applyTierRankingAdjustment(candidates: any[], userTier: string): any[] {
  const sorted = [...candidates].sort((a, b) => b.finalScore - a.finalScore)
  
  if (userTier === 'free') {
    return sorted.map((c) => ({
      ...c,
      rankingScore: c.finalScore + (Math.random() * 5) - 2.5
    })).sort((a, b) => b.rankingScore - a.rankingScore)
  }
  
  if (userTier === 'professional') {
    const top30Index = Math.floor(sorted.length * 0.3)
    const bottom30Index = Math.floor(sorted.length * 0.7)
    
    return sorted.map((c, idx) => {
      let adjustment = 0
      if (idx < top30Index) adjustment = 8
      else if (idx > bottom30Index) adjustment = -5
      
      return { ...c, rankingScore: c.finalScore + adjustment }
    }).sort((a, b) => b.rankingScore - a.rankingScore)
  }
  
  if (userTier === 'executive') {
    const top20Index = Math.floor(sorted.length * 0.2)
    const mid50Index = Math.floor(sorted.length * 0.5)
    
    return sorted.map((c, idx) => {
      let adjustment = 0
      if (idx < top20Index) adjustment = 15
      else if (idx > mid50Index) adjustment = -10
      
      return { ...c, rankingScore: c.finalScore + adjustment }
    }).sort((a, b) => b.rankingScore - a.rankingScore)
  }
  
  return sorted.map(c => ({ ...c, rankingScore: c.finalScore }))
}

function generateIntroReason(userProfile: any, candidate: any): string {
  const pronoun = candidate.full_name?.toLowerCase().endsWith('a') || 
                  candidate.full_name?.includes('Sarah') || 
                  candidate.full_name?.includes('Priya') ||
                  candidate.full_name?.includes('Alexandra') ? 'She' : 'He'
  
  const isLawFirm = candidate.role_type?.toLowerCase().includes('law firm')
  const isInHouse = candidate.role_type?.toLowerCase().includes('in-house')
  
  if (isLawFirm && Array.isArray(candidate.expertise) && candidate.expertise.length > 0) {
    const exp = candidate.expertise.slice(0, 2).join(' and ')
    return `${pronoun} practices ${exp} at ${candidate.company} and could be a great mentor`
  }
  
  if (isLawFirm && candidate.company) {
    return `${pronoun} is a ${candidate.title?.toLowerCase() || 'partner'} at ${candidate.company} with valuable experience`
  }
  
  if (isInHouse && Array.isArray(candidate.expertise) && candidate.expertise.length > 0 && candidate.company) {
    const exp = candidate.expertise[0]
    return `${pronoun} leads ${exp} strategy at ${candidate.company}`
  }
  
  if (isInHouse && candidate.company) {
    return `${pronoun} oversees legal operations at ${candidate.company}`
  }
  
  if (Array.isArray(candidate.expertise) && candidate.expertise.length > 0) {
    const exp = candidate.expertise[0]
    return `${pronoun} specializes in ${exp} and brings valuable experience`
  }
  
  return `${pronoun} could be a valuable connection in your network`
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
  
  const usersWithData = allUsers.filter(u => {
    const hasName = !!u.full_name
    const hasRole = !!u.role_type
    if (!hasName || !hasRole) return false
    if (Array.isArray(u.expertise)) return u.expertise.length > 0
    return true
  })
  
  console.log('[generate-recommendations] Users after filter:', usersWithData.length)
  
  const scoredCandidates = usersWithData.map(candidate => ({
    ...candidate,
    finalScore: calculateFinalScore(newUserProfile, candidate)
  }))
  
  const filtered = scoredCandidates.filter(c => c.finalScore >= 10)
  console.log('[generate-recommendations] After relevance filter (>= 10):', filtered.length)
  
  const rankedCandidates = applyTierRankingAdjustment(filtered, userTier)
  const sorted = rankedCandidates.slice(0, recommendationCount)
  
  console.log('[generate-recommendations] Top 3 final scores:', sorted.slice(0, 3).map(c => ({ email: c.email, score: c.finalScore.toFixed(1) })))
  
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
