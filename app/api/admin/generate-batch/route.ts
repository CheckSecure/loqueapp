import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { parseExpertise } from '@/lib/parseExpertise'
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

function isCompatiblePair(userA: any, userB: any): boolean {
  // 1. Geographic compatibility
  const aScope = userA.geographic_scope || 'us-wide'
  const bScope = userB.geographic_scope || 'us-wide'
  const aCity = userA.city?.toLowerCase().trim()
  const bCity = userB.city?.toLowerCase().trim()
  const aState = userA.state?.toLowerCase().trim()
  const bState = userB.state?.toLowerCase().trim()
  
  // If BOTH want local only, they must be in same city/state
  if (aScope === 'local' && bScope === 'local') {
    const sameCity = aCity && bCity && aCity === bCity
    const sameState = aState && bState && aState === bState
    if (!sameCity && !sameState) return false
  }
  
  // If ONE wants local only, check if other is in same area
  if (aScope === 'local' && bScope === 'us-wide') {
    const sameCity = aCity && bCity && aCity === bCity
    const sameState = aState && bState && aState === bState
    if (!sameCity && !sameState) return false
  }
  
  if (bScope === 'local' && aScope === 'us-wide') {
    const sameCity = aCity && bCity && aCity === bCity
    const sameState = aState && bState && aState === bState
    if (!sameCity && !sameState) return false
  }
  
  // 2. Meeting format compatibility
  const aFormat = userA.meeting_format_preference || 'both'
  const bFormat = userB.meeting_format_preference || 'both'
  
  // Incompatible if one wants ONLY virtual and other wants ONLY in-person
  if ((aFormat === 'virtual' && bFormat === 'in-person') ||
      (aFormat === 'in-person' && bFormat === 'virtual')) {
    return false
  }
  
  return true
}

