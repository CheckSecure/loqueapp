import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import MeetingsClient from '@/components/MeetingsClient'

export const metadata = { title: 'Meetings | Cadre' }

export default async function MeetingsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Step 1: get all meetings where user is requester or recipient
  const { data: meetingRows } = await supabase
    .from('meetings')
    .select('id, title, scheduled_at, duration_minutes, purpose, location, requester_id, recipient_id')
    .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`)
    .order('scheduled_at', { ascending: true })

  // Step 2: look up the other person's profile
  const otherIds = (meetingRows || []).map((m: any) =>
    m.requester_id === user.id ? m.recipient_id : m.requester_id
  ).filter(Boolean)

  let profileById: Record<string, any> = {}
  if (otherIds.length > 0) {
    const { data: profileRows } = await supabase
      .from('profiles')
      .select('id, full_name, title, company')
      .in('id', otherIds)
    for (const p of profileRows || []) profileById[p.id] = p
  }

  const enriched = (meetingRows || []).map((m: any) => {
    const isRequester = m.requester_id === user.id
    const otherId = isRequester ? m.recipient_id : m.requester_id
    return {
      id: m.id,
      title: m.title,
      scheduled_at: m.scheduled_at,
      duration_minutes: m.duration_minutes,
      meeting_type: m.purpose,
      location: m.location,
      other: profileById[otherId] ?? null,
      isOrganizer: isRequester,
      isPast: new Date(m.scheduled_at) < new Date(),
    }
  })

  const upcoming = enriched.filter(m => !m.isPast)
  const past = enriched.filter(m => m.isPast).reverse()

  return <MeetingsClient upcoming={upcoming} past={past} currentUserId={user.id} />
}
