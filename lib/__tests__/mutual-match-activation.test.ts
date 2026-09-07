import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * MUTUAL-MATCH ACTIVATION REPAIR (Tier 1).
 *
 * THE DEFECT. finalizeMutualMatch read both participant profiles with the CALLER'S SESSION CLIENT.
 * Migration 058 (`REVOKE SELECT ON TABLE public.profiles FROM PUBLIC, anon, authenticated`) removed
 * that privilege on 2026-08-16, so both reads returned 42501, only `data` was destructured, and both
 * profiles became null. Everything gated on them stopped: NEITHER connection email was sent and both
 * notifications lost the counterpart's name. Nothing errored, because a discarded permission error is
 * indistinguishable from "no such member".
 *
 * (086 is NOT the cause — it revokes privileges on matches / blocked_users and contains the string
 * "profiles" zero times. It landed ten days after the read was already broken.)
 *
 * The session client is modelled here EXACTLY as production behaves — every profiles read through it
 * is denied — so a regression that reintroduces one fails these tests instead of shipping silently.
 */

const h = vi.hoisted(() => ({
  guard: { outcome: 'finalized', match_id: 'match-1', conversation_id: 'conv-1' } as any,
  /** Rows readProfilesByIds resolves. Order is deliberately NOT (acting, other). */
  participantRows: [] as any[],
  participantRead: 'ok' as 'ok' | 'unavailable',
  consentRows: [] as any[],
  existingMatch: null as any,
  companyRows: [] as any[],
  postCredits: { free_credits: 5 } as any,
}))

const notifications = vi.hoisted(() => [] as any[])
const emails = vi.hoisted(() => [] as any[])
const adminWrites = vi.hoisted(() => [] as any[])
/** Every table the SESSION client was asked to read — must never include 'profiles'. */
const sessionReads = vi.hoisted(() => [] as string[])

const ACTING = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

// The BROWSER/session client: profiles is DENIED, exactly as production is since 058.
const DENIED = { data: null, error: { code: '42501', message: 'permission denied for table profiles' } }

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    from: (t: string) => {
      sessionReads.push(t)
      const b: any = {}
      b.select = () => b; b.eq = () => b; b.or = () => b; b.in = () => b; b.limit = () => b
      b.single = async () => (t === 'profiles' ? DENIED : { data: null, error: null })
      b.maybeSingle = async () => (t === 'profiles' ? DENIED : { data: null, error: null })
      return b
    },
  }),
}))

vi.mock('@/lib/profiles/serverProfile', () => ({
  readProfilesByIds: vi.fn(async () =>
    h.participantRead === 'ok'
      ? { ok: true, profiles: h.participantRows }
      : { ok: false, reason: 'unavailable' },
  ),
  readProfileById: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
}))

vi.mock('@/lib/notifications', () => ({
  createNotificationSafe: vi.fn(async (args: any) => { notifications.push(args); return { id: 'n' } }),
}))

vi.mock('@/lib/email', () => ({
  sendMatchCreatedEmail: vi.fn(async (...args: any[]) => { emails.push(args); return { success: true } }),
}))

vi.mock('@/lib/introductions/creditBlockedMatch', () => ({ notifyCreditBlockedMatch: async () => {} }))
vi.mock('@/lib/messaging/icebreakers', () => ({
  generateIcebreakers: () => ['prompt one', 'prompt two'],
  generateSystemIntroMessage: () => 'SYSTEM INTRO TEXT',
}))

const adminClient = () => ({
  rpc: async (fn: string, args: any) => {
    adminWrites.push({ op: 'rpc', fn, args })
    if (fn === 'finalize_mutual_match_atomic') return { data: h.guard, error: null }
    return { data: null, error: null }
  },
  from: (table: string) => {
    const b: any = {
      _t: table,
      select: () => b, eq: () => b, or: () => b, in: () => b, is: () => b, limit: () => b,
      update: (p: any) => { adminWrites.push({ op: 'update', table, payload: p }); return b },
      insert: (p: any) => { adminWrites.push({ op: 'insert', table, payload: p }); return b },
      single: async () => ({ data: table === 'profiles' ? {} : null, error: null }),
      maybeSingle: async () => {
        if (table === 'matches') return { data: h.existingMatch, error: null }
        if (table === 'meeting_credits') return { data: h.postCredits, error: null }
        return { data: null, error: null }
      },
      then: (res: any, rej: any) => {
        let out: any = { data: [], error: null }
        if (table === 'intro_requests') out = { data: h.consentRows, error: null }
        if (table === 'profiles') out = { data: h.companyRows, error: null }
        return Promise.resolve(out).then(res, rej)
      },
    }
    return b
  },
})

