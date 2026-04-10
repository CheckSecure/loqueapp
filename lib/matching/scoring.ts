// Andrel Matching Scoring System
// Layer 1: Alignment (55%)
// Layer 2: Network Value (30%)
// Layer 3: Responsiveness (15%)

interface Profile {
  id: string
  purposes?: string[]
  intro_preferences?: string[]
  interests?: string[]
  role_type?: string
  seniority?: string
  location?: string
  company?: string
  current_status?: string
  subscription_tier?: string
  profile_complete?: boolean
  trust_score?: number
}

interface UserActivity {
  interests_expressed: number
  responses_sent: number
  response_rate: number
  meetings_scheduled: number
  meetings_completed: number
  last_active_days_ago: number
}

// Company tier classification
function getCompanyTier(company: string | undefined): number {
  if (!company) return 0
  
  const tier1 = ['Google', 'Apple', 'Microsoft', 'Amazon', 'Meta', 'Tesla', 'Netflix', 
                 'Goldman Sachs', 'Morgan Stanley', 'JPMorgan', 'Blackstone', 'KKR',
                 'Skadden', 'Cravath', 'Sullivan & Cromwell', 'Wachtell']
  const tier2 = ['Stripe', 'Airbnb', 'Uber', 'Coinbase', 'Robinhood']
  
  const companyLower = company.toLowerCase()
  
  if (tier1.some(t => companyLower.includes(t.toLowerCase()))) return 15
  if (tier2.some(t => companyLower.includes(t.toLowerCase()))) return 10
  return 5
}

// Seniority scoring
function getSeniorityScore(seniority: string | undefined): number {
  const scores: Record<string, number> = {
    'C-Suite': 30,
    'Executive': 25,
    'Senior': 20,
    'Mid-level': 15,
    'Junior': 10
  }
  return scores[seniority || ''] || 15
}

// Current status scoring (5% weight in Network Value)
function getCurrentStatusScore(status: string | undefined): number {
  const scores: Record<string, number> = {
    'employed': 5,
    'consulting_advisory': 4,
    'between_roles': 3
  }
  return scores[status || 'employed'] || 5
}

// Tier scoring
function getTierScore(tier: string | undefined): number {
  const scores: Record<string, number> = {
    'executive': 20,
    'professional': 15,
    'free': 10
  }
  return scores[tier || 'free'] || 10
}

// Calculate alignment score (55% of total)
export function calculateAlignmentScore(userA: Profile, userB: Profile): number {
  let score = 0
  
  // Goals overlap (25%)
  const userAPurposes = userA.purposes || []
  const userBPurposes = userB.purposes || []
  const purposeOverlap = userAPurposes.filter(p => userBPurposes.includes(p)).length
  const maxPurposeOverlap = Math.max(userAPurposes.length, userBPurposes.length)
  score += maxPurposeOverlap > 0 ? (purposeOverlap / maxPurposeOverlap) * 25 : 0
  
  // Role relevance (20%)
  const userAPrefs = userA.intro_preferences || []
  const userBRole = userB.role_type || ''
  const roleMatch = userAPrefs.some(pref => userBRole.toLowerCase().includes(pref.toLowerCase()))
  score += roleMatch ? 20 : 0
  
  // Industry (15%) - simplified for now
  score += 10
  
  // Seniority compatibility (10%)
  if (userA.seniority && userB.seniority) {
    const seniorityMatch = userA.seniority === userB.seniority
    score += seniorityMatch ? 10 : 5
  }
  
  // Location fit (10%)
  if (userA.location && userB.location) {
    const locationMatch = userA.location === userB.location
    score += locationMatch ? 10 : 3
  }
  
  // Shared interests (10%)
  const userAInterests = userA.interests || []
  const userBInterests = userB.interests || []
  const interestOverlap = userAInterests.filter(i => userBInterests.includes(i)).length
  const maxInterestOverlap = Math.max(userAInterests.length, userBInterests.length)
  score += maxInterestOverlap > 0 ? (interestOverlap / maxInterestOverlap) * 10 : 0
  
  // Mentorship alignment (10%) - simplified
  score += 5
  
  return Math.min(score, 55) // Cap at 55
}

// Calculate network value score (30% of total)
export function calculateNetworkValueScore(profile: Profile): number {
  let score = 0
  
  // Seniority (30% of 30 = 9 points max)
  score += (getSeniorityScore(profile.seniority) / 30) * 9
  
  // Subscription tier (20% of 30 = 6 points max)
  score += (getTierScore(profile.subscription_tier) / 20) * 6
  
  // Company signal (15% of 30 = 4.5 points max)
  score += (getCompanyTier(profile.company) / 15) * 4.5
  
  // Role quality (10% of 30 = 3 points max)
  score += profile.role_type ? 3 : 1
  
  // Profile completeness (10% of 30 = 3 points max)
  score += profile.profile_complete ? 3 : 1
  
  // Current status (5% of 30 = 1.5 points max)
  score += (getCurrentStatusScore(profile.current_status) / 5) * 1.5
  
  // Meeting outcomes (10% of 30 = 3 points max) - placeholder
  score += 1.5
  
  return Math.min(score, 30) // Cap at 30
}

// Calculate responsiveness score (15% of total)
export function calculateResponsivenessScore(activity: UserActivity): number {
  let score = 0
  
  // Activity recency (20% of 15 = 3 points max)
  if (activity.last_active_days_ago <= 1) score += 3
  else if (activity.last_active_days_ago <= 7) score += 2
  else if (activity.last_active_days_ago <= 30) score += 1
  
  // Interest actions (10% of 15 = 1.5 points max)
  score += Math.min(activity.interests_expressed * 0.3, 1.5)
  
  // Response rate (25% of 15 = 3.75 points max)
  score += activity.response_rate * 3.75
  
  // Messages (15% of 15 = 2.25 points max)
  score += Math.min(activity.responses_sent * 0.1, 2.25)
  
  // Meetings scheduled (15% of 15 = 2.25 points max)
  score += Math.min(activity.meetings_scheduled * 0.5, 2.25)
  
  // Meetings completed (15% of 15 = 2.25 points max)
  score += Math.min(activity.meetings_completed * 0.75, 2.25)
  
  return Math.min(score, 15) // Cap at 15
}

// Calculate final score
export function calculateFinalScore(
  userA: Profile,
  userB: Profile,
  activityB: UserActivity
): {
  alignment: number
  networkValue: number
  responsiveness: number
  final: number
  bucket: 'high_score' | 'mid_score' | 'low_score'
} {
  const alignment = calculateAlignmentScore(userA, userB)
  const networkValue = calculateNetworkValueScore(userB)
  const responsiveness = calculateResponsivenessScore(activityB)
  const final = alignment + networkValue + responsiveness
  
  // Score bucketing
  let bucket: 'high_score' | 'mid_score' | 'low_score'
  if (final >= 70) bucket = 'high_score'
  else if (final >= 50) bucket = 'mid_score'
  else bucket = 'low_score'
  
  return { alignment, networkValue, responsiveness, final, bucket }
}
