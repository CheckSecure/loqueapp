import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * OPPORTUNITY-CREATED CONNECTIONS GET THE SAME CONNECTION EMAIL (Tier 2).
 *
 * connectOpportunityResponder produces a real peer connection — the same `matches` row, the same
 * conversation, the same icebreakers — and was the only such path that sent no email at all. It now
 * uses the SAME helper as every other connection rather than a parallel template.
 *
 * The counterpart is resolved per recipient. Note that here `creatorId` IS written to
 * matches.user_a_id, which is exactly the shape that makes a positional assumption look correct in
 * one direction and silently produce "you're connected with yourself" in the other — so both
 * directions are asserted.
 *
 * Everything that already worked must not move: eligibility gates, the match and conversation
 * inserts, the icebreakers, and the existing notifications.
 */

const h = vi.hoisted(() => ({
  participants: [] as any[],
  participantRead: 'ok' as 'ok' | 'unavailable',
  emailThrows: false,
}))

const emails = vi.hoisted(() => [] as any[])
const notifications = vi.hoisted(() => [] as any[])
const writes = vi.hoisted(() => [] as any[])

const CREATOR = '11111111-1111-4111-8111-111111111111'
const RESPONDER = '22222222-2222-4222-8222-222222222222'
const CONV = '33333333-3333-4333-8333-333333333333'
const MATCH = '44444444-4444-4444-8444-444444444444'

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const b: any = {
        select: () => b, eq: () => b, or: () => b, in: () => b,
        insert: (p: any) => { writes.push({ table, op: 'insert', payload: p }); return b },
        update: (p: any) => { writes.push({ table, op: 'update', payload: p }); return b },
        single: async () => {
          if (table === 'matches') return { data: { id: MATCH }, error: null }
          if (table === 'conversations') return { data: { id: CONV }, error: null }
          if (table === 'profiles') return { data: { id: 'p', title: 'GC', company: 'Acme', bio: 'b' }, error: null }
          return { data: { id: `${table}-1` }, error: null }
        },
        maybeSingle: async () => {
          if (table === 'opportunities') return { data: { id: 'opp1', creator_id: CREATOR, status: 'active' }, error: null }
          if (table === 'opportunity_responses') return { data: { id: 'resp1', status: 'interested' }, error: null }
          return { data: null, error: null }
        },
        then: (res: any, rej: any) => {
          let out: any = { data: [], error: null }
          // account_status pre-check reads profiles as a list
          if (table === 'profiles') out = {
            data: [{ id: CREATOR, account_status: 'active' }, { id: RESPONDER, account_status: 'active' }],
            error: null,
          }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return b
    },
  }),
}))

vi.mock('@/lib/profiles/serverProfile', () => ({
  readProfilesByIds: vi.fn(async () =>
    h.participantRead === 'ok' ? { ok: true, profiles: h.participants } : { ok: false, reason: 'unavailable' },
  ),
}))

vi.mock('@/lib/email', () => ({
  sendMatchCreatedEmail: vi.fn(async (...args: any[]) => {
    if (h.emailThrows) throw new Error('resend down')
    emails.push(args)
    return { success: true }
  }),
}))

vi.mock('@/lib/notifications', () => ({
  createNotificationSafe: vi.fn(async (a: any) => { notifications.push(a); return { id: 'n' } }),
}))

vi.mock('@/lib/referrals/exclusions', () => ({ getReferralExclusionsForUser: async () => new Set<string>() }))
vi.mock('@/lib/messaging/icebreakers', () => ({
  generateIcebreakers: () => ['p1', 'p2'],
  generateSystemIntroMessage: () => 'SYSTEM INTRO',
}))

import { connectOpportunityResponder } from '@/lib/opportunities/connect'

const profile = (id: string, name: string, email: string | null, title: string, company: string) =>
  ({ id, full_name: name, email, title, company })

beforeEach(() => {
  // Deliberately reversed relative to (creator, responder).
  h.participants = [
    profile(RESPONDER, 'Rita Responder', 'rita@x.com', 'Associate', 'Latham'),
    profile(CREATOR, 'Carl Creator', 'carl@x.com', 'GC', 'Acme'),
  ]
  h.participantRead = 'ok'
  h.emailThrows = false
  emails.length = 0; notifications.length = 0; writes.length = 0
  vi.clearAllMocks()
})

const run = () => connectOpportunityResponder({ opportunityId: 'opp1', creatorId: CREATOR, responderId: RESPONDER })

