import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { parseExpertise } from '@/lib/parseExpertise'
import { createAdminClient } from '@/lib/supabase/admin'
import { isBusinessSolutionProvider, maxBusinessSolutionCount } from '@/lib/matching/business-solutions'
import { isSameCompany } from '@/lib/matching/same-company'
import { introReasonText } from '@/lib/match-signals'
import { sanitizeMatchScore, assertStorableScore } from '@/lib/matching/score'
import { buildScoringContext, scoreMatch as scoreMatchV2, exposureAdjustedScore, EXPOSURE_CONFIG, BATCH_CONFIG, RECOMMENDATION_ALGORITHM_VERSION, SCORING_MODEL_VERSION, algorithmSnapshot, algorithmConfigHash, type ScoringContext } from '@/lib/matching/batch-scoring'
import { applyMemberEligibility, filterEligible, ELIGIBILITY_COLUMNS } from '@/lib/matching/eligibility'

export const dynamic = 'force-dynamic'

// All batch tuning lives in BATCH_CONFIG (lib/matching/batch-scoring.ts).
const MIN_RELEVANCE_SCORE = BATCH_CONFIG.minRelevanceScore
const MAX_SAME_ROLE_PERCENT = BATCH_CONFIG.maxSameRolePercent
const MUTUAL_MATCH_PERCENTILE = 0.4 // reported in qualityMetrics only

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


function getScoreBucket(score: number): 'high_score' | 'mid_score' | 'low_score' {
  if (score >= BATCH_CONFIG.bucketHighMin) return 'high_score'
  if (score >= BATCH_CONFIG.bucketMidMin) return 'mid_score'
  return 'low_score'
}