import { finalizeMutualMatch } from '@/lib/introductions/finalizeMutualMatch'
import { createClient } from '@/lib/supabase/server'
import { readProfilesByIds } from '@/lib/profiles/serverProfile'
import { connectionDirections, counterpartDisplayName } from '@/lib/introductions/connectionParticipants'

const profile = (id: string, name: string, email: string | null, title = 'GC', company = 'Acme') =>
  ({ id, full_name: name, email, title, company })

/** Both members consented — the precondition finalizeMutualMatch revalidates. */
const consented = () => ([
  { requester_id: ACTING, target_user_id: OTHER, status: 'approved' },
  { requester_id: OTHER, target_user_id: ACTING, status: 'approved' },
])

beforeEach(() => {
  h.guard = { outcome: 'finalized', match_id: 'match-1', conversation_id: 'conv-1' }
  // Deliberately reversed relative to (acting, other) so nothing can pass by relying on row order.
  h.participantRows = [profile(OTHER, 'Sarah Mitchell', 'sarah@x.com', 'Partner', 'Skadden'),
                       profile(ACTING, 'Dan Abramoff', 'dan@x.com', 'GC', 'Acme')]
  h.participantRead = 'ok'
  h.consentRows = consented()
  h.existingMatch = null
  h.companyRows = [{ id: ACTING, company: 'Acme' }, { id: OTHER, company: 'Skadden' }]
  h.postCredits = { free_credits: 5 }
  notifications.length = 0; emails.length = 0; adminWrites.length = 0; sessionReads.length = 0
  // Call history only — the factory implementations (which read `h`) are preserved.
  vi.clearAllMocks()
})

const run = (actingUserId = ACTING, otherUserId = OTHER) =>
  finalizeMutualMatch({
    supabase: createClient(),
    adminClient: adminClient(),
    graphClient: adminClient(),
    actingUserId,
    otherUserId,
    isAdminInitiated: false,
  })

// ── 1 / 2 — the root cause ────────────────────────────────────────────────────────────────────
describe('finalizes without any authenticated SELECT on public.profiles', () => {
  it('succeeds even though every session-client profiles read is denied', async () => {
    const res = await run()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, mutualInterest: true, matchCreated: true })
  })

  it('never reads profiles through the session client', async () => {
    await run()
    expect(sessionReads).not.toContain('profiles')
  })

  it('resolves participants through the approved server-side abstraction', async () => {
    await run()
    expect(readProfilesByIds).toHaveBeenCalledTimes(1)
    const [ids, columns] = (readProfilesByIds as any).mock.calls[0]
    expect(new Set(ids)).toEqual(new Set([ACTING, OTHER]))   // ONE batched read, both members
    expect(columns).toContain('full_name'); expect(columns).toContain('email')
  })

  it('the source no longer contains a session-client profiles read', () => {
    const src = readFileSync('lib/introductions/finalizeMutualMatch.ts', 'utf8')
    expect(src).not.toMatch(/supabase\s*\n?\s*\.from\('profiles'\)/)
  })
})

// ── 3 — both members are emailed ──────────────────────────────────────────────────────────────
describe('both members receive the connection email', () => {
  it('sends exactly two emails, one per member', async () => {
    await run()
    expect(emails).toHaveLength(2)
    expect(emails.map((e) => e[0]).sort()).toEqual(['dan@x.com', 'sarah@x.com'])
  })

  it('a member with no email address is skipped without blocking the other', async () => {
    h.participantRows = [profile(OTHER, 'Sarah Mitchell', null), profile(ACTING, 'Dan Abramoff', 'dan@x.com')]
    await run()
    expect(emails).toHaveLength(1)
    expect(emails[0][0]).toBe('dan@x.com')
  })
})

