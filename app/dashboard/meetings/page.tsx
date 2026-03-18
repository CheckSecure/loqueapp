import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import MeetingsClient from '@/components/MeetingsClient'

export const metadata = { title: 'Meetings | Cadre' }

export default async function MeetingsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Meetings where user is requester or recipient
  const { data: meetingRows } = await supabase
    .from('meetings')
    .select('id, purpose, format, status, scheduled_at, duration_minutes, location, requester_id, recipient_id')
    .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`)
    .order('scheduled_at', { ascending: true })

  const otherIds = (meetingRows || []).map((m: any) =>
    m.requester_id === user.id ? m.recipient_id : m.requester_id
  ).filter(Boolean)

  let profileById: Record<string, any> = {}
  if (otherIds.length > 0) {
    const { data: profileRows } = await supabase
      .from('profiles')
      .select('id, full_name, title, company, avatar_color')
      .in('id', otherIds)
    for (const p of profileRows || []) profileById[p.id] = p
  }

  const enriched = (meetingRows || []).map((m: any) => {
    const isRequester = m.requester_id === user.id
    const otherId = isRequester ? m.recipient_id : m.requester_id
    return {
      id: m.id,
      title: m.purpose,
      scheduled_at: m.scheduled_at,
      duration_minutes: m.duration_minutes,
      meeting_type: m.format,
      status: m.status,
      location: m.location,
      other: profileById[otherId] ?? null,
      isOrganizer: isRequester,
      isPast: new Date(m.scheduled_at) < new Date(),
    }
  })

  const upcoming = enriched.filter((m: any) => !m.isPast)
  const past = enriched.filter((m: any) => m.isPast).reverse()

  // Fetch matches so the modal can populate the "meeting with" dropdown
  const { data: matchRows } = await supabase
    .from('matches')
    .select('id, user_a_id, user_b_id')
    .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`)

  const matchedUserIds = (matchRows || []).map((r: any) =>
    r.user_a_id === user.id ? r.user_b_id : r.user_a_id
  )

  let matchedUsers: { id: string; full_name: string; title?: string; company?: string }[] = []
  if (matchedUserIds.length > 0) {
    const { data: matchedProfiles } = await supabase
      .from('profiles')
      .select('id, full_name, title, company')
      .in('id', matchedUserIds)
    matchedUsers = matchedProfiles || []
  }

  return (
    <MeetingsClient
      upcoming={upcoming}
      past={past}
      currentUserId={user.id}
      matchedUsers={matchedUsers}
    />
  )
}