// Deterministic, gender-neutral reason for a batch suggestion. Delegates to the
// single shared builder (lib/match-signals.ts) so the batch surface tells the
// same story as onboarding/cron/admin generation. Newline-joined bullets, or a
// restrained fallback when no meaningful signal exists.
function generateReason(recipient: any, candidate: any): string {
  return introReasonText(recipient, candidate)
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
  return BATCH_CONFIG.tierDistribution[tier] || BATCH_CONFIG.tierDistribution.free
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

    // Canonical eligibility at the source (test/admin/suspended/incomplete never
    // fetched). ELIGIBILITY_COLUMNS are selected so the in-memory re-check below
    // can enforce the same rule as defense-in-depth.
    const { data: rawProfiles, error: profilesError } = await applyMemberEligibility(
      adminClient
        .from('profiles')
        .select(`id, full_name, role_type, seniority, mentorship_role, interests, intro_preferences, subscription_tier, looking_for, expertise, networkValueScore, responsivenessScore, verification_status, trust_score, current_status, purposes, city, state, geographic_scope, meeting_format_preference, open_to_business_solutions, company, boost_score, is_priority, ${ELIGIBILITY_COLUMNS}`)
    )

    // Defense-in-depth: an excluded account can never reach scoring, rarity/IDF,
    // exposure balancing, or selection even if a query clause is ever dropped.
    const profiles = filterEligible(rawProfiles as any[])

    if (profilesError || !profiles || profiles.length < 2) {
      return NextResponse.json({ error: 'Not enough profiles to match' }, { status: 400 })
    }

    // v2 scoring context (rarity/IDF factors) computed from this cohort — see
    // lib/matching/batch-scoring.ts. buildScoringContext fails fast if any
    // excluded account slipped through. Exposure counts balance candidate spread.
    const scoringCtx: ScoringContext = buildScoringContext(profiles, undefined, 'generate-batch')
    const exposureCount: Record<string, number> = {}

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

    // Stamp the batch with the recommendation-engine version + config snapshot for
    // reproducibility (migration 018). Deploy-safe: if those columns aren't applied
    // yet, retry the insert without them so batch generation never breaks.
    const baseRow = {
      batch_number: nextBatchNumber,
      week_start: monday.toISOString().split('T')[0],
      week_end: sunday.toISOString().split('T')[0],
      status: 'pending_review',
      created_by: user.id,
    }
    const versionRow = {
      algorithm_version: RECOMMENDATION_ALGORITHM_VERSION,
      scoring_model_version: SCORING_MODEL_VERSION,
      algorithm_config: algorithmSnapshot(),
      config_hash: algorithmConfigHash(),
    }
    let { data: batch, error: batchError } = await adminClient
      .from('introduction_batches').insert({ ...baseRow, ...versionRow }).select().single()
    if (batchError && /column .* does not exist|schema cache|PGRST20[45]/i.test(`${batchError.message} ${(batchError as any).code ?? ''}`)) {
      console.warn('[generate-batch] version columns absent (apply migration 018); recording batch without version snapshot')
      ;({ data: batch, error: batchError } = await adminClient
        .from('introduction_batches').insert(baseRow).select().single())
    }

    if (batchError || !batch) {
      return NextResponse.json({ error: `Failed to create batch: ${batchError?.message || 'no row returned'}` }, { status: 500 })
    }

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
        
        // Exclude if: hidden, passed, matched, recently shown, or same company
        if (aHiddenB || bHiddenA || aPassedB || bPassedA || aMatchedB || bMatchedA || aShownB || bShownA || isSameCompany(userA, userB)) continue
        
        const scoreAtoB = scoreMatchV2(userA, userB, scoringCtx)
        const scoreBtoA = scoreMatchV2(userB, userA, scoringCtx)
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
      return aTier - bTier || String(a.id).localeCompare(String(b.id)) // deterministic + repeatable
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

      // Business-solution cap — mirrors live recommendation path throttle
      const bsCap = maxBusinessSolutionCount(
        profile.open_to_business_solutions || false,
        tier,
        tierDist.total
      )
      let bsCount = 0

      const maxPerRole = Math.ceil(tierDist.total * MAX_SAME_ROLE_PERCENT)
      // Rank each bucket by exposure-adjusted score (gentle nudge toward
      // less-exposed candidates among near-equals) then raw score, with a
      // deterministic id tiebreak. Bucket membership is still by RAW score, so no
      // weak match is promoted.
      const rankBucket = (b: 'high_score' | 'mid_score' | 'low_score') =>
        pool.filter(c => c.bucket === b).sort((x, y) =>
          exposureAdjustedScore(y.score, exposureCount[y.candidate.id] || 0) - exposureAdjustedScore(x.score, exposureCount[x.candidate.id] || 0)
          || y.score - x.score
          || String(x.candidate.id).localeCompare(String(y.candidate.id)))
      const highCandidates = rankBucket('high_score')
      const midCandidates = rankBucket('mid_score')
      const lowCandidates = rankBucket('low_score')

      const selected: any[] = []
      if (!userRoleCounts[profile.id]) userRoleCounts[profile.id] = {}

      // Greedy fill: iterate the FULL ranked bucket until the phase quota is met
      // (so exposure re-ordering changes WHICH candidate fills a slot, never the
      // number filled), honoring the role cap, business-solution cap, and the
      // bounded per-batch candidate exposure cap (Part 4).
      const fillPhase = (candidates: any[], quota: number) => {
        let filled = 0
        for (const candidate of candidates) {
          if (filled >= quota) break
          // Optional hard exposure cap (disabled by default — see EXPOSURE_CONFIG;
          // validation showed it degrades match quality without improving coverage).
          if (EXPOSURE_CONFIG.maxPerBatch != null && (exposureCount[candidate.candidate.id] || 0) >= EXPOSURE_CONFIG.maxPerBatch) continue
          const roleType = candidate.candidate.role_type || 'unknown'
          const roleCount = userRoleCounts[profile.id][roleType] || 0
          const isBS = isBusinessSolutionProvider(candidate.candidate)
          if (roleCount < maxPerRole && (!isBS || bsCount < bsCap)) {
            selected.push({ suggested: candidate.candidate, score: candidate.score, bucket: candidate.bucket, reason: candidate.reason })
            userRoleCounts[profile.id][roleType] = roleCount + 1
            if (isBS) bsCount++
            exposureCount[candidate.candidate.id] = (exposureCount[candidate.candidate.id] || 0) + 1
            filled++
          }
        }
      }

      fillPhase(highCandidates, tierDist.high)
      fillPhase(midCandidates, tierDist.total - selected.length)
      fillPhase(lowCandidates, tierDist.total - selected.length)

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

    // Build + insert suggestions. Any failure here (out-of-range score or a DB
    // error) triggers a compensating delete of the batch row we created above —
    // batch creation and suggestion insertion are not in one SQL transaction, so
    // this keeps a failed attempt from leaving an orphan/empty batch behind.
    try {
      for (const [recipientId, suggestions] of Object.entries(userBatches)) {
        for (let i = 0; i < suggestions.length; i++) {
          const { suggested, score, reason } = suggestions[i]
          const safeScore = sanitizeMatchScore(score)
          assertStorableScore(safeScore, recipientId, suggested.id) // descriptive error, not "numeric field overflow"
          allSuggestions.push({
            batch_id: batch.id,
            recipient_id: recipientId,
            suggested_id: suggested.id,
            reason,
            match_score: safeScore,
            score_bucket: getScoreBucket(safeScore),
            position: i + 1,
            status: 'generated',
          })
        }
      }

      if (allSuggestions.length > 0) {
        const { error: suggestionsError } = await adminClient
          .from('batch_suggestions')
          .insert(allSuggestions)
        if (suggestionsError) throw new Error(`Failed to insert suggestions: ${suggestionsError.message}`)
      }
    } catch (insertErr: any) {
      // Compensating cleanup: remove the just-created (now empty) batch row.
      await adminClient.from('introduction_batches').delete().eq('id', batch.id)
      return NextResponse.json({ error: insertErr?.message || 'Failed to insert suggestions' }, { status: 500 })
    }

    const oneWayMatches = allSuggestions.length - (mutualMatchesCreated * 2)
    const avgBatchSize = allSuggestions.length / profiles.length

    return NextResponse.json({
      success: true,
      batchId: batch.id,
      batchNumber: nextBatchNumber,
      algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
      scoringModelVersion: SCORING_MODEL_VERSION,
      configHash: algorithmConfigHash(),
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
