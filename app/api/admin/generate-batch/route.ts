import { NextRequest, NextResponse } from 'next/server'
import { getUserScore } from '@/lib/scoring'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

const TIER_BATCH_SIZES: Record<string, number> = {
  free: 3,
  professional: 5,
  executive: 8,
}

function scoreMatch(recipient: any, candidate: any): number {
  let score = 0

  // 1. Intro preferences match — does recipient want to meet candidate's role type?
  const recipientPrefs: string[] = recipient.intro_preferences || []
  const candidateRole: string = candidate.role_type || ''
  if (recipientPrefs.some((p: string) => p.toLowerCase() === candidateRole.toLowerCase())) {
    score += 30
  }

  // 2. Reverse — does candidate want to meet recipient's role type?
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

  // 5. Tier boost — higher tier candidates get priority
  const tierBoost: Record<string, number> = { executive: 15, professional: 8, free: 0 }
  score += tierBoost[candidate.subscription_tier] ?? 0

  // 6. Network Value Score boost (up to 15 pts) + Responsiveness boost (up to 5 pts)
  if (candidate.networkValueScore) {
    score += Math.round((candidate.networkValueScore / 100) * 15)
  }
  if (candidate.responsivenessScore) {
    score += Math.round((candidate.responsivenessScore / 100) * 5)
  }

  // 6. Seniority diversity bonus (avoid same seniority always)
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

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || user.email !== 'bizdev91@gmail.com') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
    }

    const adminClient = createAdminClient()

    // Get all active, complete profiles
    const { data: profiles, error: profilesError } = await adminClient
      .from('profiles')
      .select('id, full_name, email, role_type, seniority, mentorship_role, interests, intro_preferences, subscription_tier, looking_for, expertise')
      .eq('profile_complete', true)
      .eq('is_active', true)
      .neq('email', 'bizdev91@gmail.com')

    if (profilesError || !profiles || profiles.length < 2) {
      return NextResponse.json({ error: 'Not enough profiles to match' }, { status: 400 })
    }

    // Get next batch number
    const { data: lastBatch } = await adminClient
      .from('introduction_batches')
      .select('batch_number')
      .order('batch_number', { ascending: false })
      .limit(1)
      .single()

    const nextBatchNumber = (lastBatch?.batch_number ?? 0) + 1

    // Get week dates
    const now = new Date()
    const monday = new Date(now)
    monday.setDate(now.getDate() - now.getDay() + 1)
    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 6)

    // Create the batch
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

    // Get recent passes and hidden profiles per user (last 90 days)
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

    // Get recently shown profiles (last 2 batches) to avoid repetition
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

    // Generate suggestions for each user
    const allSuggestions: any[] = []

    for (const recipient of profiles) {
      const batchSize = TIER_BATCH_SIZES[recipient.subscription_tier ?? 'free'] ?? 3
      const excludedArr = [
        recipient.id,
        ...Array.from(hiddenMap[recipient.id] || []),
        ...Array.from(passMap[recipient.id] || []),
        ...Array.from(recentlyShownMap[recipient.id] || []),
      ]
      const excluded = new Set(excludedArr)

      // Score all candidates
      const scored = profiles
        .filter(p => !excluded.has(p.id))
        .map(candidate => ({
          candidate,
          score: scoreMatch(recipient, candidate),
          reason: generateReason(recipient, candidate),
        }))
        .sort((a, b) => b.score - a.score)

      // Ensure diversity — limit same role_type to 40% of batch
      const selected: typeof scored = []
      const roleTypeCounts: Record<string, number> = {}
      const maxPerRole = Math.ceil(batchSize * 0.4)

      for (const item of scored) {
        if (selected.length >= batchSize) break
        const rt = item.candidate.role_type || 'unknown'
        if ((roleTypeCounts[rt] || 0) >= maxPerRole) continue
        selected.push(item)
        roleTypeCounts[rt] = (roleTypeCounts[rt] || 0) + 1
      }

      // Fill remaining slots without role diversity constraint
      if (selected.length < batchSize) {
        const selectedIds = new Set(selected.map(s => s.candidate.id))
        for (const item of scored) {
          if (selected.length >= batchSize) break
          if (!selectedIds.has(item.candidate.id)) {
            selected.push(item)
            selectedIds.add(item.candidate.id)
          }
        }
      }

      for (let i = 0; i < selected.length; i++) {
        const { candidate, score, reason } = selected[i]
        allSuggestions.push({
          batch_id: batch.id,
          recipient_id: recipient.id,
          suggested_id: candidate.id,
          reason,
          match_score: score,
          position: i + 1,
          status: 'active',
        })
      }
    }

    // Insert all suggestions
    if (allSuggestions.length > 0) {
      const { error: suggestionsError } = await adminClient
        .from('batch_suggestions')
        .insert(allSuggestions)

      if (suggestionsError) {
        return NextResponse.json({ error: `Failed to insert suggestions: ${suggestionsError.message}` }, { status: 500 })
      }
    }

    return NextResponse.json({
      success: true,
      batchId: batch.id,
      batchNumber: nextBatchNumber,
      totalSuggestions: allSuggestions.length,
      usersMatched: profiles.length,
    })
  } catch (err: any) {
    console.error('[generate-batch] error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