function scoreMatch(recipient: any, candidate: any): number {
  let score = 0
    
    // BOOST SYSTEM: Add boost_score bonus (0-100 range)
    const boostBonus = (candidate.boost_score || 0) * 2  // Each boost point = 2 score points
    score += boostBonus
    
    // PRIORITY: Priority users get additional 50 points
    if (candidate.is_priority) {
      score += 50
    }

  // 1. Intro preferences match
  const recipientPrefs: string[] = Array.isArray(recipient.intro_preferences) ? recipient.intro_preferences : []
  const candidateRole: string = candidate.role_type || ''
  if (recipientPrefs.some((p: string) => p.toLowerCase() === candidateRole.toLowerCase())) {
    score += 30
  }

  // 2. Reverse match
  const candidatePrefs: string[] = Array.isArray(candidate.intro_preferences) ? candidate.intro_preferences : []
  const recipientRole: string = recipient.role_type || ''
  if (candidatePrefs.some((p: string) => p.toLowerCase() === recipientRole.toLowerCase())) {
    score += 20
  }

  // 3. Purpose alignment
  const recipientPurposes: string[] = Array.isArray(recipient.purposes) ? recipient.purposes : []
  const candidatePurposes: string[] = Array.isArray(candidate.purposes) ? candidate.purposes : []
  const purposeOverlap = recipientPurposes.filter((p: string) =>
    candidatePurposes.some((cp: string) => cp.toLowerCase() === p.toLowerCase())
  ).length
  score += purposeOverlap * 12

  const recipientExpertise = parseExpertise(recipient.expertise)
  const candidateExpertise = parseExpertise(candidate.expertise)
  const expertiseOverlap = recipientExpertise.filter((e: string) =>
    candidateExpertise.some((ce: string) => ce.toLowerCase() === e.toLowerCase())
  ).length
  // Bonus for SOME overlap but not total overlap (complementary is better)
  if (expertiseOverlap > 0 && expertiseOverlap < Math.min(recipientExpertise.length, candidateExpertise.length)) {
    score += expertiseOverlap * 8
  }

  // 5. Geographic alignment bonus
  const recipientScope = recipient.geographic_scope || 'us-wide'
  const sameCity = recipient.city?.toLowerCase().trim() === candidate.city?.toLowerCase().trim()
  const sameState = recipient.state?.toLowerCase().trim() === candidate.state?.toLowerCase().trim()
  
  if (recipientScope === 'local' && (sameCity || sameState)) {
    score += 15 // Strong bonus for local matches when preferred
  } else if (sameCity) {
    score += 8 // Mild bonus for same city even if not required
  } else if (sameState) {
    score += 5 // Small bonus for same state
  }

  // 6. Meeting format alignment bonus
  const recipientFormat = recipient.meeting_format_preference || 'both'
  const candidateFormat = candidate.meeting_format_preference || 'both'
  
  if (recipientFormat === candidateFormat) {
    score += 10 // Bonus for exact format match
  } else if (recipientFormat === 'both' || candidateFormat === 'both') {
    score += 5 // Small bonus if one is flexible
  }

  // 7. Seniority strategic pairing
  const recipientSeniority = recipient.seniority?.toLowerCase()
  const candidateSeniority = candidate.seniority?.toLowerCase()
  
  // Bonus for strategic seniority pairings
  if (recipientSeniority === 'junior' && ['senior', 'executive', 'c-suite'].includes(candidateSeniority || '')) {
    score += 12 // Junior benefits from senior
  } else if (['senior', 'executive', 'c-suite'].includes(recipientSeniority || '') && candidateSeniority === 'junior') {
    score += 8 // Senior can mentor junior
  } else if (recipientSeniority === candidateSeniority && recipientSeniority) {
    score += 5 // Peer connections also valuable
  }

  // 8. Interests overlap
  const recipientInterests: string[] = recipient.interests || []
  const candidateInterests: string[] = candidate.interests || []
  const interestOverlap = recipientInterests.filter((i: string) =>
    candidateInterests.some((ci: string) => ci.toLowerCase() === i.toLowerCase())
  ).length
  score += interestOverlap * 10

  // 9. Mentorship compatibility
  const rMentor = recipient.mentorship_role?.toLowerCase()
  const cMentor = candidate.mentorship_role?.toLowerCase()
  if ((rMentor === 'mentor' && cMentor === 'mentee') ||
      (rMentor === 'mentee' && cMentor === 'mentor')) {
    score += 25
  }

  // 10. Tier boost
  const tierBoost: Record<string, number> = { executive: 15, professional: 8, free: 0 }
  score += tierBoost[candidate.subscription_tier] ?? 0

  // 11. Network scores
  if (candidate.networkValueScore) {
    score += Math.round((candidate.networkValueScore / 100) * 15)
  }
  if (candidate.responsivenessScore) {
    score += Math.round((candidate.responsivenessScore / 100) * 5)
  }


  // 12. Verification status boost
  const verificationBoost: Record<string, number> = {
    high_confidence: 12,
    verified: 15,
    pending: 0,
    flagged: -20  // Significant penalty for flagged users
  }
  score += verificationBoost[candidate.verification_status] ?? 0

  // 13. Trust score weighting
  if (candidate.trust_score) {
    score += Math.round((candidate.trust_score / 100) * 10)
  }
  return score
}

function getScoreBucket(score: number): 'high_score' | 'mid_score' | 'low_score' {
  if (score >= 70) return 'high_score'
  if (score >= 50) return 'mid_score'
  return 'low_score'
}

