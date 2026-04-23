import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateIcebreakers, generateSystemIntroMessage } from '@/lib/messaging/icebreakers'

// Creates a conversation for an existing match if one doesn't already exist.
// Idempotent: if a conversation already exists for the match, returns its id.
// Only participants of the match can trigger this.
export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { matchId } = await req.json().catch(() => ({}))
  if (!matchId) return NextResponse.json({ error: 'matchId required' }, { status: 400 })

  const admin = createAdminClient()

  // Verify match and that user is a participant
  const { data: match, error: matchErr } = await admin
    .from('matches')
    .select('id, user_a_id, user_b_id, status')
    .eq('id', matchId)
    .maybeSingle()

  if (matchErr || !match) return NextResponse.json({ error: 'Match not found' }, { status: 404 })
  if (match.user_a_id !== user.id && match.user_b_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (match.status === 'removed') {
    return NextResponse.json({ error: 'Match is inactive' }, { status: 409 })
  }

  // Existing conversation? Return it.
  const { data: existing } = await admin
    .from('conversations')
    .select('id')
    .eq('match_id', matchId)
    .maybeSingle()

  if (existing) {
    return NextResponse.json({ conversationId: existing.id, created: false })
  }

  // Create new conversation
  const { data: newConv, error: convErr } = await admin
    .from('conversations')
    .insert({ match_id: matchId })
    .select('id')
    .single()

  if (convErr || !newConv) {
    console.error('[conversations/create] insert failed:', convErr)
    return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
  }

  // Enrich with icebreakers + system intro message, same pattern as express-interest
  try {
    const otherUserId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id

    const { data: selfProfile } = await admin
      .from('profiles').select('*').eq('id', user.id).single()
    const { data: otherProfile } = await admin
      .from('profiles').select('*').eq('id', otherUserId).single()

    const prompts = generateIcebreakers({
      userA: selfProfile || ({} as any),
      userB: otherProfile || ({} as any)
    })

    await admin
      .from('conversations')
      .update({ suggested_prompts: prompts })
      .eq('id', newConv.id)

    const systemContent = generateSystemIntroMessage({
      userA: selfProfile || ({} as any),
      userB: otherProfile || ({} as any),
      reason: 'Network connection'
    })

    await admin.from('messages').insert({
      conversation_id: newConv.id,
      sender_id: null,
      is_system: true,
      content: systemContent,
      created_at: new Date().toISOString()
    })
  } catch (e) {
    console.error('[conversations/create] enrichment failed, but conversation exists:', e)
  }

  return NextResponse.json({ conversationId: newConv.id, created: true })
}
