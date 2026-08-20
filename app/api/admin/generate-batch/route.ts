import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { parseExpertise } from '@/lib/parseExpertise'
import { createAdminClient } from '@/lib/supabase/admin'
import { isBusinessSolutionProvider, maxBusinessSolutionCount, isLegalNetworkingPair } from '@/lib/matching/business-solutions'
import { isSameCompany } from '@/lib/matching/same-company'
import { introReasonText } from '@/lib/match-signals'
import { sanitizeMatchScore, assertStorableScore } from '@/lib/matching/score'
import { buildScoringContext, scoreMatch as scoreMatchV2, BATCH_CONFIG, RECOMMENDATION_ALGORITHM_VERSION, SCORING_MODEL_VERSION, algorithmSnapshot, algorithmConfigHash, type ScoringContext } from '@/lib/matching/batch-scoring'
import { applyMemberEligibility, filterEligible, ELIGIBILITY_COLUMNS } from '@/lib/matching/eligibility'
import { enforceRecipientLimits, perRecipientIntroLimit } from '@/lib/matching/batch-limits'
import { MAX_RESERVED_INTRO_CARDS } from '@/lib/introductions/capacity'
import { solveGlobalBMatching, crossMarketAdjustment, pairTypeCounts, underfillReasonCounts, nullSafeRole } from '@/lib/matching/globalBMatching'
import { isSameSideLegalPartnerEdge, lawFirmRole, legalSameSidePenalty } from '@/lib/matching/legalSameSidePenalty'
import { isLegalProfessional } from '@/lib/matching/business-solutions'
import { buildIntroHistoryExclusions } from '@/lib/introRequests/history'

export const dynamic = 'force-dynamic'

// All batch tuning lives in BATCH_CONFIG (lib/matching/batch-scoring.ts).
const MIN_RELEVANCE_SCORE = BATCH_CONFIG.minRelevanceScore
const MAX_SAME_ROLE_PERCENT = BATCH_CONFIG.maxSameRolePercent
const MUTUAL_MATCH_PERCENTILE = 0.4 // reported in qualityMetrics only

