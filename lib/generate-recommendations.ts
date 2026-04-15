import { createAdminClient } from '@/lib/supabase/admin'

const TIER_RECOMMENDATION_COUNTS: Record<string, number> = {
  free: 3,
  professional: 5,
  executive: 8,
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
  if (userPrefs.some((p: string) => p.toLowerCase() === candidateRole.toLowerCase())) {
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
  
  // Get tier-based recommendation count
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
  
  // Filter out users without actual profile data
  const usersWithData = allUsers.filter(u => 
    u.full_name && u.role_type && u.expertise && u.expertise.length > 0
  )
  
  const scoredCandidates = usersWithData
    .map(candidate => ({
      ...candidate,
      relevance_score: scoreMatch(newUserProfile, candidate)
    }))
    .filter(c => c.relevance_score > 0)
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, recommendationCount)
  
  if (scoredCandidates.length === 0) {
    return { count: 0 }
  }
  
  const introRequests = scoredCandidates.map(candidate => ({
    requester_id: userId,
    target_user_id: candidate.id,
    status: 'suggested',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }))
  
  const { error: insertError } = await adminClient
    .from('intro_requests')
    .insert(introRequests)
  
  if (insertError) {
    throw new Error(`Failed to create recommendations: ${insertError.message}`)
  }
  
  return { count: scoredCandidates.length }
}
