import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const SARAH_ID = 'd0a53e22-a20a-4153-bb42-1ea5da1a35c7'
const JAMES_ID = '8aa6a609-ff94-42d8-8e51-a5662b149f25'
const PRIYA_ID = 'bced51ec-c837-40c2-b85d-d7b7386c9bc5'

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: alexProfileRows } = await supabase
    .from('profiles')
    .select('id')
    .or(`id.eq.${user.id},email.eq.${user.email}`)
    .limit(1)
  const alexProfileId = alexProfileRows?.[0]?.id ?? user.id

  const results: Record<string, any> = {}

  const conversationDefs = [
    {
      other: SARAH_ID,
      otherName: 'Sarah Mitchell',
      messages: [
        { sender: alexProfileId, text: "Hi Sarah! I noticed your background in capital markets -- I've been navigating a complex M&A deal and would love to pick your brain sometime." },
        { sender: SARAH_ID,      text: "Hi Alexandra! Of course, happy to chat. I've done dozens of deals at Skadden. What stage is the transaction at?" },
        { sender: alexProfileId, text: "We're in diligence right now. The target has some SEC disclosure questions I want to make sure we're handling correctly." },
        { sender: SARAH_ID,      text: "That's right in my wheelhouse. Let's schedule a call -- I have time Thursday or Friday afternoon." },
      ],
    },
    {
      other: JAMES_ID,
      otherName: 'James Okonkwo',
      messages: [
        { sender: JAMES_ID,      text: "Alexandra, great to connect! I saw you're in-house at a healthcare company -- always interesting to hear about the compliance landscape there." },
        { sender: alexProfileId, text: "Yes, it keeps us very busy! I'd love to hear how you built your legal team at Apex. We're thinking about scaling ours." },
        { sender: JAMES_ID,      text: "Happy to share. We went from 3 to 40 in about 4 years. The biggest unlock was hiring a great legal ops lead early." },
        { sender: alexProfileId, text: "That's really helpful context. Were you using any tech platforms to manage the workload during that growth phase?" },
        { sender: JAMES_ID,      text: "Yes -- we piloted three vendors and ultimately went with a contract lifecycle management tool. I can share more on our call." },
      ],
    },
    {
      other: PRIYA_ID,
      otherName: 'Priya Rajan',
      messages: [
        { sender: alexProfileId, text: "Hi Priya! Your background in legal ops at Google is exactly what I've been looking for. We're trying to improve our contract review process." },
        { sender: PRIYA_ID,      text: "Hey! I love this topic. Are you looking at AI-assisted review or more process redesign first?" },
        { sender: alexProfileId, text: "Probably both, but I think we need the process right before layering in tools." },
        { sender: PRIYA_ID,      text: "Exactly the right instinct. Tools amplify your process -- good or bad. Let me know if you want to walk through our framework." },
      ],
    },
  ]

  for (const def of conversationDefs) {
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .insert({})
      .select('id')
      .single()

    if (convErr || !conv) {
      results[def.otherName] = { error: convErr?.message ?? 'failed to create conversation' }
      continue
    }

    const { error: partErr } = await supabase
      .from('conversation_participants')
      .insert([
        { conversation_id: conv.id, user_id: user.id },
        { conversation_id: conv.id, user_id: def.other },
      ])

    if (partErr) {
      results[def.otherName] = { error: `participants: ${partErr.message}` }
      continue
    }

    const baseTime = Date.now() - 7 * 24 * 60 * 60 * 1000
    const msgInserts = def.messages.map((m, i) => ({
      conversation_id: conv.id,
      sender_id: m.sender === alexProfileId ? user.id : m.sender,
      content: m.text,
      created_at: new Date(baseTime + i * 4 * 60 * 60 * 1000).toISOString(),
    }))

    const { error: msgErr } = await supabase.from('messages').insert(msgInserts)

    results[def.otherName] = msgErr
      ? { error: `messages: ${msgErr.message}` }
      : { conversationId: conv.id, messages: msgInserts.length }
  }

  const now = new Date()
  const meetingDefs = [
    {
      label: 'Upcoming 1',
      row: {
        organizer_id: user.id,
        attendee_id: SARAH_ID,
        title: 'M&A Diligence Strategy Call',
        scheduled_at: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 45,
        meeting_type: 'video',
        location: 'Zoom',
      },
    },
    {
      label: 'Upcoming 2',
      row: {
        organizer_id: user.id,
        attendee_id: PRIYA_ID,
        title: 'Legal Ops Framework Discussion',
        scheduled_at: new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 30,
        meeting_type: 'video',
        location: 'Google Meet',
      },
    },
    {
      label: 'Past 1',
      row: {
        organizer_id: JAMES_ID,
        attendee_id: user.id,
        title: 'In-House Team Scaling: Lessons from Apex',
        scheduled_at: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 60,
        meeting_type: 'video',
        location: 'Zoom',
      },
    },
  ]

  for (const def of meetingDefs) {
    const { error: mtgErr } = await supabase.from('meetings').insert(def.row)
    results[`Meeting: ${def.label}`] = mtgErr
      ? { error: mtgErr.message }
      : { ok: true, title: def.row.title }
  }

  return NextResponse.json({ alexAuthId: user.id, alexProfileId, results })
}
