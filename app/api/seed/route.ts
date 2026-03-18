import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const SARAH_ID = 'd0a53e22-a20a-4153-bb42-1ea5da1a35c7'
const JAMES_ID = '8aa6a609-ff94-42d8-8e51-a5662b149f25'
const PRIYA_ID = 'bced51ec-c837-40c2-b85d-d7b7386c9bc5'

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const results: Record<string, any> = {}

  // ── CONVERSATIONS + MESSAGES ─────────────────────────────────────────────
  // Schema: matches(user1_id, user2_id) → conversations(match_id) → messages

  const conversationDefs = [
    {
      otherId: SARAH_ID,
      label: 'Sarah Mitchell',
      messages: [
        { from: 'alex', text: "Hi Sarah! I noticed your background in capital markets -- I've been navigating a complex M&A deal and would love to pick your brain sometime." },
        { from: 'other', text: "Hi Alexandra! Of course, happy to chat. I've done dozens of deals at Skadden. What stage is the transaction at?" },
        { from: 'alex', text: "We're in diligence right now. The target has some SEC disclosure questions I want to make sure we're handling correctly." },
        { from: 'other', text: "That's right in my wheelhouse. Let's schedule a call -- I have time Thursday or Friday afternoon." },
      ],
    },
    {
      otherId: JAMES_ID,
      label: 'James Okonkwo',
      messages: [
        { from: 'other', text: "Alexandra, great to connect! I saw you're in-house at a healthcare company -- always interesting to hear about the compliance landscape there." },
        { from: 'alex', text: "Yes, it keeps us very busy! I'd love to hear how you built your legal team at Apex. We're thinking about scaling ours." },
        { from: 'other', text: "Happy to share. We went from 3 to 40 in about 4 years. The biggest unlock was hiring a great legal ops lead early." },
        { from: 'alex', text: "That's really helpful context. Were you using any tech platforms to manage the workload during that growth phase?" },
        { from: 'other', text: "Yes -- we piloted three vendors and ultimately went with a contract lifecycle management tool. I can share more on our call." },
      ],
    },
    {
      otherId: PRIYA_ID,
      label: 'Priya Rajan',
      messages: [
        { from: 'alex', text: "Hi Priya! Your background in legal ops at Google is exactly what I've been looking for. We're trying to improve our contract review process." },
        { from: 'other', text: "Hey! I love this topic. Are you looking at AI-assisted review or more process redesign first?" },
        { from: 'alex', text: "Probably both, but I think we need the process right before layering in tools." },
        { from: 'other', text: "Exactly the right instinct. Tools amplify your process -- good or bad. Let me know if you want to walk through our framework." },
      ],
    },
  ]

  const baseTime = Date.now() - 7 * 24 * 60 * 60 * 1000

  for (const def of conversationDefs) {
    // 1. Create a match between Alexandra and the other user
    const { data: match, error: matchErr } = await supabase
      .from('matches')
      .insert({ user_a_id: user.id, user_b_id: def.otherId })
      .select('id')
      .single()

    if (matchErr || !match) {
      results[def.label] = { error: `match: ${matchErr?.message ?? 'unknown'}` }
      continue
    }

    // 2. Create a conversation linked to that match
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .insert({ match_id: match.id })
      .select('id')
      .single()

    if (convErr || !conv) {
      results[def.label] = { error: `conversation: ${convErr?.message ?? 'unknown'}` }
      continue
    }

    // 3. Insert messages with realistic timestamps
    const msgInserts = def.messages.map((m, i) => ({
      conversation_id: conv.id,
      sender_id: m.from === 'alex' ? user.id : def.otherId,
      content: m.text,
      created_at: new Date(baseTime + i * 4 * 60 * 60 * 1000).toISOString(),
    }))

    const { error: msgErr } = await supabase.from('messages').insert(msgInserts)

    results[def.label] = msgErr
      ? { error: `messages: ${msgErr.message}` }
      : { matchId: match.id, conversationId: conv.id, messages: msgInserts.length }
  }

  // ── MEETINGS ─────────────────────────────────────────────────────────────

  const now = new Date()
  const meetingDefs = [
    {
      label: 'Upcoming: M&A Diligence Call',
      row: {
        requester_id: user.id,
        recipient_id: SARAH_ID,
        purpose: 'M&A diligence strategy call',
        format: 'video',
        status: 'scheduled',
        scheduled_at: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 45,
        location: 'Zoom',
      },
    },
    {
      label: 'Upcoming: Legal Ops Discussion',
      row: {
        requester_id: user.id,
        recipient_id: PRIYA_ID,
        purpose: 'Legal ops framework discussion',
        format: 'video',
        status: 'scheduled',
        scheduled_at: new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 30,
        location: 'Google Meet',
      },
    },
    {
      label: 'Past: Apex Scaling Session',
      row: {
        requester_id: JAMES_ID,
        recipient_id: user.id,
        purpose: 'In-house team scaling: lessons from Apex',
        format: 'video',
        status: 'completed',
        scheduled_at: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 60,
        location: 'Zoom',
      },
    },
  ]

  for (const def of meetingDefs) {
    const { error: mtgErr } = await supabase.from('meetings').insert(def.row)
    results[def.label] = mtgErr
      ? { error: mtgErr.message }
      : { ok: true, purpose: def.row.purpose }
  }

  return NextResponse.json({ userId: user.id, results })
}
