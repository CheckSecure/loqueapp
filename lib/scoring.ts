import { createAdminClient } from '@/lib/supabase/admin'

interface ScoreComponents {
  profileScore: number      // 0-25: profile completeness
  tierBoost: number         // 0-25: subscription tier
  engagementScore: number   // 0-25: activity and engagement
  matchQualityScore: number // 0-25: match outcomes
  total: number             // 0-100
}

async function computeUserScore(userId: string, adminClient: any): Promise<ScoreComponents> {
  // 1. Profile score (0-25)
  const { data: profile } = await adminClient
    .from('profiles')
    .select('full_name, title, company, bio, role_type, avatar_url, intro_preferences, interests, location, subscription_tier')
    .eq('id', userId)
    .single()

  let profileScore = 0
  if (profile) {
    if (profile.full_name) profileScore += 4
    if (profile.title) profileScore += 3
    if (profile.company) profileScore += 3
    if (profile.bio && profile.bio.length > 50) profileScore += 5
    if (profile.role_type) profileScore += 3
    if (profile.avatar_url) profileScore += 3
    if (profile.intro_preferences?.length > 0) profileScore += 2
    if (profile.interests?.length > 0) profileScore += 2
  }

  // 2. Tier boost (0-25)
  const tierBoost: Record<string, number> = {
    executive: 25,
    professional: 15,
    free: 0,
  }
  const tier = profile?.subscription_tier ?? 'free'
  const tierBoostScore = tierBoost[tier] ?? 0

  // 3. Engagement score (0-25)
  let engagementScore = 0

  // Expressions of interest sent
  const { count: interestsSent } = await adminClient
    .from('intro_requests')
    .select('id', { count: 'exact', head: true })
    .eq('requester_id', userId)

  // Passes (shows active engagement)
  const { count: passCount } = await adminClient
    .from('batch_suggestions')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', userId)
    .eq('status', 'passed')

  // Messages sent
  const { count: messagesSent } = await adminClient
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('sender_id', userId)

  const totalActions = (interestsSent ?? 0) + (passCount ?? 0) + (messagesSent ?? 0)
  engagementScore = Math.min(25, totalActions * 2)

  // 4. Match quality score (0-25)
  let matchQualityScore = 0

  // Matches created
  const { count: matchCount } = await adminClient
    .from('matches')
    .select('id', { count: 'exact', head: true })
    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)

  // Meetings scheduled
  const { count: meetingCount } = await adminClient
    .from('meetings')
    .select('id', { count: 'exact', head: true })
    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)

  matchQualityScore = Math.min(25, ((matchCount ?? 0) * 8) + ((meetingCount ?? 0) * 5))

  const total = Math.min(100, profileScore + tierBoostScore + engagementScore + matchQualityScore)

  return {
    profileScore,
    tierBoost: tierBoostScore,
    engagementScore,
    matchQualityScore,
    total,
  }
}

export async function computeAllScores() {
  const adminClient = createAdminClient()

  const { data: profiles } = await adminClient
    .from('profiles')
    .select('id')
    .eq('profile_complete', true)
    .eq('is_active', true)

  if (!profiles || profiles.length === 0) return { updated: 0 }

  let updated = 0
  for (const { id } of profiles) {
    const scores = await computeUserScore(id, adminClient)
    await adminClient.from('user_scores').insert({
      user_id: id,
      score: scores.total,
      tier_boost: scores.tierBoost,
      engagement_score: scores.engagementScore,
      profile_score: scores.profileScore,
      match_quality_score: scores.matchQualityScore,
      computed_at: new Date().toISOString(),
    })
    updated++
  }

  console.log(`[scoring] computed scores for ${updated} users`)
  return { updated }
}

export async function getUserScore(userId: string): Promise<number> {
  const adminClient = createAdminClient()
  const { data } = await adminClient
    .from('user_scores')
    .select('score')
    .eq('user_id', userId)
    .order('computed_at', { ascending: false })
    .limit(1)
    .single()
  return data?.score ?? 50
}