function generateReason(recipient: any, candidate: any): string {
  const recipientPrefs: string[] = Array.isArray(recipient.intro_preferences) ? recipient.intro_preferences : []
  const candidateRole: string = candidate.role_type || ''
  const recipientPurposes: string[] = Array.isArray(recipient.purposes) ? recipient.purposes : []
  const candidatePurposes: string[] = Array.isArray(candidate.purposes) ? candidate.purposes : []
  const recipientExpertise = parseExpertise(recipient.expertise)
  const candidateExpertise = parseExpertise(candidate.expertise)
  const recipientInterests: string[] = Array.isArray(recipient.interests) ? recipient.interests : []
  const candidateInterests: string[] = Array.isArray(candidate.interests) ? candidate.interests : []

  const sharedPurposes = recipientPurposes.filter((p: string) =>
    candidatePurposes.some((cp: string) => cp.toLowerCase() === p.toLowerCase())

  )
  
  const sharedExpertise = recipientExpertise.filter((e: string) =>
    candidateExpertise.some((ce: string) => ce.toLowerCase() === e.toLowerCase())
  )
  
  const sharedInterests = recipientInterests.filter((i: string) =>
    candidateInterests.some((ci: string) => ci.toLowerCase() === i.toLowerCase())
  )

  const rMentor = recipient.mentorship_role?.toLowerCase()
  const cMentor = candidate.mentorship_role?.toLowerCase()
  
  const sameCity = recipient.city?.toLowerCase().trim() === candidate.city?.toLowerCase().trim()
  const candidateName = candidate.full_name?.split(' ')[0] || 'They'

  // Priority 1: Purpose + Expertise alignment
  if (sharedPurposes.length > 0 && sharedExpertise.length > 0) {
    return `${candidateName} shares your focus on ${sharedPurposes[0]} with expertise in ${sharedExpertise[0]} — strong strategic alignment.`
  }

  // Priority 2: Mentorship
  if (rMentor === 'mentee' && cMentor === 'mentor') {
    return `${candidateName} is an experienced mentor in your field — strong mentorship alignment.`
  }
  if (rMentor === 'mentor' && cMentor === 'mentee') {
    return `${candidateName} is looking for guidance in areas where you have deep expertise.`
  }

  // Priority 3: Local connection
  if (sameCity && recipient.geographic_scope === 'local') {
    return `${candidateName} is based in ${recipient.city} and matches your preference for local connections.`
  }

  // Priority 4: Purpose alignment
  if (sharedPurposes.length > 0) {
    return `${candidateName} is also focused on ${sharedPurposes[0]} — aligned on goals and timing.`
  }


  // Priority 5: Interest alignment
  if (sharedInterests.length >= 2) {
    return `You both share a focus on ${sharedInterests.slice(0, 2).join(' and ')} — strong thematic alignment.`
  }

  // Priority 6: Role preference match
  if (recipientPrefs.some((p: string) => p.toLowerCase() === candidateRole.toLowerCase())) {
    return `${candidateName} matches the type of connection you're looking for — curated based on your preferences.`
  }

  // Fallback
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

function getTierDistribution(tier: string): { high: number, mid: number, total: number } {
  const distributions: Record<string, { high: number, mid: number, total: number }> = {
    free: { high: 1, mid: 2, total: 3 },
    professional: { high: 3, mid: 2, total: 5 },
    executive: { high: 5, mid: 3, total: 8 }
  }
  return distributions[tier] || distributions.free
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
      .select('id, full_name, email, role_type, seniority, mentorship_role, interests, intro_preferences, subscription_tier, looking_for, expertise, networkValueScore, responsivenessScore, verification_status, trust_score, current_status, purposes, city, state, geographic_scope, meeting_format_preference')
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

    const ninetyDaysAgo = new Date()
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

    // Get permanently hidden pairs
    const { data: hiddenPairs } = await adminClient
      .from('batch_suggestions')
      .select('recipient_id, suggested_id')
      .eq('status', 'hidden_permanent')

    const hiddenMap: Record<string, Set<string>> = {}
    for (const p of hiddenPairs || []) {
      if (!hiddenMap[p.recipient_id]) hiddenMap[p.recipient_id] = new Set()
      hiddenMap[p.recipient_id].add(p.suggested_id)
    }

    // Get recently passed pairs (within 90 days)
    const { data: passedPairs } = await adminClient
      .from('batch_suggestions')
      .select('recipient_id, suggested_id, created_at')
      .eq('status', 'passed')
      .gte('created_at', ninetyDaysAgo.toISOString())

    const passMap: Record<string, Set<string>> = {}
    for (const p of passedPairs || []) {
      if (!passMap[p.recipient_id]) passMap[p.recipient_id] = new Set()
      passMap[p.recipient_id].add(p.suggested_id)
    }

    // Get matched pairs (permanently exclude)
    const { data: matchedPairs } = await adminClient
      .from('matches')
      .select('user_a_id, user_b_id')

    const matchedMap: Record<string, Set<string>> = {}
    for (const m of matchedPairs || []) {
      if (!matchedMap[m.user_a_id]) matchedMap[m.user_a_id] = new Set()
      if (!matchedMap[m.user_b_id]) matchedMap[m.user_b_id] = new Set()
      matchedMap[m.user_a_id].add(m.user_b_id)
      matchedMap[m.user_b_id].add(m.user_a_id)
    }

    // Get recently SHOWN pairs (within 90 days) - cooldown period
    const { data: recentlyShown } = await adminClient
      .from('batch_suggestions')
      .select('recipient_id, suggested_id, shown_at')
      .eq('status', 'shown')
      .gte('shown_at', ninetyDaysAgo.toISOString())

    const recentlyShownMap: Record<string, Set<string>> = {}
    for (const s of recentlyShown || []) {
      if (!recentlyShownMap[s.recipient_id]) recentlyShownMap[s.recipient_id] = new Set()
      recentlyShownMap[s.recipient_id].add(s.suggested_id)
    }

    // CRITICAL: Get previously GENERATED but never shown candidates (high priority for reuse)
    const { data: generatedCandidates } = await adminClient
      .from('batch_suggestions')
      .select('recipient_id, suggested_id, match_score, reason')
      .eq('status', 'generated')

    const generatedMap: Record<string, Map<string, {score: number, reason: string}>> = {}
    for (const g of generatedCandidates || []) {
      if (!generatedMap[g.recipient_id]) generatedMap[g.recipient_id] = new Map()
      generatedMap[g.recipient_id].set(g.suggested_id, {
        score: g.match_score,
        reason: g.reason
      })
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
        
        
        const aHiddenB = hiddenMap[userA.id]?.has(userB.id)
        const bHiddenA = hiddenMap[userB.id]?.has(userA.id)
        const aPassedB = passMap[userA.id]?.has(userB.id)
        const bPassedA = passMap[userB.id]?.has(userA.id)
        const aMatchedB = matchedMap[userA.id]?.has(userB.id)
        const bMatchedA = matchedMap[userB.id]?.has(userA.id)
        const aShownB = recentlyShownMap[userA.id]?.has(userB.id)
        const bShownA = recentlyShownMap[userB.id]?.has(userA.id)
        
        // Exclude if: hidden, passed, matched, or recently shown
        if (aHiddenB || bHiddenA || aPassedB || bPassedA || aMatchedB || bMatchedA || aShownB || bShownA) continue
        
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
    
    // NEW TIER-FIRST MATCHING FLOW
    // Step 1: Build candidate pools for each user (no selection yet)

    // CRITICAL: Process users in tier priority order (Executive → Professional → Free)
    const tierPriority: Record<string, number> = { executive: 1, professional: 2, free: 3 }
    const sortedProfiles = [...profiles].sort((a, b) => {
      const aTier = tierPriority[a.subscription_tier || 'free'] || 3
      const bTier = tierPriority[b.subscription_tier || 'free'] || 3
      return aTier - bTier
    })
    const userCandidatePools: Record<string, Array<{
      candidate: any
      score: number
      bucket: 'high_score' | 'mid_score' | 'low_score'
      reason: string
    }>> = {}
    
    for (const profile of sortedProfiles) {
      userCandidatePools[profile.id] = []
    }
    
    // Populate candidate pools from all pairs
    for (const pair of allPairs) {
      const { userA, userB, scoreAtoB, scoreBtoA, reasonAtoB, reasonBtoA } = pair
      
      // Add B as candidate for A
      userCandidatePools[userA.id].push({
        candidate: userB,
        score: scoreAtoB,
        bucket: getScoreBucket(scoreAtoB),
        reason: reasonAtoB
      })
      
      // Add A as candidate for B
      userCandidatePools[userB.id].push({
        candidate: userA,
        score: scoreBtoA,
        bucket: getScoreBucket(scoreBtoA),
        reason: reasonBtoA
      })
    }
    
    // Step 2: Apply tier-based selection for each user

    const userBatches: Record<string, any[]> = {}
    const userRoleCounts: Record<string, Record<string, number>> = {}

    for (const profile of sortedProfiles) {
      const tier = profile.subscription_tier || 'free'
      const tierDist = getTierDistribution(tier)
      const pool = userCandidatePools[profile.id]
      
      // Separate by bucket
      const highCandidates = pool.filter(c => c.bucket === 'high_score').sort((a, b) => b.score - a.score)
      const midCandidates = pool.filter(c => c.bucket === 'mid_score').sort((a, b) => b.score - a.score)
      const lowCandidates = pool.filter(c => c.bucket === 'low_score').sort((a, b) => b.score - a.score)
      
      const selected: any[] = []
      
      // Initialize role counts for this profile
      if (!userRoleCounts[profile.id]) {
        userRoleCounts[profile.id] = {}
      }
      
      // Select high-score candidates first
      for (let i = 0; i < Math.min(tierDist.high, highCandidates.length); i++) {
        const candidate = highCandidates[i]
        
        // Check role diversity
        const roleType = candidate.candidate.role_type || 'unknown'
        const roleCount = userRoleCounts[profile.id][roleType] || 0
        const maxPerRole = Math.ceil(tierDist.total * MAX_SAME_ROLE_PERCENT)
        
        if (roleCount < maxPerRole) {
          selected.push({
            suggested: candidate.candidate,
            score: candidate.score,
            bucket: candidate.bucket,
            reason: candidate.reason
          })
          userRoleCounts[profile.id][roleType] = roleCount + 1
        }
      }
      
      // Select mid-score candidates to fill remaining slots
      const stillNeed = tierDist.total - selected.length
      for (let i = 0; i < Math.min(stillNeed, midCandidates.length); i++) {
        const candidate = midCandidates[i]
        
        const roleType = candidate.candidate.role_type || 'unknown'
        const roleCount = userRoleCounts[profile.id][roleType] || 0
        const maxPerRole = Math.ceil(tierDist.total * MAX_SAME_ROLE_PERCENT)
        
        if (roleCount < maxPerRole) {
          selected.push({
            suggested: candidate.candidate,
            score: candidate.score,
            bucket: candidate.bucket,
            reason: candidate.reason
          })
          userRoleCounts[profile.id][roleType] = roleCount + 1
        }
      }
      
      // Fallback: if still need more and have low-score candidates
      const finalNeed = tierDist.total - selected.length
      if (finalNeed > 0 && lowCandidates.length > 0) {
        for (let i = 0; i < Math.min(finalNeed, lowCandidates.length); i++) {
          const candidate = lowCandidates[i]
          
          const roleType = candidate.candidate.role_type || 'unknown'
          const roleCount = userRoleCounts[profile.id][roleType] || 0
          const maxPerRole = Math.ceil(tierDist.total * MAX_SAME_ROLE_PERCENT)
          
          if (roleCount < maxPerRole) {
            selected.push({
              suggested: candidate.candidate,
              score: candidate.score,
              bucket: candidate.bucket,
              reason: candidate.reason
            })
            userRoleCounts[profile.id][roleType] = roleCount + 1
          }
        }
      }
      
      userBatches[profile.id] = selected
    }
    
    // Step 3: Detect mutual matches AFTER selection (for reporting only)
    let mutualMatchesCreated = 0
    for (const userAId of Object.keys(userBatches)) {
      for (const match of userBatches[userAId]) {
        const userBId = match.suggested.id
        const bHasA = userBatches[userBId]?.some(m => m.suggested.id === userAId)
        if (bHasA) {
          mutualMatchesCreated++
        }
      }
    }
    mutualMatchesCreated = mutualMatchesCreated / 2 // Each mutual counted twice
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
          score_bucket: getScoreBucket(score),
          position: i + 1,
          status: 'generated',
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
      oneWayMatches: allSuggestions.length - (mutualMatchesCreated * 2),
      avgBatchSize: Math.round(avgBatchSize * 10) / 10,
      qualityMetrics: {
        relevanceThreshold: MIN_RELEVANCE_SCORE,
        mutualMatchPercentile: MUTUAL_MATCH_PERCENTILE,
        pairsConsidered: allPairs.length,
        pairsQualified: allPairs.length,
      }
    })
  } catch (err: any) {
    console.error('[generate-batch] error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
