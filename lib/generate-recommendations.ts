import { createAdminClient } from '@/lib/supabase/admin'

const TIER_RECOMMENDATION_COUNTS: Record<string, number> = {
  free: 3,
  professional: 5,
  executive: 8,
}


// Generate personalized introduction reasoning
// Generate personalized introduction reasoning
function generateIntroReason(userProfile: any, candidate: any): string {
  const pronoun = candidate.full_name?.toLowerCase().endsWith('a') || 
                  candidate.full_name?.includes('Sarah') || 
                  candidate.full_name?.includes('Priya') ||
                  candidate.full_name?.includes('Alexandra') ? 'She' : 'He'
  
  const reasons = []
  
  // Expertise match
  if (Array.isArray(candidate.expertise) && candidate.expertise.length > 0) {
    const exp = candidate.expertise.slice(0, 2).join(' and ')
    reasons.push(`specializes in ${exp}`)
  }
  
  // Seniority + role value prop
  if (candidate.seniority === userProfile.seniority) {
    reasons.push(`${candidate.seniority.toLowerCase()}-level peer in ${candidate.role_type?.toLowerCase() || 'legal'}`)
  } else if (candidate.seniority === 'Executive' || candidate.seniority === 'C-Suite') {
    reasons.push(`experienced ${candidate.title?.toLowerCase() || 'executive'}`)
  }
  
  // Company prestige
  if (candidate.company) {
    reasons.push(`works at ${candidate.company}`)
  }
  
  if (reasons.length > 0) {
    return `${pronoun} ${reasons.slice(0, 2).join(' and ')}`
  }
  
  return `${pronoun} could be a valuable connection`
}

  
  // Company
  if (candidate.company) {
    parts.push(`at ${candidate.company}`)
  }
  
  // Role
  if (candidate.title) {
    parts.push(candidate.title)
  }
  
  const pronoun = candidate.full_name?.toLowerCase().endsWith('a') || 
                  candidate.full_name?.includes('Sarah') || 
                  candidate.full_name?.includes('Priya') ||
                  candidate.full_name?.includes('Alexandra') ? 'She' : 'He'
  
  if (parts.length > 0) {
    return `${pronoun} is ${parts.slice(0, 2).join(', ')}`
  }
  
  return 'Curated match based on your profile'
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
  
  console.log('[generate-recommendations] New user profile:', {
    email: newUserProfile.email,
    role_type: newUserProfile.role_type,
    seniority: newUserProfile.seniority,
    expertise: newUserProfile.expertise,
    intro_preferences: newUserProfile.intro_preferences,
    city: newUserProfile.city,
    state: newUserProfile.state
  })
  
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
  
  console.log('[generate-recommendations] All users count:', allUsers.length)
  console.log('[generate-recommendations] Sample user:', allUsers[0])
  
  // Filter out users without actual profile data
  const usersWithData = allUsers.filter(u => {
    const hasName = !!u.full_name
    const hasRole = !!u.role_type
    console.log('[filter]', u.email, 'name:', hasName, 'role:', hasRole, 'expertise:', u.expertise)
    if (!hasName || !hasRole) return false
    // expertise can be array or null - check if it exists and has items
    if (Array.isArray(u.expertise)) return u.expertise.length > 0
    return true // If expertise exists in any form, include the user
  })
  console.log('[generate-recommendations] Users after filter:', usersWithData.length)
  
  const scoredCandidates = usersWithData
    .map(candidate => ({
      ...candidate,
      relevance_score: scoreMatch(newUserProfile, candidate)
    }))
  console.log('[generate-recommendations] After scoring:', scoredCandidates.length, 'candidates')
  console.log('[generate-recommendations] Sample scores:', scoredCandidates.slice(0, 3).map(c => ({ email: c.email, score: c.relevance_score })))
  
  const filtered = scoredCandidates
    .filter(c => c.relevance_score > 0)
  console.log('[generate-recommendations] After score filter (>0):', filtered.length)
  
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