// ── 4 / 5 / 6 / 7 — counterpart identity, both orientations ───────────────────────────────────
describe('counterpart identity is resolved relative to the RECIPIENT', () => {
  const byRecipient = () => Object.fromEntries(notifications.map((n) => [n.userId, n]))

  it("recipient A's notification names B", async () => {
    await run()
    expect(byRecipient()[ACTING].body).toBe("You're connected with Sarah Mitchell.")
    expect(byRecipient()[ACTING].data.otherUserId).toBe(OTHER)
  })

  it("recipient B's notification names A", async () => {
    await run()
    expect(byRecipient()[OTHER].body).toBe("You're connected with Dan Abramoff.")
    expect(byRecipient()[OTHER].data.otherUserId).toBe(ACTING)
  })

  it('neither member is ever told they connected with themselves', async () => {
    await run()
    for (const n of notifications) {
      const self = h.participantRows.find((p) => p.id === n.userId)
      expect(n.body).not.toContain(self.full_name)
      expect(n.data.otherUserId).not.toBe(n.userId)
    }
    for (const e of emails) {
      const [toEmail, toName, counterpartName] = e
      expect(counterpartName).not.toBe(toName)
      const self = h.participantRows.find((p) => p.email === toEmail)
      expect(counterpartName).not.toBe(self.full_name)
    }
  })

  it('is identical when the acting/other roles are SWAPPED (no positional dependence)', async () => {
    await run(OTHER, ACTING)                       // same pair, opposite orientation
    const m = byRecipient()
    expect(m[ACTING].body).toBe("You're connected with Sarah Mitchell.")
    expect(m[OTHER].body).toBe("You're connected with Dan Abramoff.")
    const toSarah = emails.find((e) => e[0] === 'sarah@x.com')
    const toDan = emails.find((e) => e[0] === 'dan@x.com')
    expect(toSarah[2]).toBe('Dan Abramoff')
    expect(toDan[2]).toBe('Sarah Mitchell')
  })

  it('is unaffected by the order rows come back from the database', async () => {
    h.participantRows = [...h.participantRows].reverse()
    await run()
    expect(byRecipient()[ACTING].body).toBe("You're connected with Sarah Mitchell.")
    expect(byRecipient()[OTHER].body).toBe("You're connected with Dan Abramoff.")
  })
})

// ── 8 — deep link ─────────────────────────────────────────────────────────────────────────────
describe('notifications deep-link to the exact conversation', () => {
  it('links to the canonical /dashboard/messages/<conversationId> route', async () => {
    await run()
    for (const n of notifications) expect(n.link).toBe('/dashboard/messages/conv-1')
  })

  it('falls back to LINK_BY_TYPE when the RPC returned no conversation id', async () => {
    h.guard = { outcome: 'finalized', match_id: 'match-1', conversation_id: null }
    await run()
    expect(notifications).toHaveLength(2)
    for (const n of notifications) expect(n.link).toBeUndefined()   // → LINK_BY_TYPE['mutual_match']
  })
})

// ── 9 / 10 — dedupe ───────────────────────────────────────────────────────────────────────────
describe('per-match dedupe replaces the 24-hour digest rule', () => {
  it('keys the notification on the match id', async () => {
    await run()
    for (const n of notifications) expect(n.dedupeKey).toBe('match-1')
  })

  it('two DIFFERENT matches for the same member produce two distinct keys', async () => {
    await run()
    h.guard = { outcome: 'finalized', match_id: 'match-2', conversation_id: 'conv-2' }
    await run()
    const keysFor = notifications.filter((n) => n.userId === ACTING).map((n) => n.dedupeKey)
    expect(keysFor).toEqual(['match-1', 'match-2'])   // neither suppresses the other
  })

  it('a retry of the SAME match reuses the key, so createNotificationSafe suppresses it', async () => {
    await run()
    await run()
    const keysFor = notifications.filter((n) => n.userId === ACTING).map((n) => n.dedupeKey)
    expect(keysFor).toEqual(['match-1', 'match-1'])   // identical key → idempotent at the helper
  })

  it('an already-existing match short-circuits before any notification or email', async () => {
    h.existingMatch = { id: 'match-1', status: 'active' }
    const res = await run()
    expect(res.body).toMatchObject({ matchAlreadyExists: true })
    expect(notifications).toHaveLength(0)
    expect(emails).toHaveLength(0)
  })
})

