import { createAdminClient } from '@/lib/supabase/admin'

// ─────────────────────────────────────────────
// COMPANY TIER CLASSIFICATION
// ─────────────────────────────────────────────
const TIER_1_KEYWORDS = [
  'google','microsoft','apple','amazon','meta','openai','anthropic','mckinsey',
  'blackrock','goldman','jp morgan','jpmorgan','morgan stanley','sequoia','andreessen',
  'a16z','kkr','carlyle','bain','bcg','deloitte','pwc','kpmg','ey','skadden',
  'kirkland','latham','sullivan','cravath','weil','harvard','mit','stanford',
  'yale','princeton','spacex','tesla','nvidia','palantir','stripe','airbnb',
  'uber','lyft','doordash','coinbase','databricks','snowflake','salesforce',
]

const TIER_2_KEYWORDS = [
  'law firm','capital','ventures','partners','group','consulting','health',
  'hospital','university','college','institute','foundation','federal','state',
  'national','international','global','fund','asset','management','advisory',
]

function classifyCompany(company: string): number {
  if (!company) return 0
  const lower = company.toLowerCase()
  if (TIER_1_KEYWORDS.some(k => lower.includes(k))) return 100
  if (TIER_2_KEYWORDS.some(k => lower.includes(k))) return 60
  return 30
}

// ─────────────────────────────────────────────
// SENIORITY CLASSIFICATION
// ─────────────────────────────────────────────
const SENIORITY_SCORES: Record<string, number> = {
  'Executive / C-Suite': 100,
  'Executive': 100,
  'C-Suite': 100,
  'VP / SVP': 85,
  'VP': 85,
  'SVP': 85,
  'Director': 70,
  'Senior': 55,
  'Mid-level': 40,
  'Early Career': 25,
  'Student': 10,
}

function scoreSeniority(seniority: string): number {
  return SENIORITY_SCORES[seniority] ?? 35
}

// ─────────────────────────────────────────────
// TIER SCORES
// ─────────────────────────────────────────────
const TIER_SCORES: Record<string, number> = {
  executive: 100,
  professional: 65,
  free: 20,
}

// ─────────────────────────────────────────────
// ADMIN PRIORITY MODIFIER
// ─────────────────────────────────────────────
const PRIORITY_MODIFIER: Record<string, number> = {
  high_priority: 15,
  standard: 0,
  low_priority: -15,
}

// ─────────────────────────────────────────────
// NETWORK VALUE SCORE (0–100)
// Seniority: 35%, Tier: 25%, Role: 15%, Company: 15%, Profile: 10%
// Admin priority: modifier applied after
// ─────────────────────────────────────────────
function computeNetworkValueScore(profile: any): { score: number; components: Record<string, number> } {
  const seniorityRaw = scoreSeniority(profile.seniority ?? '')
  const tierRaw = TIER_SCORES[profile.subscription_tier ?? 'free'] ?? 20
  const companyRaw = classifyCompany(profile.company ?? '')

  // Role quality — based on role_type
  const roleScores: Record<string, number> = {
    'Executive / C-Suite': 100,
    'Investor': 90,
    'Founder / Entrepreneur': 85,
    'Law firm attorney': 80,
    'In-house attorney': 75,
    'Legal services professional': 70,
    'Consultant': 65,
    'Other': 40,
  }
  const roleRaw = roleScores[profile.role_type ?? ''] ?? 40

  // Profile completeness
  let completeness = 0
  if (profile.full_name) completeness += 20
  if (profile.title) completeness += 15
  if (profile.company) completeness += 15
  if (profile.bio && profile.bio.length > 50) completeness += 25
  if (profile.avatar_url) completeness += 15
  if (profile.interests?.length > 0) completeness += 10

  const seniority = seniorityRaw * 0.35
  const tier = tierRaw * 0.25
  const role = roleRaw * 0.15
  const company = companyRaw * 0.15
  const profileComp = completeness * 0.10

  const base = seniority + tier + role + company + profileComp
  const priority = PRIORITY_MODIFIER[profile.admin_priority ?? 'standard'] ?? 0
  const score = Math.min(100, Math.max(0, base + priority))

  return {
    score: Math.round(score * 10) / 10,
    components: {
      seniority: Math.round(seniority * 10) / 10,
      tier: Math.round(tier * 10) / 10,
      role: Math.round(role * 10) / 10,
      company: Math.round(company * 10) / 10,
      profile_completeness: Math.round(profileComp * 10) / 10,
      admin_priority_modifier: priority,
    },
  }
}

