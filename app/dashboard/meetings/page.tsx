import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import MeetingsClient from '@/components/MeetingsClient'

export const metadata = { title: 'Meetings | Andrel' }

export default async function MeetingsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // ── 1–4. Fetch matches, meetings, join-meetings, and notifications in parallel ──
  const [
    { data: matchRows },
    { data: meetingRows, error: meetingErr },
    { data: joinRows, error: joinErr },
    { data: unreadMeetingNotifs },
  ] = await Promise.all([
    supabase
      .from('matches')
      .select('id, user_a_id, user_b_id')
      .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`),
    supabase
      .from('meetings')
      .select('id, purpose, purpose_category, format, status, scheduled_at, duration_minutes, location, zoom_link, notes, requester_id, recipient_id, proposed_scheduled_at, proposed_duration_minutes, proposed_format, proposed_location, proposed_zoom_link, proposed_notes, updated_at')
      .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`)
      .order('scheduled_at', { ascending: true }),
    supabase
      .from('meetings')
      .select(`
      id,
      requester:profiles!requester_id(id, full_name),
      recipient:profiles!recipient_id(id, full_name)
    `)
      .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`),
    supabase
      .from('notifications')
      .select('type, created_at')
      .eq('user_id', user.id)
      .in('type', ['meeting_request', 'meeting_accepted', 'meeting_declined'])
      .is('read_at', null),
  ])

  const matchedUserIds = (matchRows || []).map((r: any) =>
    r.user_a_id === user.id ? r.user_b_id : r.user_a_id
  ).filter(Boolean)

  // ── 2. Fetch profiles for all matched users ───────────────────────────────
  let profileById: Record<string, any> = {}
  let matchedUsers: { id: string; full_name: string; title?: string; company?: string }[] = []

  if (matchedUserIds.length > 0) {
    const { data: matchedProfiles } = await supabase
      .from('profiles')
      .select('id, full_name, title, company')
      .in('id', matchedUserIds)
    for (const p of matchedProfiles || []) profileById[p.id] = p
    matchedUsers = matchedProfiles || []
  }

  console.log('[Meetings] user.id:', user.id)
  console.log('[Meetings] matchedUserIds:', JSON.stringify(matchedUserIds))
  console.log('[Meetings] profileById keys:', Object.keys(profileById))

  console.log('[Meetings] joinErr:', joinErr?.message ?? 'none')

  // Build an extra profile map from the join result (may be null if join unsupported)
  const joinProfileById: Record<string, any> = {}
  if (!joinErr) {
    for (const row of joinRows || []) {
      const pick = (val: any) => Array.isArray(val) ? val[0] : val
      const req = pick(row.requester)
      const rec = pick(row.recipient)
      if (req?.id) joinProfileById[req.id] = req
      if (rec?.id) joinProfileById[rec.id] = rec
    }
  }

  // Merge join profiles into the main map
  for (const [id, p] of Object.entries(joinProfileById)) {
    if (!profileById[id]) profileById[id] = p
  }

  console.log('[Meetings] final profileById keys:', Object.keys(profileById))

  // ── 5. Enrich meetings with "other" person ────────────────────────────────
  const enriched = (meetingRows || []).map((m: any) => {
    const isRequester = m.requester_id === user.id
    const otherId = isRequester ? m.recipient_id : m.requester_id
    const other = profileById[otherId] ?? null
    console.log('[Meetings] meeting', m.id, '→ otherId:', otherId, 'other:', JSON.stringify(other))
    return {
      id: m.id,
      title: m.purpose,
      purpose_category: m.purpose_category ?? null,
      scheduled_at: m.scheduled_at,
      duration_minutes: m.duration_minutes,
      meeting_type: m.format,
      status: m.status,
      location: m.location,
      zoom_link: m.zoom_link ?? null,
      notes: m.notes ?? null,
      proposed_scheduled_at: m.proposed_scheduled_at ?? null,
      proposed_duration_minutes: m.proposed_duration_minutes ?? null,
      proposed_format: m.proposed_format ?? null,
      proposed_location: m.proposed_location ?? null,
      proposed_zoom_link: m.proposed_zoom_link ?? null,
      proposed_notes: m.proposed_notes ?? null,
      other,
      isOrganizer: isRequester,
      isPast: new Date(m.scheduled_at) < new Date(),
      isNew: (m.status === 'requested' || m.status === 'reschedule_requested') && !isRequester,
    }
  })

  const upcoming = enriched.filter((m: any) => !m.isPast)
  const past = enriched.filter((m: any) => m.isPast).reverse()

  // Meetings created/updated in last 24h with unread notifs are "new"
  const hasUnreadNotif = (unreadMeetingNotifs || []).length > 0
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Mark meeting notifications as read
  await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .in('type', ['meeting_request', 'meeting_accepted', 'meeting_declined'])
    .is('read_at', null)

  revalidatePath('/dashboard')

  return (
    <MeetingsClient
      upcoming={upcoming}
      past={past}
      currentUserId={user.id}
      matchedUsers={matchedUsers}
    />
  )
}
