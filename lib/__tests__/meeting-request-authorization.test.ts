import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * PHASE 1 SECURITY REGRESSION — `scheduleMeeting` must authorize the recipient.
 *
 * The defect: `recipient_id` came straight from the submitted FormData and the meeting was inserted
 * with the service-role client with NO relationship check. The Schedule modal only offers matched
 * members, so the product looked correct, but the server accepted any UUID — producing a meetings
 * row, a notification, and an email carrying the requester's real name, addressed to a member who
 * had never been introduced to them.
 *
 * These tests assert the property that actually matters: on refusal NOTHING happens. Not "an error
 * is returned" — no row, no notification, no email. The `writes` / `emails` ledgers are what prove
 * it, exactly as lib/__tests__/p0-service-role-authz.test.ts does for the admin-gated actions.
 */

// Real UUIDs: canRequestMeetingWith rejects anything that is not one, because both ids are
// interpolated into PostgREST filter strings. Hoisted because the vi.hoisted config below — which
// itself runs before the module body — references ME.
const ME = vi.hoisted(() => '11111111-1111-4111-8111-111111111111')
const THEM = vi.hoisted(() => '22222222-2222-4222-8222-222222222222')
const STRANGER = vi.hoisted(() => '33333333-3333-4333-8333-333333333333')
const ALICE = vi.hoisted(() => '44444444-4444-4444-8444-444444444444')
const BOB = vi.hoisted(() => '55555555-5555-4555-8555-555555555555')

// vi.mock factories are hoisted above every const in this file, and app/actions.ts pulls named
// imports off the mocked @/lib/email at module load — so the ledgers must exist before hoisting.
// vi.hoisted is the supported way to declare state a mock factory closes over.
const cfg = vi.hoisted(() => ({
  user: { id: ME, email: 'me@x.com' } as any,
  matches: [] as any[],          // rows returned for the bidirectional match lookup
  blocks: [] as any[],           // rows returned for the bidirectional block lookup
  profiles: [] as any[],         // rows returned for the account_status lookup
  rateLimit: { status: 'allowed', retryAfterSeconds: 60, count: 1 } as any,
  matchesError: null as any,
  profilesError: null as any,
  meeting: null as any,          // row the user-scoped client returns for a meetings lookup
}))

const writes = vi.hoisted(() => [] as any[])
const emails = vi.hoisted(() => [] as any[])
const rateLimitCalls = vi.hoisted(() => [] as any[])

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: cfg.user } }) },
    from: () => {
      const b: any = {
        select: () => b, eq: () => b, in: () => b, or: () => b, limit: () => b, order: () => b,
        single: async () => ({ data: cfg.meeting, error: cfg.meeting ? null : { message: 'not found' } }),
        maybeSingle: async () => ({ data: cfg.meeting, error: null }),
      }
      return b
    },
  }),
}))

// The service-role client. Every read the authorization helper performs is answered from `cfg`;
// every write is recorded rather than performed, so a refusal that still wrote is a test failure.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const b: any = {
        _table: table,
        select: () => b, eq: () => b, in: () => b, or: () => b, limit: () => b, order: () => b,
        insert: (p: any) => { writes.push({ table, op: 'insert', payload: p }); return b },
        update: (p: any) => { writes.push({ table, op: 'update', payload: p }); return b },
        delete: () => { writes.push({ table, op: 'delete' }); return b },
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        // The helper awaits the builder directly for the three list reads.
        then: (res: any, rej: any) => {
          let out: any = { data: [], error: null }
          if (table === 'matches') out = { data: cfg.matches, error: cfg.matchesError }
          else if (table === 'blocked_users') out = { data: cfg.blocks, error: null }
          else if (table === 'profiles') out = { data: cfg.profiles, error: cfg.profilesError }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return b
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}))

vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: async (_admin: any, opts: any) => { rateLimitCalls.push(opts); return cfg.rateLimit },
}))

// Record every outbound email instead of sending one.
vi.mock('@/lib/email', () => new Proxy({}, {
  get: (_t, name: string) => async (...args: any[]) => { emails.push({ fn: name, args }); return { success: true } },
}) as any)

vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

import { scheduleMeeting } from '@/app/actions'
import { MEETING_NOT_AVAILABLE, MEETING_REQUESTS_PER_DAY, canRequestMeetingWith } from '@/lib/meetings/authorization'

/** A well-formed submission naming `recipientId`. Only the recipient varies across tests. */
const form = (recipientId: string) => {
  const f = new FormData()
  f.set('recipient_id', recipientId)
  f.set('date', '2030-01-15')
  f.set('time', '14:00')
  f.set('timezone_offset', '0')
  f.set('timezone', 'America/New_York')
  f.set('title', 'Coffee')
  f.set('purpose', 'networking')
  f.set('format', 'virtual')
  f.set('duration_minutes', '30')
  return f
}

const activeBoth = [
  { id: ME, account_status: 'active' },
  { id: THEM, account_status: 'active' },
]

beforeEach(() => {
  cfg.user = { id: ME, email: 'me@x.com' }
  cfg.matches = []
  cfg.blocks = []
  cfg.profiles = activeBoth
  cfg.rateLimit = { status: 'allowed', retryAfterSeconds: 60, count: 1 }
  cfg.matchesError = null
  cfg.profilesError = null
  cfg.meeting = null
  writes.length = 0
  emails.length = 0
  rateLimitCalls.length = 0
})

describe('scheduleMeeting — a matched pair still works exactly as before', () => {
  it('live match → meeting row inserted, notification created, email sent', async () => {
    cfg.matches = [{ id: 'm1', status: 'active' }]
    const res = await scheduleMeeting(form(THEM))

    expect(res).toMatchObject({ success: true })
    const meetingInserts = writes.filter((w) => w.table === 'meetings' && w.op === 'insert')
    expect(meetingInserts).toHaveLength(1)
    expect(meetingInserts[0].payload).toMatchObject({ requester_id: ME, recipient_id: THEM, status: 'requested' })
    expect(writes.filter((w) => w.table === 'notifications' && w.op === 'insert')).toHaveLength(1)
  })

  it("status 'accepted' is also a live match", async () => {
    cfg.matches = [{ id: 'm1', status: 'accepted' }]
    expect(await scheduleMeeting(form(THEM))).toMatchObject({ success: true })
    expect(writes.filter((w) => w.table === 'meetings')).toHaveLength(1)
  })
})

