import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * PHASE 1 SECURITY REGRESSION — a meeting row must not become a profile-lookup oracle.
 *
 * /dashboard/meetings hydrates each meeting's counterpart (full_name, title, company, avatar_url)
 * through the SERVICE-ROLE client, which bypasses can_discover_profile entirely. That was only safe
 * while a meeting row could not name a stranger — precisely the assumption scheduleMeeting failed to
 * enforce. Rows created before the authorization fix can still name someone the viewer was never
 * introduced to, so hydration is now gated on discoverability and non-discoverable counterparts
 * collapse to an id-only placeholder.
 *
 * What these tests pin:
 *   1. the service-role profiles read is issued ONLY for discoverable ids;
 *   2. a non-discoverable counterpart still renders its meeting, but carries no identity;
 *   3. the "schedule with" picker offers only LIVE matches, so it agrees with the server gate.
 */

const cfg = vi.hoisted(() => ({
  user: { id: 'me' } as any,
  matchRows: [] as any[],
  meetingRows: [] as any[],
  discoverable: new Set<string>(),
  profileRows: [] as any[],
}))

/** Every id list this page asked the profiles table to hydrate. */
const profileReadIds = vi.hoisted(() => [] as string[][])


vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: cfg.user } }) },
    from: (table: string) => {
      const b: any = {
        select: () => b, eq: () => b, or: () => b, in: () => b, is: () => b,
        update: () => b,
        order: async () => ({ data: table === 'meetings' ? cfg.meetingRows : [], error: null }),
        then: (res: any, rej: any) => Promise.resolve({ data: [], error: null }).then(res, rej),
      }
      return b
    },
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const b: any = {
        select: () => b, eq: () => b, or: () => b, is: () => b, update: () => b,
        in: (_col: string, ids: string[]) => {
          if (table === 'profiles') profileReadIds.push([...ids])
          return b
        },
        order: async () => ({ data: [], error: null }),
        then: (res: any, rej: any) => {
          let out: any = { data: [], error: null }
          if (table === 'matches') out = { data: cfg.matchRows, error: null }
          else if (table === 'profiles') {
            const asked = profileReadIds[profileReadIds.length - 1] ?? []
            out = { data: cfg.profileRows.filter((p) => asked.includes(p.id)), error: null }
          }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return b
    },
  }),
}))

// The authority under test is invoked, not reimplemented — the page must delegate to it.
vi.mock('@/lib/privacy/canViewerDiscoverMember', () => ({
  discoverableMemberIds: async (_db: any, _viewer: string, ids: string[]) =>
    new Set(ids.filter((id) => cfg.discoverable.has(id))),
}))

vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('redirect') } }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
// Stubbed so the page's returned element is a plain descriptor we can read props off. A server
// component RETURNS an element; React never calls the child, so the props must be read from the
// returned element rather than captured inside a mock body.
vi.mock('@/components/MeetingsClient', () => ({ default: () => null }))

import MeetingsPage from '@/app/dashboard/meetings/page'

const meeting = (id: string, otherId: string) => ({
  id, purpose: 'Coffee', purpose_category: null, format: 'virtual', status: 'confirmed',
  scheduled_at: '2030-01-01T10:00:00.000Z', duration_minutes: 30, location: null, zoom_link: null,
  notes: null, requester_id: 'me', recipient_id: otherId,
  proposed_scheduled_at: null, proposed_duration_minutes: null, proposed_format: null,
  proposed_location: null, proposed_zoom_link: null, proposed_notes: null, updated_at: null,
})

const profile = (id: string, name: string) => ({
  id, full_name: name, title: 'GC', company: 'Acme', avatar_url: null,
})

beforeEach(() => {
  cfg.user = { id: 'me' }
  cfg.matchRows = []
  cfg.meetingRows = []
  cfg.discoverable = new Set()
  cfg.profileRows = []
  profileReadIds.length = 0
})

/** Render the page and return the props it hands to MeetingsClient — i.e. what reaches the browser. */
async function render() {
  const element: any = await MeetingsPage()
  return element.props
}

