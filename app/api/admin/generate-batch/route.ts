import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

const TIER_BATCH_SIZES: Record<string, number> = {
  free: 3,
  professional: 5,
  executive: 8,
}

// MINIMUM RELEVANCE THRESHOLD - pairs below this are not considered
const MIN_RELEVANCE_SCORE = 40

// MUTUAL MATCHING THRESHOLD - only top X% of pairs get bidirectional
const MUTUAL_MATCH_PERCENTILE = 0.4 // Top 40% of pairs

// DIVERSITY LIMITS - max % of batch from same role_type
const MAX_SAME_ROLE_PERCENT = 0.4

function scoreMatch(recipient: any, candidate: any): number {
  let score = 0

  // 1. Intro preferences match
  const recipientPrefs: string[] = recipient.intro_preferences || []
  const candidateRole: string = candidate.role_type || ''
  if (recipientPrefs.some((p: string) => p.toLowerCase() === candidateRole.toLowerCase())) {
    score += 30
  }

  // 2. Reverse match
  const candidatePrefs: string[] = candidate.intro_preferences || []
  const recipientRole: string = recipient.role_type || ''
  if (candidatePrefs.some((p: string) => p.toLowerCase() === recipientRole.toLowerCase())) {
    score += 20
  }

  // 3. Interests overlap
  const recipientInterests: string[] = recipient.interests || []
  const candidateInterests: string[] = candidate.interests || []
  const overlap = recipientInterests.filter((i: string) =>
    candidateInterests.some((ci: string) => ci.toLowerCase() === i.toLowerCase())
  ).length
  score += overlap * 10

  // 4. Mentorship compatibility
  const rMentor = recipient.mentorship_role?.toLowerCase()
  const cMentor = candidate.mentorship_role?.toLowerCase()
  if ((rMentor === 'mentor' && cMentor === 'mentee') ||
      (rMentor === 'mentee' && cMentor === 'mentor')) {
    score += 25
  }

  // 5. Tier boost
  const tierBoost: Record<string, number> = { executive: 15, professional: 8, free: 0 }
  score += tierBoost[candidate.subscription_tier] ?? 0

  // 6. Network scores
  if (candidate.networkValueScore) {
    score += Math.round((candidate.networkValueScore / 100) * 15)
  }
  if (candidate.responsivenessScore) {
    score += Math.round((candidate.responsivenessScore / 100) * 5)
  }

  // 7. Seniority diversity
  if (recipient.seniority !== candidate.seniority) {
    score += 5
  }

  return score
}

function generateReason(recipient: any, candidate: any): string {
  const recipientPrefs: string[] = recipient.intro_preferences || []
  const candidateRole: string = candidate.role_type || ''
  const recipientInterests: string[] = recipient.interests || []
  const candidateInterests: string[] = candidate.interests || []

  const sharedInterests = recipientInterests.filter((i: string) =>
    candidateInterests.some((ci: string) => ci.toLowerCase() === i.toLowerCase())
  )

  const rMentor = recipient.mentorship_role?.toLowerCase()
  const cMentor = candidate.mentorship_role?.toLowerCase()

  if (rMentor === 'mentee' && cMentor === 'mentor') {
    return `${candidate.full_name?.split(' ')[0] || 'They'} is an experienced mentor in your field — strong mentorship alignment.`
  }
  if (rMentor === 'mentor' && cMentor === 'mentee') {
    return `${candidate.full_name?.split(' ')[0] || 'They'} is looking for guidance in areas where you have deep expertise.`
  }
  if (sharedInterests.length >= 2) {
    return `You both share a focus on ${sharedInterests.slice(0, 2).join(' and ')} — strong thematic alignment.`
  }
  if (recipientPrefs.some((p: string) => p.toLowerCase() === candidateRole.toLowerCase())) {
    return `${candidate.full_name?.split(' ')[0] || 'They'} matches the type of connection you're looking for — curated based on your preferences.`
  }
  return `Curated based on your professional background and stated goals.`
}