describe('scheduleMeeting — refusals write nothing at all', () => {
  /** The property under test: a refusal leaves no meeting, no notification, and no email. */
  const expectNoSideEffects = () => {
    expect(writes.filter((w) => w.table === 'meetings')).toHaveLength(0)
    expect(writes.filter((w) => w.table === 'notifications')).toHaveLength(0)
    expect(emails).toHaveLength(0)
  }

  it('no match at all (the original vulnerability) → opaque refusal, nothing written', async () => {
    cfg.matches = []
    expect(await scheduleMeeting(form(STRANGER))).toEqual({ error: MEETING_NOT_AVAILABLE })
    expectNoSideEffects()
  })

  it('arbitrary/forged recipient UUID that belongs to nobody → same opaque refusal', async () => {
    cfg.matches = []
    cfg.profiles = [{ id: ME, account_status: 'active' }] // recipient row does not exist
    const res = await scheduleMeeting(form('00000000-0000-4000-8000-000000000000'))
    expect(res).toEqual({ error: MEETING_NOT_AVAILABLE })
    expectNoSideEffects()
  })

  it('a non-existent recipient is INDISTINGUISHABLE from an unmatched real one (no oracle)', async () => {
    cfg.matches = []
    cfg.profiles = [{ id: ME, account_status: 'active' }]
    const ghost = await scheduleMeeting(form(STRANGER))     // well-formed id, nobody behind it
    cfg.profiles = activeBoth
    const real = await scheduleMeeting(form(THEM))          // real member, simply not matched
    expect(ghost).toEqual(real)
  })

  it('a recipient id that is not a UUID is refused identically (no filter injection)', async () => {
    cfg.matches = [{ id: 'm1', status: 'active' }]
    // A value crafted to restructure the PostgREST .or() filter, and a plain non-uuid.
    for (const evil of ['not-a-uuid', `${STRANGER}),(user_a_id.not.is.null`, `${STRANGER},status.eq.active`]) {
      writes.length = 0
      expect(await scheduleMeeting(form(evil))).toEqual({ error: MEETING_NOT_AVAILABLE })
      expect(writes.filter((w) => w.table === 'meetings')).toHaveLength(0)
    }
  })

  it('removed match → refused', async () => {
    cfg.matches = [{ id: 'm1', status: 'removed' }]
    expect(await scheduleMeeting(form(THEM))).toEqual({ error: MEETING_NOT_AVAILABLE })
    expectNoSideEffects()
  })

  it('closed match → refused', async () => {
    cfg.matches = [{ id: 'm1', status: 'closed' }]
    expect(await scheduleMeeting(form(THEM))).toEqual({ error: MEETING_NOT_AVAILABLE })
    expectNoSideEffects()
  })

  it('live match but a block in either direction → refused', async () => {
    cfg.matches = [{ id: 'm1', status: 'active' }]
    cfg.blocks = [{ id: 'b1' }]
    expect(await scheduleMeeting(form(THEM))).toEqual({ error: MEETING_NOT_AVAILABLE })
    expectNoSideEffects()
  })

  it('live match but the recipient is deactivated → refused', async () => {
    cfg.matches = [{ id: 'm1', status: 'active' }]
    cfg.profiles = [{ id: ME, account_status: 'active' }, { id: THEM, account_status: 'deactivated' }]
    expect(await scheduleMeeting(form(THEM))).toEqual({ error: MEETING_NOT_AVAILABLE })
    expectNoSideEffects()
  })

  it('live match but the REQUESTER is deactivated → refused', async () => {
    cfg.matches = [{ id: 'm1', status: 'active' }]
    cfg.profiles = [{ id: ME, account_status: 'deactivated' }, { id: THEM, account_status: 'active' }]
    expect(await scheduleMeeting(form(THEM))).toEqual({ error: MEETING_NOT_AVAILABLE })
    expectNoSideEffects()
  })

  it('scheduling with yourself → refused', async () => {
    cfg.matches = [{ id: 'm1', status: 'active' }]
    expect(await scheduleMeeting(form(ME))).toEqual({ error: MEETING_NOT_AVAILABLE })
    expectNoSideEffects()
  })

  it('unauthenticated → refused before anything is read or written', async () => {
    cfg.user = null
    expect(await scheduleMeeting(form(THEM))).toMatchObject({ error: 'Not authenticated' })
    expectNoSideEffects()
    expect(rateLimitCalls).toHaveLength(0)
  })
})

describe('scheduleMeeting — rate limiting', () => {
  it('is keyed to the authenticated user and checked BEFORE the graph is read', async () => {
    cfg.matches = [{ id: 'm1', status: 'active' }]
    await scheduleMeeting(form(THEM))
    expect(rateLimitCalls).toHaveLength(1)
    expect(rateLimitCalls[0]).toMatchObject({ key: `meeting_request:${ME}`, limit: MEETING_REQUESTS_PER_DAY })
  })

  it('over limit → refused, nothing written, even for a legitimately matched pair', async () => {
    cfg.matches = [{ id: 'm1', status: 'active' }]
    cfg.rateLimit = { status: 'over_limit', retryAfterSeconds: 3600, count: 99 }
    const res = await scheduleMeeting(form(THEM))
    expect((res as any).error).toMatch(/maximum number of meeting requests/i)
    expect(writes.filter((w) => w.table === 'meetings')).toHaveLength(0)
    expect(emails).toHaveLength(0)
  })

  it('limiter error FAILS CLOSED — a broken limiter is not a waiver', async () => {
    cfg.matches = [{ id: 'm1', status: 'active' }]
    cfg.rateLimit = { status: 'error', retryAfterSeconds: 60 }
    const res = await scheduleMeeting(form(THEM))
    expect((res as any).error).toMatch(/temporarily unavailable/i)
    expect(writes.filter((w) => w.table === 'meetings')).toHaveLength(0)
  })
})

