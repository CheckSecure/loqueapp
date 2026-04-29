import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getReferralExclusionsForUser } from '@/lib/referrals/exclusions'

export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

const TIER_TARGETS: Record<string, number> = {
  free: 3,
  professional: 5,
  executive: 8,
  founding: 5,
}

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
  if (!tier) return 3
  const t = TIER_TARGETS[tier]
  return typeof t === 'number' ? t : 3
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

  return score
}

function getScoreBucket(score: number): string {
  if (score >= 100) return 'high_score'
  if (score >= 60) return 'mid_score'
  return 'low_score'
}

function buildReason(recipient: any, candidate: any): string {
  const parts: string[] = []
  const recipientPurposes: string[] = Array.isArray(recipient.purposes) ? recipient.purposes : []
  const candidatePurposes: string[] = Array.isArray(candidate.purposes) ? candidate.purposes : []
  const sharedPurposes = recipientPurposes.filter((p) =>
    candidatePurposes.some((cp) => cp.toLowerCase() === p.toLowerCase())
  )
  if (sharedPurposes.length > 0) {
    parts.push(`Shared interest in ${sharedPurposes.slice(0, 2).join(', ')}`)
  }
  const recipientExpertise = parseExpertise(recipient.expertise)
  const candidateExpertise = parseExpertise(candidate.expertise)
  const sharedExpertise = recipientExpertise.filter((e) =>
    candidateExpertise.some((ce) => ce.toLowerCase() === e.toLowerCase())
  )
  if (sharedExpertise.length > 0) {
    parts.push(`Overlap in ${sharedExpertise.slice(0, 2).join(', ')}`)
  }
  if (parts.length === 0) {
    return 'Recommended based on profile match'
  }
  return parts.join('. ')
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

    const recipientGroups = new Map<string, { generated: number; dropped: number; suggestedIds: Set<string> }>()
    for (const row of allInBatch.data || []) {
      if (!row.recipient_id) continue
      if (!recipientGroups.has(row.recipient_id)) {
        recipientGroups.set(row.recipient_id, { generated: 0, dropped: 0, suggestedIds: new Set() })
      }
      const g = recipientGroups.get(row.recipient_id)!
      if (row.status === 'generated') g.generated++
      if (row.status === 'dropped') g.dropped++
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
      r.needed = Math.max(0, target - group.generated)
    }

    const candidatePoolResult = await admin
      .from('profiles')
      .select('*')
      .eq('account_status', 'active')
      .eq('profile_complete', true)
    if (candidatePoolResult.error) {
      return NextResponse.json({ error: candidatePoolResult.error.message }, { status: 500 })
    }
    const candidatePool = candidatePoolResult.data || []

    const cooldownCutoff = new Date(Date.now() - DROPPED_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString()

    let totalCreated = 0
    let recipientsFilled = 0
    const insertRows: any[] = []

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
        if (!isCompatiblePair(recipient, candidate)) continue
        const score = scoreMatch(recipient, candidate)
        if (score < MIN_RELEVANCE_SCORE) continue
        scored.push({ candidate, score })
      }

      scored.sort((a, b) => b.score - a.score)
      const toInsert = scored.slice(0, r.needed)

      if (toInsert.length === 0) continue

      const group = recipientGroups.get(r.recipientId)!
      const startingPosition = group.generated + group.dropped
      let positionOffset = 1
      for (const { candidate, score } of toInsert) {
        insertRows.push({
          batch_id: batchId,
          recipient_id: r.recipientId,
          suggested_id: candidate.id,
          reason: buildReason(recipient, candidate),
          match_score: score,
          score_bucket: getScoreBucket(score),
          position: startingPosition + positionOffset,
          status: 'generated',
        })
        positionOffset++
      }
      totalCreated += toInsert.length
      recipientsFilled++
    }

    if (insertRows.length > 0) {
      const insertResult = await admin
        .from('batch_suggestions')
        .insert(insertRows)
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
