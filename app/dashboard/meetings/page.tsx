import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import MeetingsClient from '@/components/MeetingsClient'
import { assembleMeetings, meetingParticipantIds } from '@/lib/meetings/assemble'

export const metadata = { title: 'Meetings | Andrel' }

const MEETING_COLUMNS =
  'id, purpose, purpose_category, format, status, scheduled_at, duration_minutes, location, zoom_link, notes, requester_id, recipient_id, proposed_scheduled_at, proposed_duration_minutes, proposed_format, proposed_location, proposed_zoom_link, proposed_notes, updated_at'

export default async function MeetingsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // ── Phase 1: matches + the user's meetings (independent → parallel) ──
  const [{ data: matchRows }, { data: meetingRows }] = await Promise.all([
    supabase
      .from('matches')
      .select('id, user_a_id, user_b_id')
      .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`),
    supabase
      .from('meetings')
      .select(MEETING_COLUMNS)
      .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`)
      .order('scheduled_at', { ascending: true }),
  ])

  const matchedUserIds = (matchRows || [])
    .map((r: any) => (r.user_a_id === user.id ? r.user_b_id : r.user_a_id))
    .filter(Boolean)

  // One profile fetch covers BOTH the "schedule with" picker (matched users) and
  // every meeting's other participant — no separate join-meetings query, no N+1.
  const profileIds = Array.from(new Set([
    ...matchedUserIds,
    ...meetingParticipantIds(meetingRows as any, user.id),
  ]))

  // ── Phase 2: one batched profiles read + mark meeting notifs read (parallel) ──
  const [{ data: profiles }] = await Promise.all([
    profileIds.length > 0
      ? supabase.from('profiles').select('id, full_name, title, company, avatar_url').in('id', profileIds)
      : Promise.resolve({ data: [] as any[] }),
    // Clears the Meetings unread badge. Independent of the read above; runs in
    // parallel so it is not an extra sequential round-trip on the render path.
    supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .in('type', ['meeting_request', 'meeting_accepted', 'meeting_declined'])
      .is('read_at', null),
  ])

  const profileById = new Map((profiles || []).map((p: any) => [p.id, p]))
  const matchedIdSet = new Set(matchedUserIds)
  const matchedUsers = (profiles || []).filter((p: any) => matchedIdSet.has(p.id))

  const { upcoming, past } = assembleMeetings(meetingRows as any, profileById, user.id, Date.now())

  revalidatePath('/dashboard')

  return (
    <MeetingsClient
      // Cast at the boundary: EnrichedMeeting is runtime-compatible with the
      // client's Meeting/MeetingDetail shape (all fields preserved); the client
      // owns that type. Matches the page's pre-existing loose typing.
      upcoming={upcoming as any}
      past={past as any}
      currentUserId={user.id}
      matchedUsers={matchedUsers as any}
    />
  )
}
