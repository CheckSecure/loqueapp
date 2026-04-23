// Inspects the full relationship between two users: identity, relationship state, eligibility, insights.
// Used by /api/admin/inspect-pair and the match-inspector page.
import { createAdminClient } from '@/lib/supabase/admin'
import { generateMatchInsights, type MatchInsight } from '@/lib/matching/matchInsights'
import { buildBidirectionalMatchFilter, buildBidirectionalIntroRequestFilter } from '@/lib/db/filters'

export interface IdentityCard {
  id: string
  email: string | null
  full_name: string | null
  title: string | null
  company: string | null
  seniority: string | null
  subscription_tier: string | null
  profile_complete: boolean
  role_type: string | null
  bio: string | null
  city: string | null
  state: string | null
  location: string | null
  purposes: string[] | null
  intro_preferences: string[] | null
  interests: string[] | null
  expertise: string[] | null
  open_to_mentorship: boolean | null
  open_to_business_solutions: boolean | null
}

export interface RelationshipState {
  matchId: string | null
  matchStatus: string | null
  matchRemovedAt: string | null
  matchRemovedBy: string | null
  conversationId: string | null
  blockByA: boolean
  blockByB: boolean
  blockAt: string | null
  introRequestsCount: number
  pendingIntroRequests: number
  adminFacilitated: boolean
}

export interface EligibilityCheck {
  name: string
  pass: boolean
  explanation: string
}

export interface InspectionResult {
  userA: IdentityCard | null
  userB: IdentityCard | null
  notFound: { a: boolean; b: boolean }
  relationship: RelationshipState
  eligibility: EligibilityCheck[]
  insights: MatchInsight[]
  canBeRecommendedAtoB: boolean
  canBeRecommendedBtoA: boolean
  primaryFailureReason: string | null
  recommendedAction: 'unblock' | 'restore' | 'create' | 'createconv' | null
}

// Resolve an input (email or UUID) to a user ID
async function resolveUserId(input: string): Promise<IdentityCard | null> {
  const admin = createAdminClient()
  const trimmed = (input || '').trim()
  if (!trimmed) return null

  // UUID-ish: 36 chars with dashes
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
  const selectCols = 'id, email, full_name, title, company, seniority, subscription_tier, role_type, bio, city, state, location, purposes, intro_preferences, interests, expertise, onboarding_complete, open_to_mentorship, open_to_business_solutions'

  let { data, error: lookupErr } = isUuid
    ? await admin.from('profiles').select(selectCols).eq('id', trimmed).maybeSingle()
    : await admin.from('profiles').select(selectCols).ilike('email', trimmed).maybeSingle()

  if (lookupErr) {
    console.error('[resolveUserId] primary lookup error:', lookupErr)
  }

  // Fallback: if email lookup missed, try auth.users.email -> id lookup
  if (!data && !isUuid) {
    const { data: authLookup } = await admin.auth.admin.listUsers()
    const authMatch = authLookup?.users?.find(u => u.email?.toLowerCase() === trimmed.toLowerCase())
    if (authMatch) {
      const retry = await admin
        .from('profiles')
        .select('id, email, full_name, title, company, seniority, subscription_tier, role_type, bio, city, state, location, purposes, intro_preferences, interests, expertise, open_to_mentorship, open_to_business_solutions, onboarding_complete')
        .eq('id', authMatch.id)
        .maybeSingle()
      data = retry.data as any
    }
  }

  if (!data) return null

  return {
    id: data.id,
    email: data.email,
    full_name: data.full_name,
    title: data.title,
    company: data.company,
    seniority: data.seniority,
    subscription_tier: data.subscription_tier,
    profile_complete: Boolean(data.onboarding_complete),
    role_type: data.role_type,
    bio: data.bio,
    city: data.city,
    state: data.state,
    location: data.location,
    purposes: data.purposes,
    intro_preferences: data.intro_preferences,
    interests: data.interests,
    expertise: data.expertise,
    open_to_mentorship: data.open_to_mentorship,
    open_to_business_solutions: data.open_to_business_solutions
  }
}

const REMOVAL_COOLDOWN_MS = 180 * 24 * 60 * 60 * 1000