describe('canRequestMeetingWith — fails closed on unreadable state', () => {
  const admin = () => ({
    from: (table: string) => {
      const b: any = {
        select: () => b, eq: () => b, in: () => b, or: () => b, limit: () => b,
        then: (res: any, rej: any) => {
          let out: any = { data: [], error: null }
          if (table === 'matches') out = { data: cfg.matches, error: cfg.matchesError }
          else if (table === 'blocked_users') out = { data: cfg.blocks, error: null }
          else if (table === 'profiles') out = { data: cfg.profiles, error: cfg.profilesError }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return b
    },
  })

  it('a match-lookup error is a refusal, never a grant', async () => {
    cfg.matches = [{ id: 'm1', status: 'active' }]
    cfg.matchesError = { message: 'permission denied' }
    expect(await canRequestMeetingWith(admin() as any, ME, THEM)).toBe(false)
  })

  it('a profiles-lookup error is a refusal', async () => {
    cfg.matches = [{ id: 'm1', status: 'active' }]
    cfg.profilesError = { message: 'boom' }
    expect(await canRequestMeetingWith(admin() as any, ME, THEM)).toBe(false)
  })

  it('a thrown client is a refusal', async () => {
    const throwing = { from: () => { throw new Error('network') } }
    expect(await canRequestMeetingWith(throwing as any, ME, THEM)).toBe(false)
  })

  it('empty ids are refused without any query', async () => {
    expect(await canRequestMeetingWith(admin() as any, '', THEM)).toBe(false)
    expect(await canRequestMeetingWith(admin() as any, ME, '')).toBe(false)
  })
})


/**
 * acceptMeeting / declineMeeting used to read the meeting with the USER-scoped client and then write
 * with service_role, so the only thing standing between a member and someone else's meeting was
 * whatever RLS policy `meetings` carries — a policy with no migration in this repository, and
 * therefore no state anyone can verify from the code. Their sibling actions deleteMeeting and
 * rescheduleMeeting already checked participation explicitly; these two did not, while their
 * comments claimed they did. The check is now real.
 */
describe('acceptMeeting / declineMeeting — explicit participant check', () => {
  const otherPeoplesMeeting = { requester_id: ALICE, recipient_id: BOB, status: 'requested', proposed_scheduled_at: null }

  it('acceptMeeting on a meeting the caller is not part of → refused, nothing written', async () => {
    cfg.meeting = otherPeoplesMeeting
    const { acceptMeeting } = await import('@/app/actions')
    expect(await acceptMeeting('mt-not-mine')).toMatchObject({ error: 'Not authorized' })
    expect(writes).toHaveLength(0)
    expect(emails).toHaveLength(0)
  })

  it('declineMeeting on a meeting the caller is not part of → refused, nothing written', async () => {
    cfg.meeting = otherPeoplesMeeting
    const { declineMeeting } = await import('@/app/actions')
    expect(await declineMeeting('mt-not-mine')).toMatchObject({ error: 'Not authorized' })
    expect(writes).toHaveLength(0)
    expect(emails).toHaveLength(0)
  })

  it('a real participant is still allowed (positive control — the write IS attempted)', async () => {
    cfg.meeting = { requester_id: ME, recipient_id: BOB, status: 'requested', proposed_scheduled_at: null }
    const { acceptMeeting } = await import('@/app/actions')
    const res = await acceptMeeting('mt-mine')
    expect((res as any).error).toBeUndefined()
    expect(writes.filter((w) => w.table === 'meetings' && w.op === 'update')).toHaveLength(1)
  })

  it('the recipient side is a participant too', async () => {
    cfg.meeting = { requester_id: ALICE, recipient_id: ME, status: 'requested', proposed_scheduled_at: null }
    const { declineMeeting } = await import('@/app/actions')
    const res = await declineMeeting('mt-mine')
    expect((res as any).error).toBeUndefined()
    expect(writes.filter((w) => w.table === 'meetings' && w.op === 'update')).toHaveLength(1)
  })
})
