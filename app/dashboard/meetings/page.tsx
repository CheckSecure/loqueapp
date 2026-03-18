import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import MeetingsClient from '@/components/MeetingsClient'

export const metadata = { title: 'Meetings | Cadre' }

export default async function MeetingsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: meetings, error: meetingsErr } = await supabase
    .from('meetings')
    .select(`
      id, title, scheduled_at, duration_minutes, meeting_type, location, organizer_id,
      organizer:profiles!organizer_id(id, full_name),
      attendee:profiles!attendee_id(id, full_name)
    `)
    .or(`organizer_id.eq.${user.id},attendee_id.eq.${user.id}`)
    .order('scheduled_at', { ascending: true })

  console.log('[Meetings] user.id:', user.id)
  console.log('[Meetings] error:', meetingsErr?.message ?? 'none')
  console.log('[Meetings] rows returned:', meetings?.length ?? 0, JSON.stringify(meetings?.map(m => m.title)))

  const enriched = (meetings || []).map((m: any) => {
    const isOrganizer = m.organizer_id === user.id
    const other = isOrganizer ? m.attendee : m.organizer
    return {
      id: m.id,
      title: m.title,
      scheduled_at: m.scheduled_at,
      duration_minutes: m.duration_minutes,
      meeting_type: m.meeting_type,
      location: m.location,
      other: other || null,
      isOrganizer,
      isPast: new Date(m.scheduled_at) < new Date(),
    }
  })

  const upcoming = enriched.filter(m => !m.isPast)
  const past = enriched.filter(m => m.isPast).reverse()

  return <MeetingsClient upcoming={upcoming} past={past} currentUserId={user.id} />
}
