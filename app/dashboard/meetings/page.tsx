import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import MeetingsClient from '@/components/MeetingsClient'
import { assembleMeetings, meetingParticipantIds } from '@/lib/meetings/assemble'
import { discoverableMemberIds } from '@/lib/privacy/canViewerDiscoverMember'

export const metadata = { title: 'Meetings | Andrel' }

const MEETING_COLUMNS =
  'id, purpose, purpose_category, format, status, scheduled_at, duration_minutes, location, zoom_link, notes, requester_id, recipient_id, proposed_scheduled_at, proposed_duration_minutes, proposed_format, proposed_location, proposed_zoom_link, proposed_notes, updated_at'

export default async function MeetingsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // RELEASE A — connection-graph reads move to service_role so Release B can revoke browser
  // SELECT on public.matches / public.blocked_users. `graphClient` is scoped to THOSE READS
  // ONLY; the session client above still performs authentication and every other query. The
  // viewer constraint below is unchanged, and the id it filters on still comes from the
  // verified session — never from anything the browser supplied.
  const graphClient = createAdminClient()

  // ── Phase 1: matches + the user's meetings (independent → parallel) ──
  const [{ data: matchRows }, { data: meetingRows }] = await Promise.all([
    graphClient
      .from('matches')
      .select('id, user_a_id, user_b_id, status')
      .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`),
    supabase
      .from('meetings')
      .select(MEETING_COLUMNS)
      .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`)
      .order('scheduled_at', { ascending: true }),
  ])

  // The "schedule with" picker. Filtered to LIVE matches so the picker and the server agree about
  // who may be scheduled with: scheduleMeeting now refuses a removed/closed match, and offering one
  // here would produce an option that always errors. (This query previously selected no status at
  // all, so a removed connection stayed in the picker indefinitely.)
  const matchedUserIds = (matchRows || [])
    .filter((r: any) => r.status !== 'removed' && r.status !== 'closed')
    .map((r: any) => (r.user_a_id === user.id ? r.user_b_id : r.user_a_id))
    .filter(Boolean)

  // One profile fetch covers BOTH the "schedule with" picker (matched users) and
  // every meeting's other participant — no separate join-meetings query, no N+1.
  const profileIds = Array.from(new Set([
    ...matchedUserIds,
    ...meetingParticipantIds(meetingRows as any, user.id),
  ]))

  // ── DISCOVERABILITY GATE ON PROFILE HYDRATION ──────────────────────────────────────────────
  // The hydration below runs as service_role, which bypasses can_discover_profile entirely. That
  // was safe only while a meeting row could not name a stranger — which is exactly the assumption
  // scheduleMeeting failed to enforce. Any meeting row that predates the authorization fix can
  // still name someone the viewer was never introduced to, so the row must not be allowed to act
  // as a profile-lookup oracle for that member.
  //
  // Ids the viewer may genuinely discover are hydrated in full; everyone else collapses to an
  // id-only placeholder, so the meeting still renders (time, purpose, status, accept/decline) but
  // carries no name, title, company or avatar. This mirrors app/api/messages/list, which resolves
  // a non-discoverable sender to `{ id }` for the same reason.
  const discoverableIds = await discoverableMemberIds(graphClient, user.id, profileIds)
  const hydratableIds = profileIds.filter((id) => discoverableIds.has(id))

  // ── Phase 2: one batched profiles read + mark meeting notifs read (parallel) ──
  const [{ data: profiles }] = await Promise.all([
    hydratableIds.length > 0
      // A3: participant identities for the viewer's OWN meetings, read server-side via service_role
      // (base-table SELECT is revoked for the browser role). Authorized by DISCOVERABILITY, not by
      // the meeting row itself — see the gate above. Past-meeting display still survives a removed
      // match, because discoverableMemberIds also grants on the pair's intro_requests history, which
      // a real past meeting always has. Email intentionally dropped — the meetings UI does not use it.
      ? createAdminClient().from('profiles').select('id, full_name, title, company, avatar_url').in('id', hydratableIds)
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
  // Non-discoverable counterparts get an id-only placeholder rather than being dropped: the meeting
  // must still render and stay actionable. MeetingsClient reads `other?.full_name` and falls back to
  // a neutral avatar, so an id-only row degrades cleanly with no name shown.
  for (const id of profileIds) if (!profileById.has(id)) profileById.set(id, { id })

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