export async function inspectPair(inputA: string, inputB: string): Promise<InspectionResult> {
  const admin = createAdminClient()

  const [userA, userB] = await Promise.all([resolveUserId(inputA), resolveUserId(inputB)])
  const notFound = { a: !userA, b: !userB }

  const empty: InspectionResult = {
    userA,
    userB,
    notFound,
    relationship: {
      matchId: null,
      matchStatus: null,
      matchRemovedAt: null,
      matchRemovedBy: null,
      conversationId: null,
      blockByA: false,
      blockByB: false,
      blockAt: null,
      introRequestsCount: 0,
      pendingIntroRequests: 0,
      adminFacilitated: false
    },
    eligibility: [],
    insights: [],
    canBeRecommendedAtoB: false,
    canBeRecommendedBtoA: false,
    primaryFailureReason: null,
    recommendedAction: null
  }

  if (!userA || !userB) return empty

  if (userA.id === userB.id) {
    empty.userA = userA
    empty.userB = userB
    empty.eligibility = [{ name: 'Same user check', pass: false, explanation: 'Both inputs resolved to the same user' }]
    return empty
  }

  // Match row
  const matchFilter = buildBidirectionalMatchFilter(userA.id, userB.id)
  console.log('[MatchInspector] Using filter:', matchFilter) // TODO: remove debug logging after stability confirmed
  const { data: matchRows } = await admin
    .from('matches')
    .select('id, status, removed_at, removed_by, admin_facilitated, user_a_id, user_b_id')
    .or(matchFilter)
    .order('matched_at', { ascending: false })
    .limit(1)

  const match = matchRows && matchRows.length > 0 ? matchRows[0] : null

  // Conversation (if match exists)
  let conversationId: string | null = null
  if (match) {
    const { data: conv } = await admin
      .from('conversations')
      .select('id')
      .eq('match_id', match.id)
      .maybeSingle()
    conversationId = conv?.id || null
  }

  // Blocks (both directions)
  const { data: blockAtoB } = await admin
    .from('blocked_users')
    .select('created_at')
    .eq('user_id', userA.id)
    .eq('blocked_user_id', userB.id)
    .maybeSingle()
  const { data: blockBtoA } = await admin
    .from('blocked_users')
    .select('created_at')
    .eq('user_id', userB.id)
    .eq('blocked_user_id', userA.id)
    .maybeSingle()

  const blockByA = !!blockAtoB
  const blockByB = !!blockBtoA
  const blockAt = blockAtoB?.created_at || blockBtoA?.created_at || null

  // Intro requests between the two
  const { data: introReqs } = await admin
    .from('intro_requests')
    .select('id, status, created_at')
    .or(buildBidirectionalIntroRequestFilter(userA.id, userB.id))

  const allIntros = introReqs || []
  const pendingCount = allIntros.filter(i => i.status === 'pending' || i.status === 'suggested' || i.status === 'admin_pending').length

  const relationship: RelationshipState = {
    matchId: match?.id || null,
    matchStatus: match?.status || null,
    matchRemovedAt: match?.removed_at || null,
    matchRemovedBy: match?.removed_by || null,
    conversationId,
    blockByA,
    blockByB,
    blockAt,
    introRequestsCount: allIntros.length,
    pendingIntroRequests: pendingCount,
    adminFacilitated: Boolean(match?.admin_facilitated)
  }

  // Eligibility checklist
  const eligibility: EligibilityCheck[] = []

  // 1. Blocked check
  const anyBlock = blockByA || blockByB
  if (anyBlock) {
    const who = blockByA && blockByB ? 'both users have blocked each other'
      : blockByA ? (userA.full_name || 'User A') + ' has blocked ' + (userB.full_name || 'User B')
      : (userB.full_name || 'User B') + ' has blocked ' + (userA.full_name || 'User A')
    eligibility.push({ name: 'Block check', pass: false, explanation: 'FAIL — ' + who + (blockAt ? ' (' + new Date(blockAt).toLocaleDateString() + ')' : '') })
  } else {
    eligibility.push({ name: 'Block check', pass: true, explanation: 'PASS — no blocks in either direction' })
  }

  // 2. Removal cooldown
  if (match && match.status === 'removed' && match.removed_at) {
    const removedMs = new Date(match.removed_at).getTime()
    const elapsed = Date.now() - removedMs
    if (elapsed < REMOVAL_COOLDOWN_MS) {
      const daysLeft = Math.ceil((REMOVAL_COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000))
      eligibility.push({ name: 'Removal cooldown', pass: false, explanation: 'FAIL — in cooldown, ' + daysLeft + ' days remaining' })
    } else {
      eligibility.push({ name: 'Removal cooldown', pass: true, explanation: 'PASS — cooldown expired, eligible to resurface' })
    }
  } else {
    eligibility.push({ name: 'Removal cooldown', pass: true, explanation: 'PASS — no prior removal' })
  }

  // 3. Already matched
  if (match && match.status !== 'removed') {
    eligibility.push({ name: 'Already matched', pass: false, explanation: 'FAIL — ' + match.status + ' match already exists' + (match.admin_facilitated ? ' (admin-facilitated)' : '') })
  } else {
    eligibility.push({ name: 'Already matched', pass: true, explanation: 'PASS — no active match' })
  }

  // 4. Same user
  eligibility.push({ name: 'Same user check', pass: true, explanation: 'PASS — distinct users' })

  // 5. Profile completeness (both required)
  if (!userA.profile_complete || !userB.profile_complete) {
    const who = !userA.profile_complete && !userB.profile_complete ? 'neither'
      : !userA.profile_complete ? (userA.full_name || 'User A')
      : (userB.full_name || 'User B')
    eligibility.push({ name: 'Profile completeness', pass: false, explanation: 'FAIL — ' + who + ' has not completed onboarding' })
  } else {
    eligibility.push({ name: 'Profile completeness', pass: true, explanation: 'PASS — both users have completed onboarding' })
  }

  // 6. Active intro requests between them (excludes matching, interpreted as indicator that they're already in motion)
  if (pendingCount > 0) {
    eligibility.push({ name: 'Pending intro requests', pass: false, explanation: 'FAIL — ' + pendingCount + ' pending intro request(s) between them' })
  } else {
    eligibility.push({ name: 'Pending intro requests', pass: true, explanation: 'PASS — no pending intro requests' })
  }

  // Compute can-be-recommended (AND of all pass flags except the directional ones)
  const allPass = eligibility.every(e => e.pass)
  const canAtoB = allPass
  const canBtoA = allPass

  // Generate match insights for human-readable explanation
  const insights = generateMatchInsights(userA as any, userB as any)

  // Compute primary failure reason (first matching fail in priority order)
  let primaryFailureReason: string | null = null
  if (!allPass) {
    const priorities: Array<{ name: string; label: (check: EligibilityCheck) => string }> = [
      { name: 'Block check', label: (c) => {
          if (blockByA && blockByB) return (userA.full_name || 'User A') + ' and ' + (userB.full_name || 'User B') + ' have blocked each other'
          if (blockByA) return (userA.full_name || 'User A') + ' blocked ' + (userB.full_name || 'User B')
          return (userB.full_name || 'User B') + ' blocked ' + (userA.full_name || 'User A')
      } },
      { name: 'Already matched', label: () => 'Active match already exists' },
      { name: 'Removal cooldown', label: () => 'Removal cooldown is still active' },
      { name: 'Same user check', label: () => 'Both inputs are the same user' },
      { name: 'Profile completeness', label: () => 'One or both profiles have not completed onboarding' },
      { name: 'Pending intro requests', label: () => 'Pending intro requests exist between them' }
    ]
    for (const p of priorities) {
      const check = eligibility.find(e => e.name === p.name && !e.pass)
      if (check) {
        primaryFailureReason = p.label(check)
        break
      }
    }
    // Fallback from priority list
    if (!primaryFailureReason) {
      const anyFail = eligibility.find(e => !e.pass)
      if (anyFail) primaryFailureReason = anyFail.name + ': ' + anyFail.explanation.replace(/^FAIL\s*[—-]\s*/i, '')
    }
  }

  // Defensive: never leave the UI with a blank explanation for an ineligible pair
  if (!primaryFailureReason && !allPass) {
    primaryFailureReason = 'Does not meet current matching criteria'
  }

  // Compute recommended action based on current relationship state
  let recommendedAction: 'unblock' | 'restore' | 'create' | 'createconv' | null = null
  if (blockByA || blockByB) {
    recommendedAction = 'unblock'
  } else if (match && match.status === 'removed') {
    recommendedAction = 'restore'
  } else if (match && match.status !== 'removed' && !conversationId) {
    recommendedAction = 'createconv'
  } else if (!match && allPass) {
    recommendedAction = 'create'
  }

  return {
    userA,
    userB,
    notFound,
    relationship,
    eligibility,
    insights,
    canBeRecommendedAtoB: canAtoB,
    canBeRecommendedBtoA: canBtoA,
    primaryFailureReason,
    recommendedAction
  }
}