function getUserTierCategory(user: any, profiles: any[]): 'high' | 'mid' | 'low' {
  const totalScore = (user.networkValueScore || 0) + (user.responsivenessScore || 0)
  const sortedByScore = profiles
    .map(p => (p.networkValueScore || 0) + (p.responsivenessScore || 0))
    .sort((a, b) => b - a)
  
  const percentile = sortedByScore.indexOf(totalScore) / sortedByScore.length
  
  if (percentile <= 0.33) return 'high'
  if (percentile <= 0.66) return 'mid'
  return 'low'
}

interface PairScore {
  userA: any
  userB: any
  scoreAtoB: number
  scoreBtoA: number
  mutualScore: number
  relevanceScore: number
  reasonAtoB: string
  reasonBtoA: string
}

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || user.email !== 'bizdev91@gmail.com') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
    }

    const adminClient = createAdminClient()

    const { data: profiles, error: profilesError } = await adminClient
      .from('profiles')
      .select('id, full_name, email, role_type, seniority, mentorship_role, interests, intro_preferences, subscription_tier, looking_for, expertise, networkValueScore, responsivenessScore')
      .eq('profile_complete', true)
      .eq('is_active', true)
      .neq('email', 'bizdev91@gmail.com')

    if (profilesError || !profiles || profiles.length < 2) {
      return NextResponse.json({ error: 'Not enough profiles to match' }, { status: 400 })
    }

    const { data: lastBatch } = await adminClient
      .from('introduction_batches')
      .select('batch_number')
      .order('batch_number', { ascending: false })
      .limit(1)
      .single()

    const nextBatchNumber = (lastBatch?.batch_number ?? 0) + 1

    const now = new Date()
    const monday = new Date(now)
    monday.setDate(now.getDate() - now.getDay() + 1)
    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 6)

    const { data: batch, error: batchError } = await adminClient
      .from('introduction_batches')
      .insert({
        batch_number: nextBatchNumber,
        week_start: monday.toISOString().split('T')[0],
        week_end: sunday.toISOString().split('T')[0],
        status: 'pending_review',
        created_by: user.id,
      })
      .select()
      .single()

    if (batchError || !batch) {
      return NextResponse.json({ error: `Failed to create batch: ${batchError?.message}` }, { status: 500 })
    }

    const ninetyDaysAgo = new Date()
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

    const { data: recentPasses } = await adminClient
      .from('batch_suggestions')
      .select('recipient_id, suggested_id, status')
      .in('status', ['passed', 'hidden_permanent'])
      .gte('created_at', ninetyDaysAgo.toISOString())

    const passMap: Record<string, Set<string>> = {}
    const hiddenMap: Record<string, Set<string>> = {}
    for (const p of recentPasses || []) {
      if (p.status === 'hidden_permanent') {
        if (!hiddenMap[p.recipient_id]) hiddenMap[p.recipient_id] = new Set()
        hiddenMap[p.recipient_id].add(p.suggested_id)
      } else {
        if (!passMap[p.recipient_id]) passMap[p.recipient_id] = new Set()
        passMap[p.recipient_id].add(p.suggested_id)
      }
    }

    const { data: recentBatches } = await adminClient
      .from('introduction_batches')
      .select('id')
      .in('status', ['active', 'completed'])
      .order('created_at', { ascending: false })
      .limit(2)

    const recentBatchIds = (recentBatches || []).map((b: any) => b.id)
    const recentlyShownMap: Record<string, Set<string>> = {}

    if (recentBatchIds.length > 0) {
      const { data: recentSuggestions } = await adminClient
        .from('batch_suggestions')
        .select('recipient_id, suggested_id')
        .in('batch_id', recentBatchIds)

      for (const s of recentSuggestions || []) {
        if (!recentlyShownMap[s.recipient_id]) recentlyShownMap[s.recipient_id] = new Set()
        recentlyShownMap[s.recipient_id].add(s.suggested_id)
      }
    }

    const highTierExposure: Record<string, number> = {}
    const highTierUsers = profiles.filter(p => getUserTierCategory(p, profiles) === 'high')
    for (const u of highTierUsers) {
      highTierExposure[u.id] = 0
    }

    const allPairs: PairScore[] = []
    
    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        const userA = profiles[i]
        const userB = profiles[j]
        
        const aHiddenB = hiddenMap[userA.id]?.has(userB.id) || passMap[userA.id]?.has(userB.id)
        const bHiddenA = hiddenMap[userB.id]?.has(userA.id) || passMap[userB.id]?.has(userA.id)
        const aShownB = recentlyShownMap[userA.id]?.has(userB.id)
        const bShownA = recentlyShownMap[userB.id]?.has(userA.id)
        
        if (aHiddenB || bHiddenA || aShownB || bShownA) continue
        
        const scoreAtoB = scoreMatch(userA, userB)
        const scoreBtoA = scoreMatch(userB, userA)
        const avgScore = (scoreAtoB + scoreBtoA) / 2
        
        if (avgScore < MIN_RELEVANCE_SCORE) continue
        
        allPairs.push({
          userA,
          userB,
          scoreAtoB,
          scoreBtoA,
          mutualScore: scoreAtoB + scoreBtoA,
          relevanceScore: avgScore,
          reasonAtoB: generateReason(userA, userB),
          reasonBtoA: generateReason(userB, userA),
        })
      }
    }
    
    allPairs.sort((a, b) => {
      if (Math.abs(a.relevanceScore - b.relevanceScore) > 10) {
        return b.relevanceScore - a.relevanceScore
      }
      return b.mutualScore - a.mutualScore
    })
    
    const mutualThreshold = allPairs[Math.floor(allPairs.length * MUTUAL_MATCH_PERCENTILE)]?.mutualScore || 0
    const bidirectionalPairs = allPairs.filter(p => p.mutualScore >= mutualThreshold)
    const onewayPairs = allPairs.filter(p => p.mutualScore < mutualThreshold)
    
    const userBatches: Record<string, any[]> = {}
    const userBatchSizes: Record<string, number> = {}
    const userRoleCounts: Record<string, Record<string, number>> = {}
    
    for (const profile of profiles) {
      userBatches[profile.id] = []
      userBatchSizes[profile.id] = TIER_BATCH_SIZES[profile.subscription_tier ?? 'free'] ?? 3
      userRoleCounts[profile.id] = {}
    }
    
    const assignedPairs = new Set<string>()
    let mutualMatchesCreated = 0
    
    for (const pair of bidirectionalPairs) {
      const { userA, userB, scoreAtoB, scoreBtoA, reasonAtoB, reasonBtoA } = pair
      
      const pairKey = [userA.id, userB.id].sort().join('-')
      if (assignedPairs.has(pairKey)) continue
      
      const aHasSpace = userBatches[userA.id].length < userBatchSizes[userA.id]
      const bHasSpace = userBatches[userB.id].length < userBatchSizes[userB.id]
      
      const aRoleB = userB.role_type || 'unknown'
      const bRoleA = userA.role_type || 'unknown'
      const aRoleCount = userRoleCounts[userA.id][aRoleB] || 0
      const bRoleCount = userRoleCounts[userB.id][bRoleA] || 0
      const aMaxPerRole = Math.ceil(userBatchSizes[userA.id] * MAX_SAME_ROLE_PERCENT)
      const bMaxPerRole = Math.ceil(userBatchSizes[userB.id] * MAX_SAME_ROLE_PERCENT)
      
      const bIsHighTier = highTierExposure.hasOwnProperty(userB.id)
      const aIsHighTier = highTierExposure.hasOwnProperty(userA.id)
      const bOverExposed = bIsHighTier && highTierExposure[userB.id] >= 8
      const aOverExposed = aIsHighTier && highTierExposure[userA.id] >= 8
      
      const canAddBoth = aHasSpace && bHasSpace && 
                         aRoleCount < aMaxPerRole && bRoleCount < bMaxPerRole &&
                         !bOverExposed && !aOverExposed
      
      if (canAddBoth) {
        userBatches[userA.id].push({ suggested: userB, score: scoreAtoB, reason: reasonAtoB })
        userBatches[userB.id].push({ suggested: userA, score: scoreBtoA, reason: reasonBtoA })
        
        userRoleCounts[userA.id][aRoleB] = aRoleCount + 1
        userRoleCounts[userB.id][bRoleA] = bRoleCount + 1
        
        if (bIsHighTier) highTierExposure[userB.id]++
        if (aIsHighTier) highTierExposure[userA.id]++
        
        assignedPairs.add(pairKey)
        mutualMatchesCreated++
      }
    }
    
    const allCandidatePairs = [...onewayPairs, ...bidirectionalPairs]
    
    for (const recipient of profiles) {
      const currentSize = userBatches[recipient.id].length
      const targetSize = userBatchSizes[recipient.id]
      const spotsLeft = targetSize - currentSize
      
      if (spotsLeft <= 0) continue
      
      const alreadyAssigned = new Set(userBatches[recipient.id].map(s => s.suggested.id))
      
      const candidates = allCandidatePairs
        .filter(p => {
          const isA = p.userA.id === recipient.id
          const isB = p.userB.id === recipient.id
          if (!isA && !isB) return false
          
          const suggested = isA ? p.userB : p.userA
          if (alreadyAssigned.has(suggested.id)) return false
          
          const roleCount = userRoleCounts[recipient.id][suggested.role_type || 'unknown'] || 0
          const maxPerRole = Math.ceil(targetSize * MAX_SAME_ROLE_PERCENT)
          if (roleCount >= maxPerRole) return false
          
          const isHighTier = highTierExposure.hasOwnProperty(suggested.id)
          if (isHighTier && highTierExposure[suggested.id] >= 8) return false
          
          return true
        })
        .map(p => {
          const isA = p.userA.id === recipient.id
          return {
            suggested: isA ? p.userB : p.userA,
            score: isA ? p.scoreAtoB : p.scoreBtoA,
            reason: isA ? p.reasonAtoB : p.reasonBtoA,
          }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, spotsLeft)
      
      for (const candidate of candidates) {
        userBatches[recipient.id].push(candidate)
        const roleType = candidate.suggested.role_type || 'unknown'
        userRoleCounts[recipient.id][roleType] = (userRoleCounts[recipient.id][roleType] || 0) + 1
        
        if (highTierExposure.hasOwnProperty(candidate.suggested.id)) {
          highTierExposure[candidate.suggested.id]++
        }
      }
    }
    
    const allSuggestions: any[] = []
    
    for (const [recipientId, suggestions] of Object.entries(userBatches)) {
      for (let i = 0; i < suggestions.length; i++) {
        const { suggested, score, reason } = suggestions[i]
        allSuggestions.push({
          batch_id: batch.id,
          recipient_id: recipientId,
          suggested_id: suggested.id,
          reason,
          match_score: score,
          position: i + 1,
          status: 'active',
        })
      }
    }

    if (allSuggestions.length > 0) {
      const { error: suggestionsError } = await adminClient
        .from('batch_suggestions')
        .insert(allSuggestions)

      if (suggestionsError) {
        return NextResponse.json({ error: `Failed to insert suggestions: ${suggestionsError.message}` }, { status: 500 })
      }
    }
    
    const oneWayMatches = allSuggestions.length - (mutualMatchesCreated * 2)
    const avgBatchSize = allSuggestions.length / profiles.length

    return NextResponse.json({
      success: true,
      batchId: batch.id,
      batchNumber: nextBatchNumber,
      totalSuggestions: allSuggestions.length,
      usersMatched: profiles.length,
      mutualOpportunities: mutualMatchesCreated,
      oneWayMatches,
      avgBatchSize: Math.round(avgBatchSize * 10) / 10,
      qualityMetrics: {
        relevanceThreshold: MIN_RELEVANCE_SCORE,
        mutualMatchPercentile: MUTUAL_MATCH_PERCENTILE,
        pairsConsidered: allPairs.length,
        pairsQualified: bidirectionalPairs.length,
      }
    })
  } catch (err: any) {
    console.error('[generate-batch] error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
