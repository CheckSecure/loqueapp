import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import MeetingsClient from '@/components/MeetingsClient'

export const metadata = { title: 'Meetings | Cadre' }

export default async function MeetingsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const now = new Date().toISOString()

  const { data: meetings } = await supabase
    .from('meetings')
    .select(`
      id, title, scheduled_at, duration_minutes, meeting_type, location,
      organizer:profiles!organizer_id(id, full_name, avatar_color),
      attendee:profiles!attendee_id(id, full_name, avatar_color)
    `)
    .or(`organizer_id.eq.${user.id},attendee_id.eq.${user.id}`)
    .order('scheduled_at', { ascending: true })

  const enriched = (meetings || []).map((m: any) => ({
    ...m,
    isPast: new Date(m.scheduled_at) < new Date(),
    other: m.organizer?.id === user.id ? m.attendee : m.organizer,
    isOrganizer: m.organizer?.id === user.id,
  }))

  const upcoming = enriched.filter(m => !m.isPast)
  const past = enriched.filter(m => m.isPast).reverse()

  return <MeetingsClient upcoming={upcoming} past={past} currentUserId={user.id} />
}
