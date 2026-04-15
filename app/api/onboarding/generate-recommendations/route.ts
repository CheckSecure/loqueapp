import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

const ONBOARDING_RECOMMENDATIONS_COUNT = 5

function scoreMatch(newUser: any, candidate: any): number {
  let score = 0
  
  // Boost system
  const boostBonus = (candidate.boost_score || 0) * 2
  score += boostBonus
  
  // Priority users
  if (candidate.is_priority) {
    score += 50
  }
  
  // Intro preferences match
  const userPrefs: string[] = Array.isArray(newUser.intro_preferences) ? newUser.intro_preferences : []
  const candidateRole: string = candidate.role_type || ''
  if (userPrefs.some((p: string) => p.toLowerCase() === candidateRole.toLowerCase())) {
    score += 30
  }
  
  // Seniority alignment
  const userSeniority = newUser.seniority || ''
  const candidateSeniority = candidate.seniority || ''
  if (userSeniority === candidateSeniority) {
    score += 20
  }
  
  // Shared expertise
  const userExpertise: string[] = Array.isArray(newUser.expertise) ? newUser.expertise : []
  const candidateExpertise: string[] = Array.isArray(candidate.expertise) ? candidate.expertise : []
  const sharedExpertise = userExpertise.filter(e => candidateExpertise.includes(e))
  score += sharedExpertise.length * 15
  
  // Same city bonus
  if (newUser.city && candidate.city && 
      newUser.city.toLowerCase() === candidate.city.toLowerCase()) {
    score += 25
  }
  
  // Same state bonus (if not same city)
  if (newUser.state && candidate.state && 
      newUser.state.toLowerCase() === candidate.state.toLowerCase() &&
      newUser.city?.toLowerCase() !== candidate.city?.toLowerCase()) {
    score += 10
  }
  
  return score
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await request.json()
    
    if (!userId) {
      return NextResponse.json({ error: 'userId required' }, { status: 400 })
    }
    
    const adminClient = createAdminClient()
    
    // Get the new user's profile
    const { data: newUserProfile, error: profileError } = await adminClient
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()
    
    if (profileError || !newUserProfile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    
    // Get all active users except the new user
    const { data: allUsers, error: usersError } = await adminClient
      .from('profiles')
      .select('*')
      .eq('account_status', 'active')
      .neq('id', userId)
    
    if (usersError || !allUsers) {
      return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 })
    }
    
    // Score all candidates
    const scoredCandidates = allUsers
      .map(candidate => ({
        ...candidate,
        relevance_score: scoreMatch(newUserProfile, candidate)
      }))
      .filter(c => c.relevance_score > 0)
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, ONBOARDING_RECOMMENDATIONS_COUNT)
    
    if (scoredCandidates.length === 0) {
      return NextResponse.json({ 
        message: 'No suitable candidates found',
        count: 0 
      })
    }
    
    // Create intro_requests with status='suggested'
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
      console.error('[generate-recommendations] Insert error:', insertError)
      return NextResponse.json({ error: 'Failed to create recommendations' }, { status: 500 })
    }
    
    return NextResponse.json({ 
      success: true,
      count: scoredCandidates.length,
      message: `Generated ${scoredCandidates.length} onboarding recommendations`
    })
    
  } catch (error: any) {
    console.error('[generate-recommendations] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
