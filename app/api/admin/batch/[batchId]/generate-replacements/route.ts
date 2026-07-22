import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getReferralExclusionsForUser } from '@/lib/referrals/exclusions'
import { isSameCompany } from '@/lib/matching/same-company'
import { introReasonText } from '@/lib/match-signals'
import { sanitizeMatchScore, assertStorableScore } from '@/lib/matching/score'
import { applyMemberEligibility, filterEligible, assertAllEligible } from '@/lib/matching/eligibility'
import { enforceRecipientLimits, perRecipientIntroLimit, suggestionCountsTowardLimit } from '@/lib/matching/batch-limits'

export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'


const MIN_RELEVANCE_SCORE = 25
const DROPPED_COOLDOWN_DAYS = 90

function parseExpertise(value: any): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string')
  if (typeof value !== 'string') return []
  const trimmed = value.trim()
  if (!trimmed || trimmed === '{}') return []
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1)
    if (!inner) return []
    const parts: string[] = []
    let cur = ''
    let inQuote = false
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]
      if (ch === '"' && inner[i - 1] !== '\\') {
        inQuote = !inQuote
      } else if (ch === ',' && !inQuote) {
        parts.push(cur.trim())
        cur = ''
      } else {
        cur += ch
      }
    }
    if (cur) parts.push(cur.trim())
    return parts.map((p) => p.replace(/^"|"$/g, '').trim()).filter(Boolean)
  }
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean)
}

function tierTarget(tier: string | null | undefined): number {
  // Respect the launch-phase per-member cap (single source of truth), so
  // replacements never refill above the current introductions-per-member limit.
  return perRecipientIntroLimit(tier)
}

function isCompatiblePair(userA: any, userB: any): boolean {
  const aScope = userA.geographic_scope || 'us-wide'
  const bScope = userB.geographic_scope || 'us-wide'
  const aCity = (userA.city || '').toLowerCase().trim()
  const bCity = (userB.city || '').toLowerCase().trim()
  const aState = (userA.state || '').toLowerCase().trim()
  const bState = (userB.state || '').toLowerCase().trim()

  if (aScope === 'local' && bScope === 'local') {
    const sameCity = aCity && bCity && aCity === bCity
    const sameState = aState && bState && aState === bState
    if (!sameCity && !sameState) return false
  }
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

  const aFormat = userA.meeting_format_preference || 'both'
  const bFormat = userB.meeting_format_preference || 'both'
  if ((aFormat === 'virtual' && bFormat === 'in-person') ||
      (aFormat === 'in-person' && bFormat === 'virtual')) {
    return false
  }
  return true
}

function scoreMatch(recipient: any, candidate: any): number {
  let score = 0

  const boostBonus = (candidate.boost_score || 0) * 2
  score += boostBonus
  if (candidate.is_priority) score += 50

  const recipientPrefs: string[] = Array.isArray(recipient.intro_preferences) ? recipient.intro_preferences : []
  const candidateRole: string = candidate.role_type || ''
  if (recipientPrefs.some((p: string) => p.toLowerCase() === candidateRole.toLowerCase())) {
    score += 30
  }

  const candidatePrefs: string[] = Array.isArray(candidate.intro_preferences) ? candidate.intro_preferences : []
  const recipientRole: string = recipient.role_type || ''
  if (candidatePrefs.some((p: string) => p.toLowerCase() === recipientRole.toLowerCase())) {
    score += 20
  }

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
  // Cap counted overlap at 5 so users with broad expertise lists do not dominate.
  score += Math.min(5, expertiseOverlap) * 8

  return sanitizeMatchScore(score)
}

function getScoreBucket(score: number): string {
  if (score >= 100) return 'high_score'
  if (score >= 60) return 'mid_score'
  return 'low_score'
}

// Deterministic, gender-neutral replacement reason. Delegates to the single
// shared builder (lib/match-signals.ts) so replacements read identically to
// every other generation path.
function buildReason(recipient: any, candidate: any): string {
  return introReasonText(recipient, candidate)
}

