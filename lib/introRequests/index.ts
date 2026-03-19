import { createClient } from '@/lib/supabase/server'

async function resolveProfileId(supabase: ReturnType<typeof createClient>, authUserId: string, authUserEmail?: string) {
  const orClause = authUserEmail
    ? `id.eq.${authUserId},email.eq.${authUserEmail}`
    : `id.eq.${authUserId}`
  const { data } = await supabase
    .from('profiles')
    .select('id')
    .or(orClause)
    .limit(1)
  return data?.[0]?.id ?? authUserId
}

export async function createIntroRequest(
  authUserId: string,
  authUserEmail: string,
  targetUserId: string,
  note?: string,
) {
  const supabase = createClient()
  console.log('[createIntroRequest] authUserId:', authUserId, 'targetUserId:', targetUserId)

  if (authUserId === targetUserId) {
    return { error: 'You cannot request an introduction to yourself.' }
  }

  const { data: existing, error: dupErr } = await supabase
    .from('intro_requests')
    .select('id')
    .eq('requester_id', authUserId)
    .eq('target_user_id', targetUserId)
    .eq('status', 'pending')
    .limit(1)

  console.log('[createIntroRequest] duplicate check — existing:', existing, 'dupErr:', JSON.stringify(dupErr))

  if (existing && existing.length > 0) {
    return { error: 'You already have a pending request for this person.' }
  }

  const { error } = await supabase.from('intro_requests').insert({
    requester_id: authUserId,
    target_user_id: targetUserId,
    status: 'pending',
    note: note || null,
  })

  console.log('[createIntroRequest] insert result — error:', JSON.stringify(error))

  if (error) return { error: error.message }
  return { success: true }
}

export async function getUserIntroRequests(userId: string) {
  const supabase = createClient()
  const profileId = await resolveProfileId(supabase, userId)

  const { data, error } = await supabase
    .from('intro_requests')
    .select('id, target_user_id, status, note, created_at')
    .eq('requester_id', profileId)
    .order('created_at', { ascending: false })

  return { data: data ?? [], error }
}

export async function adminGetPendingRequests() {
  const supabase = createClient()

  const { data: requests, error } = await supabase
    .from('intro_requests')
    .select('id, requester_id, target_user_id, status, note, created_at')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error || !requests) return { data: [], error }

  const allIds = [
    ...requests.map(r => r.requester_id),
    ...requests.map(r => r.target_user_id),
  ].filter(Boolean)

  const uniqueIds = Array.from(new Set(allIds))

  let profileMap: Record<string, any> = {}
  if (uniqueIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, title, company, role_type')
      .in('id', uniqueIds)
    for (const p of profiles ?? []) profileMap[p.id] = p
  }

  const enriched = requests.map(r => ({
    ...r,
    requester: profileMap[r.requester_id] ?? null,
    target: profileMap[r.target_user_id] ?? null,
  }))

  return { data: enriched, error: null }
}

export async function approveIntroRequest(requestId: string) {
  const supabase = createClient()

  const { data: req, error: fetchErr } = await supabase
    .from('intro_requests')
    .select('id, requester_id, target_user_id')
    .eq('id', requestId)
    .single()

  if (fetchErr || !req) return { error: fetchErr?.message ?? 'Request not found' }

  // Check requester's credit balance before creating the match
  const { data: creditRow } = await supabase
    .from('meeting_credits')
    .select('balance')
    .eq('user_id', req.requester_id)
    .single()

  const balance = creditRow?.balance ?? 0

  if (balance < 1) {
    // No credits — set a hold and mark accordingly
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    await supabase
      .from('intro_requests')
      .update({
        status: 'accepted_pending_payment',
        accepted_at: new Date().toISOString(),
        expires_at: expiresAt,
        credit_hold: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', requestId)
    return { success: true, status: 'accepted_pending_payment' }
  }

  // Approve the request and mark credit as charged
  const { error: updateErr } = await supabase
    .from('intro_requests')
    .update({
      status: 'approved',
      accepted_at: new Date().toISOString(),
      credit_charged: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)

  if (updateErr) return { error: updateErr.message }

  // Deduct 1 credit from the requester
  await supabase
    .from('meeting_credits')
    .update({ balance: balance - 1 })
    .eq('user_id', req.requester_id)

  // Log the credit transaction
  await supabase.from('credit_transactions').insert({
    user_id: req.requester_id,
    amount: -1,
    description: 'Introduction approved — match created',
  })

  // Create match (matches = source of truth for active connections)
  let matchId: string | null = null

  const { data: newMatch, error: matchErr } = await supabase
    .from('matches')
    .insert({ user_a_id: req.requester_id, user_b_id: req.target_user_id })
    .select('id')
    .single()

  if (newMatch) {
    matchId = newMatch.id
  } else {
    // Match may already exist — look it up
    const { data: existing } = await supabase
      .from('matches')
      .select('id')
      .or(
        `and(user_a_id.eq.${req.requester_id},user_b_id.eq.${req.target_user_id}),` +
        `and(user_a_id.eq.${req.target_user_id},user_b_id.eq.${req.requester_id})`
      )
      .limit(1)
      .single()
    if (existing) matchId = existing.id
    else if (matchErr) return { error: `Match failed: ${matchErr.message}` }
  }

  if (!matchId) return { error: 'Could not create or find match' }

  // Create conversation linked to this match
  const { data: existingConv } = await supabase
    .from('conversations')
    .select('id')
    .eq('match_id', matchId)
    .limit(1)
    .single()

  if (!existingConv) {
    const { error: convErr } = await supabase
      .from('conversations')
      .insert({ match_id: matchId })

    console.log('[approveIntroRequest] conversation created for matchId:', matchId, 'error:', JSON.stringify(convErr))
    if (convErr) return { error: `Approved but conversation failed: ${convErr.message}` }
  }

  return { success: true, status: 'approved' }
}

export async function rejectIntroRequest(requestId: string) {
  const supabase = createClient()

  const { error } = await supabase
    .from('intro_requests')
    .update({ status: 'rejected', updated_at: new Date().toISOString() })
    .eq('id', requestId)

  if (error) return { error: error.message }
  return { success: true }
}
