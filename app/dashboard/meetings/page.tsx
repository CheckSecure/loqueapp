import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import MeetingsClient from '@/components/MeetingsClient'

export const metadata = { title: 'Meetings | Cadre' }

export default async function MeetingsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Step 1: get all meetings where user is organizer or attendee
  const { data: meetingRows, error: meetingsErr } = await supabase
    .from('meetings')
    .select('id, title, scheduled_at, duration_minutes, meeting_type, location, organizer_id, attendee_id')
    .or(`organizer_id.eq.${user.id},attendee_id.eq.${user.id}`)
    .order('scheduled_at', { ascending: true })

  console.log('[Meetings] error:', meetingsErr?.message ?? 'none')
  console.log('[Meetings] rows:', meetingRows?.length ?? 0)

  // Step 2: collect the other user IDs and look up their profiles
  const otherIds = (meetingRows || []).map((m: any) =>
    m.organizer_id === user.id ? m.attendee_id : m.organizer_id
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
    const isOrganizer = m.organizer_id === user.id
    const otherId = isOrganizer ? m.attendee_id : m.organizer_id
    return {
      id: m.id,
      title: m.title,
      scheduled_at: m.scheduled_at,
      duration_minutes: m.duration_minutes,
      meeting_type: m.meeting_type,
      location: m.location,
      other: profileById[otherId] ?? null,
      isOrganizer,
      isPast: new Date(m.scheduled_at) < new Date(),
    }
  })

  const upcoming = enriched.filter(m => !m.isPast)
  const past = enriched.filter(m => m.isPast).reverse()

  return <MeetingsClient upcoming={upcoming} past={past} currentUserId={user.id} />
}