export async function POST(req: NextRequest, { params }: { params: { batchId: string } }) {
  try {
    const supabase = createClient()
    const userResult = await supabase.auth.getUser()
    const user = userResult.data.user
    if (!user || user.email !== ADMIN_EMAIL) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
    }

    const batchId = params.batchId
    if (!batchId) {
      return NextResponse.json({ error: 'Missing batchId' }, { status: 400 })
    }

    const admin = createAdminClient()

    const batchLookup = await admin
      .from('introduction_batches')
      .select('*')
      .eq('id', batchId)
      .single()
    if (batchLookup.error || !batchLookup.data) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
    }

    const allInBatch = await admin
      .from('batch_suggestions')
      .select('id, recipient_id, suggested_id, status')
      .eq('batch_id', batchId)
    if (allInBatch.error) {
      return NextResponse.json({ error: allInBatch.error.message }, { status: 500 })
    }

    const recipientGroups = new Map<string, { generated: number; dropped: number; live: number; suggestedIds: Set<string> }>()
    for (const row of allInBatch.data || []) {
      if (!row.recipient_id) continue
      if (!recipientGroups.has(row.recipient_id)) {
        recipientGroups.set(row.recipient_id, { generated: 0, dropped: 0, live: 0, suggestedIds: new Set() })
      }
      const g = recipientGroups.get(row.recipient_id)!
      if (row.status === 'generated') g.generated++
      if (row.status === 'dropped') g.dropped++
      // `live` = every suggestion still counting toward the recipient's limit
      // (all statuses except dropped/hidden_permanent). The prior code sized fills
      // against `generated` ONLY, so once suggestions moved to shown/active/etc.
      // the recipient was refilled past their tier limit — this is the fix.
      if (suggestionCountsTowardLimit(row.status)) g.live++
      if (row.suggested_id) g.suggestedIds.add(row.suggested_id)
    }

    const recipientsNeedingFill: { recipientId: string; needed: number; existingSuggestedIds: Set<string> }[] = []
    for (const [rid, info] of recipientGroups.entries()) {
      if (info.dropped === 0) continue
      recipientsNeedingFill.push({
        recipientId: rid,
        needed: 0,
        existingSuggestedIds: info.suggestedIds,
      })
    }

    if (recipientsNeedingFill.length === 0) {
      return NextResponse.json({ success: true, replacementsCreated: 0, recipientsFilled: 0, message: 'No dropped suggestions to fill' })
    }

    const recipientIds = recipientsNeedingFill.map((r) => r.recipientId)
    const recipientProfilesResult = await admin
      .from('profiles')
      .select('*')
      .in('id', recipientIds)
    if (recipientProfilesResult.error) {
      return NextResponse.json({ error: recipientProfilesResult.error.message }, { status: 500 })
    }
    const recipientProfileMap = new Map<string, any>()
    for (const p of recipientProfilesResult.data || []) {
      recipientProfileMap.set(p.id, p)
    }

    for (const r of recipientsNeedingFill) {
      const profile = recipientProfileMap.get(r.recipientId)
      if (!profile) {
        r.needed = 0
        continue
      }
      const target = tierTarget(profile.subscription_tier)
      const group = recipientGroups.get(r.recipientId)!
      // Fill only up to the tier limit counting ALL live suggestions (not just
      // 'generated'), so a member can never end up above their configured limit.
      r.needed = Math.max(0, target - group.live)
    }

    // Canonical eligibility (previously missing the admin/internal exclusion).
    const candidatePoolResult = await applyMemberEligibility(
      admin.from('profiles').select('*')
    )
    if (candidatePoolResult.error) {
      return NextResponse.json({ error: candidatePoolResult.error.message }, { status: 500 })
    }
    candidatePoolResult.data = filterEligible(candidatePoolResult.data as any[]) // in-memory defense
    const candidatePool = candidatePoolResult.data || []
    assertAllEligible(candidatePool, 'generate-replacements') // fail-fast before scoring

    const cooldownCutoff = new Date(Date.now() - DROPPED_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString()

    let totalCreated = 0
    let recipientsFilled = 0
    const insertRows: any[] = []

    // RECIPROCITY: a replacement is a NEW MUTUAL edge, never a one-way add. A candidate
    // C can replace a dropped slot for A only if C still has spare capacity, and we
    // insert BOTH directions (A→C and C→A) atomically. Degree here == a member's live
    // received count == their visibility, because the batch is reciprocal by
    // construction — so one degree map bounds both. This is what keeps the invariant
    // ("if A sees B then B sees A") intact after drops and refills.
    const liveDegree = new Map<string, number>()
    for (const [rid, info] of Array.from(recipientGroups.entries())) liveDegree.set(rid, info.live)
    const pendingDegree = new Map<string, number>()
    const degreeOf = (id: string) => (liveDegree.get(id) || 0) + (pendingDegree.get(id) || 0)
    const capOfMember = (m: any) => tierTarget(m?.subscription_tier)
    // Position cursor per member so appended rows get sensible, non-colliding positions.
    const positionCursor = new Map<string, number>()
    for (const [rid, info] of Array.from(recipientGroups.entries())) positionCursor.set(rid, info.generated + info.dropped)
    const nextPosition = (id: string) => { const n = (positionCursor.get(id) || 0) + 1; positionCursor.set(id, n); return n }
    const ensureGroup = (id: string) => {
      if (!recipientGroups.has(id)) recipientGroups.set(id, { generated: 0, dropped: 0, live: 0, suggestedIds: new Set() })
      return recipientGroups.get(id)!
    }

    for (const r of recipientsNeedingFill) {
      if (r.needed === 0) continue
      const recipient = recipientProfileMap.get(r.recipientId)
      if (!recipient) continue

      const recentDropped = await admin
        .from('batch_suggestions')
        .select('suggested_id')
        .eq('recipient_id', r.recipientId)
        .eq('status', 'dropped')
        .gte('dropped_at', cooldownCutoff)
      const droppedExclude = new Set<string>()
      for (const row of recentDropped.data || []) {
        if (row.suggested_id) droppedExclude.add(row.suggested_id)
      }

      const recentShown = await admin
        .from('batch_suggestions')
        .select('suggested_id')
        .eq('recipient_id', r.recipientId)
        .eq('status', 'shown')
        .gte('shown_at', cooldownCutoff)
      const shownExclude = new Set<string>()
      for (const row of recentShown.data || []) {
        if (row.suggested_id) shownExclude.add(row.suggested_id)
      }

      const userDismissed = await admin
        .from('intro_requests')
        .select('target_user_id')
        .eq('requester_id', r.recipientId)
        .in('status', ['hidden', 'hidden_permanent'])
      const dismissedExclude = new Set<string>()
      for (const row of userDismissed.data || []) {
        if (row.target_user_id) dismissedExclude.add(row.target_user_id)
      }

      const referralExclude = await getReferralExclusionsForUser(r.recipientId)

      const scored: { candidate: any; score: number }[] = []
      for (const candidate of candidatePool) {
        if (candidate.id === r.recipientId) continue
        if (r.existingSuggestedIds.has(candidate.id)) continue
        if (droppedExclude.has(candidate.id)) continue
        if (shownExclude.has(candidate.id)) continue
        if (dismissedExclude.has(candidate.id)) continue
        if (referralExclude.has(candidate.id)) continue
        if (isSameCompany(recipient, candidate)) continue
        if (!isCompatiblePair(recipient, candidate)) continue
        // Reciprocity gate: the candidate must have room for a new mutual edge and must
        // not already carry this recipient in either direction.
        if (degreeOf(candidate.id) >= capOfMember(candidate)) continue
        if (recipientGroups.get(candidate.id)?.suggestedIds.has(r.recipientId)) continue
        const score = scoreMatch(recipient, candidate)
        if (score < MIN_RELEVANCE_SCORE) continue
        scored.push({ candidate, score })
      }

      // Deterministic order; id tiebreak so equal scores resolve identically every run.
      scored.sort((a, b) => b.score - a.score || String(a.candidate.id).localeCompare(String(b.candidate.id)))

      // Fill up to the recipient's REMAINING capacity, recomputed live so reciprocal
      // edges already added to this recipient earlier in the run are accounted for.
      let filled = 0
      for (const { candidate, score } of scored) {
        if (degreeOf(r.recipientId) >= capOfMember(recipient)) break
        // Re-check the candidate — an earlier recipient in this run may have taken their
        // last slot (a popular candidate can only be a replacement `cap` times total).
        if (degreeOf(candidate.id) >= capOfMember(candidate)) continue

        const fwdScore = sanitizeMatchScore(score)
        assertStorableScore(fwdScore, r.recipientId, candidate.id)
        const revScore = sanitizeMatchScore(scoreMatch(candidate, recipient))
        assertStorableScore(revScore, candidate.id, r.recipientId)

        // Forward: recipient sees candidate.
        insertRows.push({
          batch_id: batchId,
          recipient_id: r.recipientId,
          suggested_id: candidate.id,
          reason: buildReason(recipient, candidate),
          match_score: fwdScore,
          score_bucket: getScoreBucket(fwdScore),
          position: nextPosition(r.recipientId),
          status: 'generated',
        })
        // Reverse: candidate sees recipient — mutual by construction.
        insertRows.push({
          batch_id: batchId,
          recipient_id: candidate.id,
          suggested_id: r.recipientId,
          reason: buildReason(candidate, recipient),
          match_score: revScore,
          score_bucket: getScoreBucket(revScore),
          position: nextPosition(candidate.id),
          status: 'generated',
        })

        pendingDegree.set(r.recipientId, (pendingDegree.get(r.recipientId) || 0) + 1)
        pendingDegree.set(candidate.id, (pendingDegree.get(candidate.id) || 0) + 1)
        r.existingSuggestedIds.add(candidate.id)
        ensureGroup(r.recipientId).suggestedIds.add(candidate.id)
        ensureGroup(candidate.id).suggestedIds.add(r.recipientId)
        totalCreated++
        filled++
      }
      if (filled > 0) recipientsFilled++
    }

    // FINAL INVARIANT (source-independent): never let existing live + new
    // replacements exceed a recipient's tier limit, even if `needed` were wrong.
    const { kept: keptRows, dropped: trimmed } = enforceRecipientLimits(
      insertRows,
      (rid) => perRecipientIntroLimit(recipientProfileMap.get(rid)?.subscription_tier),
      (rid) => recipientGroups.get(rid)?.live ?? 0,
    )
    if (Object.keys(trimmed).length > 0) {
      console.warn('[generate-replacements] per-recipient limit invariant trimmed excess (investigate upstream):', JSON.stringify(trimmed))
    }

    if (keptRows.length > 0) {
      const insertResult = await admin
        .from('batch_suggestions')
        .insert(keptRows)
      if (insertResult.error) {
        return NextResponse.json({ error: insertResult.error.message }, { status: 500 })
      }
    }

    return NextResponse.json({
      success: true,
      replacementsCreated: totalCreated,
      recipientsFilled,
      recipientsNeedingFill: recipientsNeedingFill.length,
    })
  } catch (err: any) {
    console.error('[generate-replacements] error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
