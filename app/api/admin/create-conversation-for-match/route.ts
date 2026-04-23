import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateIcebreakers, generateSystemIntroMessage } from '@/lib/messaging/icebreakers'

export async function POST(req: Request) {
  const { error, user } = await requireAdmin()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const matchId = typeof body.matchId === 'string' ? body.matchId : ''
  if (!matchId) return NextResponse.json({ error: 'matchId required' }, { status: 400 })

  const admin = createAdminClient()

  const { data: match } = await admin
    .from('matches')
    .select('id, user_a_id, user_b_id, status')
    .eq('id', matchId)
    .maybeSingle()

  if (!match) return NextResponse.json({ error: 'Match not found' }, { status: 404 })
  if (match.status === 'removed') {
    return NextResponse.json({ error: 'Match is removed; restore it first' }, { status: 409 })
  }

  const { data: existing } = await admin
    .from('conversations')
    .select('id')
    .eq('match_id', matchId)
    .maybeSingle()
  if (existing) {
    return NextResponse.json({ success: true, conversationId: existing.id, alreadyExisted: true })
  }

  const { data: newConv, error: convErr } = await admin
    .from('conversations')
    .insert({ match_id: matchId })
    .select('id')
    .single()
  if (convErr || !newConv) {
    console.error('[admin/create-conversation-for-match] insert failed:', convErr)
    return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
  }

  try {
    const { data: profileA } = await admin.from('profiles').select('*').eq('id', match.user_a_id).single()
    const { data: profileB } = await admin.from('profiles').select('*').eq('id', match.user_b_id).single()
    const prompts = generateIcebreakers({ userA: profileA || ({} as any), userB: profileB || ({} as any) })
    await admin.from('conversations').update({ suggested_prompts: prompts }).eq('id', newConv.id)

    const systemContent = generateSystemIntroMessage({
      userA: profileA || ({} as any),
      userB: profileB || ({} as any),
      reason: 'Admin-restored conversation'
    })
    await admin.from('messages').insert({
      conversation_id: newConv.id,
      sender_id: null,
      is_system: true,
      content: systemContent,
      created_at: new Date().toISOString()
    })
  } catch (e) {
    console.error('[admin/create-conversation-for-match] enrichment error:', e)
  }

  console.log('[admin/create-conversation-for-match]', { by: user?.email, matchId, conversationId: newConv.id })
  return NextResponse.json({ success: true, conversationId: newConv.id, alreadyExisted: false })
}