describe('meetings page — hydration is gated on discoverability', () => {
  it('a discoverable counterpart is hydrated in full (existing behaviour preserved)', async () => {
    cfg.matchRows = [{ id: 'm1', user_a_id: 'me', user_b_id: 'friend', status: 'active' }]
    cfg.meetingRows = [meeting('mt1', 'friend')]
    cfg.discoverable = new Set(['friend'])
    cfg.profileRows = [profile('friend', 'Real Friend')]

    const props = await render()
    expect(props.upcoming[0].other).toMatchObject({ id: 'friend', full_name: 'Real Friend', company: 'Acme' })
  })

  it('a NON-discoverable counterpart is never asked for from the profiles table', async () => {
    // A meeting naming someone the viewer has no relationship with — the exact shape a forged
    // pre-fix scheduleMeeting call produced.
    cfg.meetingRows = [meeting('mt1', 'stranger')]
    cfg.discoverable = new Set()
    cfg.profileRows = [profile('stranger', 'Should Not Leak')]

    await render()
    for (const ids of profileReadIds) expect(ids).not.toContain('stranger')
  })

  it('the meeting still renders, but carries no identity for that counterpart', async () => {
    cfg.meetingRows = [meeting('mt1', 'stranger')]
    cfg.discoverable = new Set()
    cfg.profileRows = [profile('stranger', 'Should Not Leak')]

    const props = await render()
    expect(props.upcoming).toHaveLength(1)                 // the meeting is not hidden
    expect(props.upcoming[0].other).toEqual({ id: 'stranger' })  // …but it is anonymous
    expect(JSON.stringify(props)).not.toContain('Should Not Leak')
  })

  it('mixed: the discoverable one is hydrated, the stranger is not', async () => {
    cfg.matchRows = [{ id: 'm1', user_a_id: 'me', user_b_id: 'friend', status: 'active' }]
    cfg.meetingRows = [meeting('mt1', 'friend'), meeting('mt2', 'stranger')]
    cfg.discoverable = new Set(['friend'])
    cfg.profileRows = [profile('friend', 'Real Friend'), profile('stranger', 'Should Not Leak')]

    const props = await render()
    const byId = Object.fromEntries(props.upcoming.map((m: any) => [m.id, m.other]))
    expect(byId.mt1).toMatchObject({ full_name: 'Real Friend' })
    expect(byId.mt2).toEqual({ id: 'stranger' })
    expect(JSON.stringify(props)).not.toContain('Should Not Leak')
  })

  it('a past meeting with a since-removed match still shows the name when discovery survives', async () => {
    // Removed matches do not grant discovery via the match branch, but the pair's intro_requests
    // history does — which is what discoverableMemberIds returns here. Past-meeting display must
    // not regress.
    cfg.matchRows = [{ id: 'm1', user_a_id: 'me', user_b_id: 'former', status: 'removed' }]
    cfg.meetingRows = [{ ...meeting('mt1', 'former'), scheduled_at: '2020-01-01T10:00:00.000Z' }]
    cfg.discoverable = new Set(['former'])
    cfg.profileRows = [profile('former', 'Former Connection')]

    const props = await render()
    expect(props.past).toHaveLength(1)
    expect(props.past[0].other).toMatchObject({ full_name: 'Former Connection' })
  })
})

describe('meetings page — the "schedule with" picker agrees with the server gate', () => {
  it('offers live matches', async () => {
    cfg.matchRows = [{ id: 'm1', user_a_id: 'me', user_b_id: 'friend', status: 'active' }]
    cfg.discoverable = new Set(['friend'])
    cfg.profileRows = [profile('friend', 'Real Friend')]

    const props = await render()
    expect(props.matchedUsers.map((u: any) => u.id)).toEqual(['friend'])
  })

  it('does NOT offer a removed match — scheduleMeeting would refuse it', async () => {
    cfg.matchRows = [{ id: 'm1', user_a_id: 'me', user_b_id: 'gone', status: 'removed' }]
    cfg.discoverable = new Set(['gone'])
    cfg.profileRows = [profile('gone', 'Removed Connection')]

    const props = await render()
    expect(props.matchedUsers).toHaveLength(0)
  })

  it('does NOT offer a closed match', async () => {
    cfg.matchRows = [{ id: 'm1', user_a_id: 'me', user_b_id: 'gone', status: 'closed' }]
    cfg.discoverable = new Set(['gone'])
    cfg.profileRows = [profile('gone', 'Closed Connection')]

    const props = await render()
    expect(props.matchedUsers).toHaveLength(0)
  })
})