// ── 11 / 12 / 13 / 14 / 15 — nothing else moved ───────────────────────────────────────────────
describe('existing behaviour is unchanged', () => {
  it('still creates the match + conversation through the same atomic RPC', async () => {
    await run()
    const rpc = adminWrites.find((w) => w.fn === 'finalize_mutual_match_atomic')
    expect(rpc).toBeTruthy()
    expect(rpc.args).toMatchObject({ p_user_a: ACTING, p_user_b: OTHER, p_admin_facilitated: false })
  })

  it('still writes the system icebreaker message and the suggested prompts', async () => {
    await run()
    const msg = adminWrites.find((w) => w.op === 'insert' && w.table === 'messages')
    expect(msg.payload).toMatchObject({ conversation_id: 'conv-1', sender_id: null, is_system: true, content: 'SYSTEM INTRO TEXT' })
    const prompts = adminWrites.find((w) => w.op === 'update' && w.table === 'conversations')
    expect(prompts.payload.suggested_prompts).toEqual(['prompt one', 'prompt two'])
  })

  it('credit handling is untouched — no credit write is issued from this function', async () => {
    await run()
    expect(adminWrites.filter((w) => w.table === 'meeting_credits' && w.op !== 'select')).toHaveLength(0)
    expect(adminWrites.filter((w) => w.table === 'credit_transactions')).toHaveLength(0)
  })

  it('still emits the low-credit nudge from the post-RPC balance', async () => {
    h.postCredits = { free_credits: 0 }
    await run()
    expect(notifications.some((n) => n.type === 'no_credits')).toBe(true)
  })

  it('consent revalidation still refuses a one-sided pair — no match, no email', async () => {
    h.consentRows = [{ requester_id: ACTING, target_user_id: OTHER, status: 'approved' }]
    const res = await run()
    expect(res.status).toBe(409)
    expect(adminWrites.some((w) => w.fn === 'finalize_mutual_match_atomic')).toBe(false)
    expect(emails).toHaveLength(0)
  })

  it('the same-company gate still refuses before anything is written', async () => {
    h.companyRows = [{ id: ACTING, company: 'Acme' }, { id: OTHER, company: 'Acme' }]
    const res = await run()
    expect(res.status).toBe(409)
    expect(emails).toHaveLength(0)
  })
})

// ── failure isolation ─────────────────────────────────────────────────────────────────────────
describe('email and profile failures never invalidate a committed match', () => {
  it('a rejected email still returns a successful match', async () => {
    const { sendMatchCreatedEmail } = await import('@/lib/email')
    ;(sendMatchCreatedEmail as any).mockRejectedValueOnce(new Error('resend down'))
    const res = await run()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ matchCreated: true })
  })

  it('an unavailable profile read still returns a successful match, and sends nothing', async () => {
    h.participantRead = 'unavailable'
    const res = await run()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ matchCreated: true })
    expect(notifications.filter((n) => n.type === 'mutual_match')).toHaveLength(0)
    expect(emails).toHaveLength(0)
  })
})

// ── the pure resolver ─────────────────────────────────────────────────────────────────────────
describe('connectionDirections — the counterpart rule itself', () => {
  const a = profile('a', 'Alpha', 'a@x.com')
  const b = profile('b', 'Beta', 'b@x.com')

  it('returns both directions with counterparts swapped', () => {
    const d = connectionDirections('a', 'b', [a, b])
    expect(d).toHaveLength(2)
    expect(d[0]).toMatchObject({ recipient: { id: 'a' }, counterpart: { id: 'b' } })
    expect(d[1]).toMatchObject({ recipient: { id: 'b' }, counterpart: { id: 'a' } })
  })

  it('is order-independent in both the ids and the rows', () => {
    const forward = connectionDirections('a', 'b', [a, b])
    const reversed = connectionDirections('b', 'a', [b, a])
    const key = (d: any[]) => d.map((x) => `${x.recipient.id}->${x.counterpart.id}`).sort()
    expect(key(forward)).toEqual(key(reversed))
  })

  it('never pairs a member with themselves', () => {
    expect(connectionDirections('a', 'a', [a])).toEqual([])
  })

  it('returns nothing when a profile is missing, rather than a half fan-out', () => {
    expect(connectionDirections('a', 'b', [a])).toEqual([])
    expect(connectionDirections('a', 'b', [])).toEqual([])
    expect(connectionDirections('a', 'b', null)).toEqual([])
  })

  it('falls back to a neutral display name rather than an empty string', () => {
    expect(counterpartDisplayName({ ...a, full_name: null })).toBe('Your connection')
    expect(counterpartDisplayName({ ...a, full_name: '   ' })).toBe('Your connection')
  })
})