describe('an opportunity connection now emails both members', () => {
  it('sends exactly two connection emails', async () => {
    const res = await run()
    expect(res.ok).toBe(true)
    expect(emails).toHaveLength(2)
    expect(emails.map((e) => e[0]).sort()).toEqual(['carl@x.com', 'rita@x.com'])
  })

  it('deep-links both emails to the exact opportunity conversation', async () => {
    await run()
    for (const e of emails) expect(e[5]).toEqual({ conversationId: CONV })
  })

  it('the creator is told about the RESPONDER', async () => {
    await run()
    const toCreator = emails.find((e) => e[0] === 'carl@x.com')
    expect(toCreator[1]).toBe('Carl Creator')      // greeting
    expect(toCreator[2]).toBe('Rita Responder')    // counterpart
    expect(toCreator[3]).toBe('Associate')
    expect(toCreator[4]).toBe('Latham')
  })

  it('the responder is told about the CREATOR', async () => {
    await run()
    const toResponder = emails.find((e) => e[0] === 'rita@x.com')
    expect(toResponder[1]).toBe('Rita Responder')
    expect(toResponder[2]).toBe('Carl Creator')
    expect(toResponder[3]).toBe('GC')
    expect(toResponder[4]).toBe('Acme')
  })

  it('neither member is ever named as their own counterpart', async () => {
    // creatorId is written to matches.user_a_id here, so a positional assumption would look
    // correct for one recipient and name the other with their own identity.
    await run()
    for (const [toEmail, toName, counterpartName] of emails) {
      expect(counterpartName).not.toBe(toName)
      const self = h.participants.find((p) => p.email === toEmail)
      expect(counterpartName).not.toBe(self.full_name)
    }
  })

  it('is unaffected by the order profile rows come back in', async () => {
    h.participants = [...h.participants].reverse()
    await run()
    expect(emails.find((e) => e[0] === 'carl@x.com')[2]).toBe('Rita Responder')
    expect(emails.find((e) => e[0] === 'rita@x.com')[2]).toBe('Carl Creator')
  })

  it('a member without an email address is skipped, the other still receives theirs', async () => {
    h.participants = [profile(RESPONDER, 'Rita', null, 'A', 'L'), profile(CREATOR, 'Carl', 'carl@x.com', 'GC', 'Acme')]
    await run()
    expect(emails).toHaveLength(1)
    expect(emails[0][0]).toBe('carl@x.com')
  })
})

describe('email is downstream of the connection, never a precondition', () => {
  it('a failing email still returns a successful connection', async () => {
    h.emailThrows = true
    const res = await run()
    expect(res).toMatchObject({ ok: true, match_id: MATCH, conversation_id: CONV })
  })

  it('an unavailable profile read still returns a successful connection and sends nothing', async () => {
    h.participantRead = 'unavailable'
    const res = await run()
    expect(res.ok).toBe(true)
    expect(emails).toHaveLength(0)
  })
})

describe('everything that already worked is unchanged', () => {
  it('still inserts the match and the conversation', async () => {
    await run()
    expect(writes.filter((w) => w.table === 'matches' && w.op === 'insert')).toHaveLength(1)
    expect(writes.filter((w) => w.table === 'conversations' && w.op === 'insert')).toHaveLength(1)
  })

  it('still writes the system icebreaker message', async () => {
    await run()
    const msg = writes.find((w) => w.table === 'messages' && w.op === 'insert')
    expect(msg.payload).toMatchObject({ is_system: true, sender_id: null, content: 'SYSTEM INTRO' })
  })

  it('still marks the response introduced', async () => {
    await run()
    expect(writes.some((w) => w.table === 'opportunity_responses' && w.op === 'update')).toBe(true)
  })

  it('keeps both existing notifications, their type, and their conversation link', async () => {
    await run()
    expect(notifications).toHaveLength(2)
    for (const n of notifications) {
      expect(n.type).toBe('mutual_match')
      expect(n.link).toBe(`/dashboard/messages/${CONV}`)
    }
    expect(notifications.map((n) => n.userId).sort()).toEqual([CREATOR, RESPONDER].sort())
  })

  it('notifications are now keyed on the match so a same-day connection is not swallowed', async () => {
    await run()
    for (const n of notifications) expect(n.dedupeKey).toBe(MATCH)
  })

  it('an ineligible pair is still refused before any email', async () => {
    const { connectOpportunityResponder: fn } = await import('@/lib/opportunities/connect')
    const res = await fn({ opportunityId: 'opp1', creatorId: 'someone-else', responderId: RESPONDER })
    expect(res).toMatchObject({ ok: false, code: 'not_creator' })
    expect(emails).toHaveLength(0)
  })
})