// ─────────────────────────────────────────────
// RESPONSIVENESS SCORE (0–100)
// Recent activity: 20%, Interest rate: 15%, Response rate: 25%,
// Meetings scheduled: 20%, Meetings completed: 20%
// ─────────────────────────────────────────────
async function computeResponsivenessScore(
  userId: string,
  adminClient: any
): Promise<{ score: number; components: Record<string, number> }> {

  // Recent activity — actions in last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { count: recentInterests } = await adminClient
    .from('intro_requests')
    .select('id', { count: 'exact', head: true })
    .eq('requester_id', userId)
    .gte('created_at', thirtyDaysAgo)

  const { count: recentMessages } = await adminClient
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('sender_id', userId)
    .gte('created_at', thirtyDaysAgo)

  const recentActivityRaw = Math.min(100, ((recentInterests ?? 0) + (recentMessages ?? 0)) * 20)

  // Total expressions of interest
  const { count: totalInterests } = await adminClient
    .from('intro_requests')
    .select('id', { count: 'exact', head: true })
    .eq('requester_id', userId)

  const interestRaw = Math.min(100, (totalInterests ?? 0) * 15)

  // Response rate — messages sent vs matches created
  const { count: matchCount } = await adminClient
    .from('matches')
    .select('id', { count: 'exact', head: true })
    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)

  const { count: messageCount } = await adminClient
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('sender_id', userId)

  const responseRaw = matchCount && matchCount > 0
    ? Math.min(100, ((messageCount ?? 0) / matchCount) * 50)
    : 0

  // Meetings scheduled
  const { count: meetingsScheduled } = await adminClient
    .from('meetings')
    .select('id', { count: 'exact', head: true })
    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)

  const meetingsScheduledRaw = Math.min(100, (meetingsScheduled ?? 0) * 25)

  // Meetings completed
  const { count: meetingsCompleted } = await adminClient
    .from('meetings')
    .select('id', { count: 'exact', head: true })
    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)
    .eq('completed', true)

  const meetingsCompletedRaw = Math.min(100, (meetingsCompleted ?? 0) * 33)

  const recentActivity = recentActivityRaw * 0.20
  const interests = interestRaw * 0.15
  const responseRate = responseRaw * 0.25
  const scheduled = meetingsScheduledRaw * 0.20
  const completed = meetingsCompletedRaw * 0.20

  const score = Math.min(100, recentActivity + interests + responseRate + scheduled + completed)

  return {
    score: Math.round(score * 10) / 10,
    components: {
      recent_activity: Math.round(recentActivity * 10) / 10,
      interests: Math.round(interests * 10) / 10,
      response_rate: Math.round(responseRate * 10) / 10,
      meetings_scheduled: Math.round(scheduled * 10) / 10,
      meetings_completed: Math.round(completed * 10) / 10,
    },
  }
}

// ─────────────────────────────────────────────
// FINAL RANK SCORE
// Alignment handled at match time — this is the pre-match boost
// Network Value: 60%, Responsiveness: 40%
// ─────────────────────────────────────────────
function computeFinalRankScore(networkValue: number, responsiveness: number): number {
  return Math.round((networkValue * 0.60 + responsiveness * 0.40) * 10) / 10
}

// ─────────────────────────────────────────────
// COMPUTE ALL SCORES
// ─────────────────────────────────────────────
export async function computeAllScores() {
  const adminClient = createAdminClient()

  const { data: profiles } = await adminClient
    .from('profiles')
    .select('id, full_name, title, company, bio, role_type, avatar_url, interests, seniority, subscription_tier, admin_priority, profile_complete, is_active')
    .eq('profile_complete', true)
    .eq('is_active', true)

  if (!profiles || profiles.length === 0) return { updated: 0 }

  let updated = 0
  for (const profile of profiles) {
    const { score: networkValueScore, components: nvComponents } = computeNetworkValueScore(profile)
    const { score: responsivenessScore, components: rComponents } = await computeResponsivenessScore(profile.id, adminClient)
    const finalRankScore = computeFinalRankScore(networkValueScore, responsivenessScore)

    await adminClient.from('user_scores').insert({
      user_id: profile.id,
      score: finalRankScore,
      network_value_score: networkValueScore,
      responsiveness_score: responsivenessScore,
      final_rank_score: finalRankScore,
      tier_boost: TIER_SCORES[profile.subscription_tier ?? 'free'] ?? 20,
      engagement_score: rComponents.recent_activity + rComponents.interests,
      profile_score: nvComponents.profile_completeness,
      match_quality_score: rComponents.meetings_scheduled + rComponents.meetings_completed,
      score_components: {
        network_value: nvComponents,
        responsiveness: rComponents,
      },
      computed_at: new Date().toISOString(),
    })
    updated++
  }

  console.log(`[scoring] computed scores for ${updated} users`)
  return { updated }
}

// ─────────────────────────────────────────────
// GET LATEST USER SCORE
// ─────────────────────────────────────────────
export async function getUserScore(userId: string): Promise<{
  finalRankScore: number
  networkValueScore: number
  responsivenessScore: number
}> {
  const adminClient = createAdminClient()
  const { data } = await adminClient
    .from('user_scores')
    .select('final_rank_score, network_value_score, responsiveness_score')
    .eq('user_id', userId)
    .order('computed_at', { ascending: false })
    .limit(1)
    .single()

  return {
    finalRankScore: data?.final_rank_score ?? 50,
    networkValueScore: data?.network_value_score ?? 50,
    responsivenessScore: data?.responsiveness_score ?? 50,
  }
}
