import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Integration test for PART 3 of the engagement-reminders cron: 7-day gate, no_action vs
 * partial dispatch, resolved-skip, and one-reminder-per-batch dedupe. Supabase, the
 * notification store, and the email senders are mocked as recorders.
 */
const h = vi.hoisted(() => ({ db: {} as any, seenDedupe: new Set<string>() }))

vi.mock('@/lib/supabase/admin', () => {
  const match = (row: any, filters: any[]) => filters.every((fl) =>
    fl.t === 'eq' ? row[fl.c] === fl.v : fl.t === 'in' ? fl.v.includes(row[fl.c]) : fl.t === 'lte' ? String(row[fl.c] ?? '') <= String(fl.v) : true)
  const from = (table: string) => {
    const filters: any[] = []
    const rows = () => (h.db[table] ?? []).filter((r: any) => match(r, filters))
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { filters.push({ t: 'eq', c, v }); return b },
      in: (c: string, v: any[]) => { filters.push({ t: 'in', c, v }); return b },
      lte: (c: string, v: any) => { filters.push({ t: 'lte', c, v }); return b },
      or: () => b,
      // The builder was missing these. The Wednesday stage pages with .in().range() and reads
      // reminder_deliveries with .eq().order(), so on a Wednesday this mock threw
      // "…in(...).range is not a function" and these PART 3 tests failed — one day in seven,
      // independent of anything PART 3 does. Nothing pinned the clock, so the suite's result
      // depended on the day it ran.
      order: () => b,
      range: (from: number, to: number) =>
        Promise.resolve({ data: rows().slice(from, to + 1), error: null }),
      limit: () => Promise.resolve({ data: rows(), error: null }),
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: rows(), error: null }).then(res, rej),
    }
    return b
  }
  return { createAdminClient: () => ({ from }) }
})

vi.mock('@/lib/notifications', () => ({
  createNotificationSafe: vi.fn(async ({ dedupeKey }: any) => {
    if (h.seenDedupe.has(dedupeKey)) return null
    h.seenDedupe.add(dedupeKey)
    return { id: dedupeKey }
  }),
}))

vi.mock('@/lib/email', () => ({
  sendIntroductionReminderEmail: vi.fn(async () => {}),
  sendWaitingResponseEmail: vi.fn(async () => {}),
}))

import { GET } from '@/app/api/cron/engagement-reminders/route'
import { sendIntroductionReminderEmail } from '@/lib/email'

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const DAY = 24 * 60 * 60 * 1000
const req = () => new Request('http://x/api/cron/engagement-reminders', { headers: { authorization: 'Bearer test-secret' } })

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  process.env.RESEND_API_KEY = 'test-key' // so the cron actually invokes the (mocked) sender
  h.seenDedupe = new Set()
  ;(sendIntroductionReminderEmail as any).mockClear()
  h.db = {
    matches: [],
    recommendation_batches: [
      { batch_id: 'b1', member_id: 'M1', state: 'active', displayed_at: iso(8 * DAY) }, // stale
      { batch_id: 'b2', member_id: 'M2', state: 'active', displayed_at: iso(8 * DAY) }, // stale
      { batch_id: 'b3', member_id: 'M3', state: 'active', displayed_at: iso(8 * DAY) }, // stale, resolved
      { batch_id: 'b4', member_id: 'M4', state: 'active', displayed_at: iso(1 * 3600e3) }, // FRESH (<7d)
    ],
    profiles: ['M1', 'M2', 'M3', 'M4'].map((id) => ({ id, email: `${id}@x.com`, full_name: id, account_status: 'active', is_test_account: false })),
    intro_requests: [
      // M1 — no action: two open suggested, nothing acted
      { id: 'r1', requester_id: 'M1', target_user_id: 't1', status: 'suggested' },
      { id: 'r2', requester_id: 'M1', target_user_id: 't2', status: 'suggested' },
      // M2 — partial: two suggested, expressed on one
      { id: 'r3', requester_id: 'M2', target_user_id: 't3', status: 'suggested' },
      { id: 'r4', requester_id: 'M2', target_user_id: 't4', status: 'suggested' },
      { id: 'r5', requester_id: 'M2', target_user_id: 't3', status: 'approved', updated_at: iso(0) },
      // M3 — resolved: one suggested, expressed on it → unresolved 0
      { id: 'r6', requester_id: 'M3', target_user_id: 't5', status: 'suggested' },
      { id: 'r7', requester_id: 'M3', target_user_id: 't5', status: 'approved', updated_at: iso(0) },
      // M4 — would be no_action, but its batch is fresh → gated out
      { id: 'r8', requester_id: 'M4', target_user_id: 't6', status: 'suggested' },
    ],
  }
})

describe('engagement-reminders cron — PART 3', () => {
  it('401 without the cron secret', async () => {
    const res = await GET(new Request('http://x', { headers: { authorization: 'Bearer wrong' } }))
    expect(res.status).toBe(401)
  })

  it('sends no_action + partial copy, skips resolved, and honors the 7-day gate', async () => {
    const res = await GET(req())
    const body = await res.json()
    expect(body.reminderSent).toBe(2) // M1 + M2 only

    const calls = (sendIntroductionReminderEmail as any).mock.calls
    const byEmail = new Map<string, any[]>(calls.map((c: any[]) => [c[0], c])) // email → [email,name,count,category]
    expect(byEmail.get('M1@x.com')?.[3]).toBe('no_action') // took no action
    expect(byEmail.get('M1@x.com')?.[2]).toBe(2)           // 2 unresolved
    expect(byEmail.get('M2@x.com')?.[3]).toBe('partial')   // acted on one
    expect(byEmail.get('M2@x.com')?.[2]).toBe(1)           // 1 unresolved
    expect(byEmail.has('M3@x.com')).toBe(false)            // resolved → no reminder
    expect(byEmail.has('M4@x.com')).toBe(false)            // fresh batch → gated out (< 7 days)
  })

  it('dedupe: a second run sends nothing new (one reminder per batch)', async () => {
    await GET(req())
    const afterFirst = (sendIntroductionReminderEmail as any).mock.calls.length
    expect(afterFirst).toBe(2)
    const res2 = await GET(req()) // same batches, dedupeKeys already seen
    expect((await res2.json()).reminderSent).toBe(0)
    expect((sendIntroductionReminderEmail as any).mock.calls.length).toBe(afterFirst) // unchanged
  })
})