// Law Firm Partner ↔ Law Firm Partner is a LAST-RESORT pairing (competing senior partners
// at different firms rarely refer to each other). A weight demotion proved insufficient:
// the b-matching still fills a member's open slot with a demoted partner edge. Instead we
// use a TWO-PASS selection below — the primary pass EXCLUDES LFP↔LFP edges entirely, and a
// fallback pass reintroduces them ONLY for members who cannot otherwise reach 2 intros.
// scoreMatch, buckets, reasons, and the stored match_score are untouched. LFP↔Attorney and
// other legal pairs are intentionally NOT treated as partner pairs (seniority-diverse).
// CROSS-MARKET-FIRST exclusion for the primary selection pass. Broadened from the old
// partner↔partner-only rule to EVERY same-side legal edge that involves a Law Firm
// Partner (partner↔partner AND partner↔attorney), so a partner is filled from
// cross-market candidates first; these edges return only via the coverage fallback.
// Shared helper (lawFirmRole) keeps this aligned with the live ranker's cross-market-first.
const isPartnerPair = (a: any, b: any) => isSameSideLegalPartnerEdge(a, b)

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

    // Previously-presented introductions live in the QUEUE (intro_requests), NOT in
    // batch_suggestions — so batches produced by the queue engine (onboarding/weekly)
    // are invisible to the exclusions above. Load that history and exclude those pairs
    // too, reusing the canonical tiered classification (lib/introRequests/history.ts):
    // HARD + ACTIVE + SOFT (accepted/pending/approved/suggested/queued/passed/expired
    // and archived rows that belonged to a real batch) are excluded; migration/backfill
    // artifacts (archived with no batch_id) are intentionally NOT treated as history.
    // Deploy-safe: on any read error, proceed with no queue exclusions (never block).
    const { data: introHistoryRows, error: introHistoryErr } = await adminClient
      .from('intro_requests')
      .select('requester_id, target_user_id, status, batch_id')
    if (introHistoryErr) {
      console.warn('[generate-batch] intro_requests history load failed; proceeding without queue exclusions:', introHistoryErr.message)
    }
    const introHistoryMap = buildIntroHistoryExclusions(introHistoryRows)

    // AVAILABILITY TIER — the hard resolved/unresolved candidate partition is GONE.
    //
    // What it was protecting is real: a pair must never land with one member's card VISIBLE while
    // the other's is QUEUED, because the visible side could act while the queued side cannot even
    // see it. But unresolved-ness was only a PROXY for that. Under migration 063 the tier a card
    // lands in is decided by free VISIBLE SLOTS, not by whether a member has acted. The proxy was
    // over-inclusive: the production audit measured exactly 144 excluded combinations (12 resolved
    // x 12 unresolved underfilled members) while only ~18 edges were needed to fill everyone.
    //
    // The real invariant is now enforced where it is actually decidable — atomically, on live
    // capacity, inside public.materialize_admin_pair (migration 064), which places a pair
    // 'suggested' for BOTH members or 'queued' for BOTH members or neither. Candidate generation
    // no longer needs to guess.
    //
    // Current card counts are still read here, but for PRIORITISATION (who is empty) rather than
    // exclusion.
    const visibleCards = new Map<string, number>()
    const reservedCards = new Map<string, number>()
    for (const r of introHistoryRows ?? []) {
      if (!r?.requester_id) continue
      if (r.status === 'suggested') visibleCards.set(r.requester_id, (visibleCards.get(r.requester_id) ?? 0) + 1)
      else if (r.status === 'queued') reservedCards.set(r.requester_id, (reservedCards.get(r.requester_id) ?? 0) + 1)
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
        // Queue history (intro_requests) — bidirectional, so either direction excludes.
        const introHistory = introHistoryMap.get(userA.id)?.has(userB.id) || introHistoryMap.get(userB.id)?.has(userA.id)

        // Exclude if: hidden, passed, matched, recently shown, queue-history, or same company
        if (aHiddenB || bHiddenA || aPassedB || bPassedA || aMatchedB || bMatchedA || aShownB || bShownA || introHistory || isSameCompany(userA, userB)) continue

        
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
    
    // RECIPROCAL GRAPH SELECTION
    // The graph — not the individual member — is the unit of optimization. `allPairs`
    // already holds every ELIGIBLE undirected edge (eligibility, same-company,
    // prior-intro exclusions, and the minimum relevance threshold have all removed
    // disqualified pairs above). We now choose a maximum-weight set of those edges such
    // that no member exceeds their intro cap, via greedy b-matching. Because every
    // selected edge is undirected it is mutual BY CONSTRUCTION — reciprocity and the
    // two-directional cap are properties of the output, not a post-process. See
    // lib/matching/reciprocal-graph.ts for the full rationale.
    const capOf = (m: any) => perRecipientIntroLimit(m.subscription_tier || 'free')
    const bsCapOf = (m: any, cap: number) => maxBusinessSolutionCount(m.open_to_business_solutions || false, m.subscription_tier || 'free', cap)
    const profileById = new Map<string, any>(profiles.map((p: any) => [p.id, p]))
    const M = (id: string) => profileById.get(id)

    // GLOBAL LEXICOGRAPHIC b-MATCHING over the complete eligible graph.
    //
    // Replaces greedy selection + two coverage fills + the exactly-one-intro repair pass. That
    // chain was not a b-matching solver and provably stranded members: measured over 4,000 random
    // graphs it left 282 cases where a strictly better assignment existed that dropped nobody, and
    // in 65% of those the stranded member had ZERO cards — which the repair pass never even looked
    // at, because it iterated only members sitting at exactly one.
    //
    // Every HARD gate has already been applied to `allPairs` above (eligibility, same-company,
    // blocking, existing matches, hard history, cooldown, and the unadjusted relevance floor). The
    // optimizer only ever selects from that set; it can never re-admit an excluded pair.
    const bmatch = solveGlobalBMatching(allPairs as any[], {
      // How many NEW proposals this member may receive in this batch.
      //
      // Capped at perRecipientIntroLimit. It must never exceed it: enforceRecipientLimits below
      // trims per RECIPIENT, and trimming is one-directional — it would cut one half of an edge
      // and reintroduce exactly the one-way rows this whole change exists to eliminate. The
      // reserved tier still counts toward whether a member has ANY room (so a member who is full
      // on both tiers gets no proposals at all), but it can never raise the batch's per-member
      // proposal count above the configured limit.
      deficitOf: (id: string) => {
        const m = M(id); if (!m) return 0
        const visFree = Math.max(0, capOf(m) - (visibleCards.get(id) ?? 0))
        const resFree = Math.max(0, MAX_RESERVED_INTRO_CARDS - (reservedCards.get(id) ?? 0))
        return Math.min(perRecipientIntroLimit(m.subscription_tier || 'free'), visFree + resFree)
      },
      // "Zero-card" means an EMPTY SCREEN — no visible card. Those members are covered first.
      existingCardsOf: (id: string) => visibleCards.get(id) ?? 0,
      // Cross-market legal preference, calibrated to the MEASURED score distribution (Option B:
      // per-edge -32/-24/-16, crossover +33 mutual points on an observed 62..166 range). Reusing
      // legalSameSidePenalty at full strength would put the crossover at +121, outside the range,
      // making same-side unwinnable on quality. See lib/matching/globalBMatching.ts for both
      // options and the measurements. The relevance floor above is applied to the UNADJUSTED
      // score, so this only ranks — it never removes an edge from the pool.
      qualityAdjustment: crossMarketAdjustment(lawFirmRole),
      // Business-solution throttle, carried over as a HARD constraint. Peer edges (both providers,
      // or legal<->legal) consume no quota, exactly as the previous path treated them.
      providerCapOf: (id: string) => { const m = M(id); return m ? bsCapOf(m, capOf(m)) : 0 },
      isProviderFor: (member: any, other: any) => {
        if (isBusinessSolutionProvider(member) && isBusinessSolutionProvider(other)) return false
        if (isLegalNetworkingPair(member, other)) return false
        return isBusinessSolutionProvider(other)
      },
      // Role diversity, preserved as the PREFERENCE the previous code documented it to be.
      roleOf: (m: any) => String(m?.role_type ?? 'unknown'),
      roleCapOf: (id: string) => { const m = M(id); return m ? Math.max(1, Math.ceil(capOf(m) * MAX_SAME_ROLE_PERCENT)) : 1 },
      roleRepeatPenalty: 25,
    })
    const selectedEdgesRepaired = bmatch.selected as typeof allPairs

    // Aggregate, identity-free reporting. No member id, name, email or company is logged.
    const isLawFirm = (x: any) => lawFirmRole(x) !== null
    const legalPro = nullSafeRole(isLegalProfessional)
    const pairComposition = pairTypeCounts(selectedEdgesRepaired as any[], isLawFirm, legalPro)
    const underfillReasons = underfillReasonCounts(
      profiles.map((p: any) => p.id), selectedEdgesRepaired as any[], allPairs as any[],
      (id: string) => Math.max(0, capOf(M(id) ?? {}) - (visibleCards.get(id) ?? 0)),
    )
    console.log('[generate-batch] optimizer:', JSON.stringify({
      exact: bmatch.exact, reason: bmatch.reason ?? null, nodes: bmatch.nodesExplored,
      edgesConsidered: allPairs.length, pairsSelected: selectedEdgesRepaired.length,
      pairComposition, underfillReasons,
    }))

    // Fan each selected edge out into BOTH directions. This is the only place rows are
    // created, so a one-way recommendation is structurally impossible: an edge that
    // isn't selected produces zero rows; one that is produces exactly two.
    const userBatches: Record<string, any[]> = {}
    for (const e of selectedEdgesRepaired) {
      ;(userBatches[e.userA.id] ||= []).push({ suggested: e.userB, score: e.scoreAtoB, reason: e.reasonAtoB })
      ;(userBatches[e.userB.id] ||= []).push({ suggested: e.userA, score: e.scoreBtoA, reason: e.reasonBtoA })
    }

    // Every edge is a mutual introduction by construction (selection + coverage fill).
    const mutualMatchesCreated = selectedEdgesRepaired.length
    const allSuggestions: any[] = []

    // Build + insert suggestions. Any failure here (out-of-range score or a DB
    // error) triggers a compensating delete of the batch row we created above —
    // batch creation and suggestion insertion are not in one SQL transaction, so
    // this keeps a failed attempt from leaving an orphan/empty batch behind.
    try {
      for (const [recipientId, suggestions] of Object.entries(userBatches)) {
        // Position by each recipient's OWN directional score (their strongest match
        // first), deterministic id tiebreak. Never drops or reorders across recipients.
        suggestions.sort((a, b) => b.score - a.score || String(a.suggested.id).localeCompare(String(b.suggested.id)))
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

      // FINAL INVARIANT: guarantee no recipient exceeds their tier limit, even if
      // an upstream selection bug produced excess. Fresh batch → no existing live
      // suggestions. Rows are in priority order, so the best ones are kept.
      const tierByRecipient = new Map(profiles.map((p: any) => [p.id, p.subscription_tier || 'free']))
      const { kept, dropped } = enforceRecipientLimits(
        allSuggestions,
        (rid) => perRecipientIntroLimit(tierByRecipient.get(rid)),
      )
      if (Object.keys(dropped).length > 0) {
        console.warn('[generate-batch] per-recipient limit invariant trimmed excess (investigate upstream):', JSON.stringify(dropped))
      }

      if (kept.length > 0) {
        const { error: suggestionsError } = await adminClient
          .from('batch_suggestions')
          .insert(kept)
        if (suggestionsError) throw new Error(`Failed to insert suggestions: ${suggestionsError.message}`)
      }
      allSuggestions.length = 0
      allSuggestions.push(...kept) // downstream metrics reflect what was actually persisted
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
      optimizer: {
        exact: bmatch.exact,
        reason: bmatch.reason ?? null,
        nodesExplored: bmatch.nodesExplored,
        pairComposition,
        underfillReasons,
      },
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
