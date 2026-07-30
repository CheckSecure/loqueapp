import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Regression coverage for the production bug where the `introductions_waiting`
 * notification never sent: NotificationType listed it, but createNotificationSafe
 * rejects any type absent from NOTIFICATION_COPY (and needs a LINK_BY_TYPE entry),
 * so every send logged "Unknown type: introductions_waiting" and returned null —
 * no notification row, no email. This file proves the type is now registered and
 * the notifyQueuedIntrosWaiting flow works end-to-end, idempotently.
 *
 * Only '@/lib/supabase/admin' (in-memory notifications + profiles store) and
 * '@/lib/email' (send recorder) are mocked. createNotificationSafe and
 * notifyQueuedIntrosWaiting run for real — the maps under test are exercised.
 */

const h = vi.hoisted(() => ({
  notifications: [] as any[],   // in-memory notifications table
  profiles: {} as Record<string, { email: string | null; full_name: string | null }>,
  insertErrorCode: null as string | null, // force a unique-violation on the next insert
  seq: 0,
}))

vi.mock('@/lib/supabase/admin', () => {
  const from = (table: string) => {
    const b: any = { _t: table, _op: 'select', _payload: null as any, _eqs: [] as any[] }
    b.select = () => b
    b.insert = (p: any) => { b._op = 'insert'; b._payload = p; return b }
    b.eq = (c: string, v: any) => { b._eqs.push([c, v]); return b }
    b.single = () => b
    b.maybeSingle = () => b
    const getEq = (c: string) => (b._eqs.find((e: any[]) => e[0] === c) || [])[1]
    const exec = async () => {
      if (b._t === 'notifications') {
        if (b._op === 'insert') {
          if (h.insertErrorCode) {
            const code = h.insertErrorCode
            h.insertErrorCode = null
            return { data: null, error: { code } }
          }
          const row = { id: `n${++h.seq}`, ...b._payload }
          h.notifications.push(row)
          return { data: row, error: null }
        }
        // dedupe select: match user_id, type, and data->>dedupeKey when present.
        const userId = getEq('user_id')
        const type = getEq('type')
        const dedupeKey = getEq('data->>dedupeKey')
        const hit = h.notifications.find((n) =>
          n.user_id === userId &&
          n.type === type &&
          (dedupeKey === undefined || n.data?.dedupeKey === dedupeKey))
        return { data: hit ?? null, error: null }
      }
      if (b._t === 'profiles') {
        return { data: h.profiles[getEq('id')] ?? null, error: null }
      }
      return { data: null, error: null }
    }
    b.then = (res: any, rej: any) => exec().then(res, rej)
    return b
  }
  return { createAdminClient: () => ({ from, rpc: async () => ({ data: null, error: null }) }) }
})

vi.mock('@/lib/email', () => ({
  sendCurrentIntroductionsWaitingEmail: vi.fn(async () => {}),
}))

import { createNotificationSafe } from '@/lib/notifications'
import { notifyQueuedIntrosWaiting } from '@/lib/notifications/engagement'
import { sendCurrentIntroductionsWaitingEmail } from '@/lib/email'

beforeEach(() => {
  h.notifications = []
  h.profiles = { M1: { email: 'm1@x.com', full_name: 'Member One' } }
  h.insertErrorCode = null
  h.seq = 0
  process.env.RESEND_API_KEY = 'test-key' // so the (mocked) email sender is invoked
  ;(sendCurrentIntroductionsWaitingEmail as any).mockClear()
})

describe('introductions_waiting — createNotificationSafe registration', () => {
  it('accepts the introductions_waiting type and creates a row (not the old "Unknown type" null)', async () => {
    const created = await createNotificationSafe({
      userId: 'M1',
      type: 'introductions_waiting',
      data: { batchId: 'rb-1' },
      dedupeKey: 'queuedwaiting:rb-1',
    })
    expect(created).not.toBeNull()
    expect(h.notifications).toHaveLength(1)
    const row = h.notifications[0]
    expect(row.type).toBe('introductions_waiting')
    // Links only to current introductions — reveals no queued-batch detail.
    expect(row.link).toBe('/dashboard/introductions')
    expect(row.title).toBeTruthy()
    expect(row.body).toBeTruthy()
    // The dedupeKey is persisted inside data so the next check can find it.
    expect(row.data?.dedupeKey).toBe('queuedwaiting:rb-1')
  })

  it('is idempotent per queued batch: a second identical call returns null and inserts nothing', async () => {
    const first = await createNotificationSafe({
      userId: 'M1', type: 'introductions_waiting', dedupeKey: 'queuedwaiting:rb-1',
    })
    const second = await createNotificationSafe({
      userId: 'M1', type: 'introductions_waiting', dedupeKey: 'queuedwaiting:rb-1',
    })
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(h.notifications).toHaveLength(1) // no duplicate row
  })

  it('treats a unique-index race (23505) as an idempotent no-op', async () => {
    h.insertErrorCode = '23505' // concurrent insert won the race
    const created = await createNotificationSafe({
      userId: 'M1', type: 'introductions_waiting', dedupeKey: 'queuedwaiting:rb-1',
    })
    expect(created).toBeNull()
    expect(h.notifications).toHaveLength(0)
  })
})

describe('notifyQueuedIntrosWaiting — end-to-end', () => {
  it('a queued member gets one notification row + one waiting email', async () => {
    await notifyQueuedIntrosWaiting('M1', 'rb-1')
    expect(h.notifications).toHaveLength(1)
    expect(h.notifications[0].type).toBe('introductions_waiting')
    expect(sendCurrentIntroductionsWaitingEmail).toHaveBeenCalledTimes(1)
    // Sender takes only (email, name) — it structurally cannot leak queued detail.
    expect(sendCurrentIntroductionsWaitingEmail).toHaveBeenCalledWith('m1@x.com', 'Member One')
  })

  it('a retry / double-run does NOT create a duplicate notification or send a second email', async () => {
    await notifyQueuedIntrosWaiting('M1', 'rb-1')
    await notifyQueuedIntrosWaiting('M1', 'rb-1') // approve-batch retry
    expect(h.notifications).toHaveLength(1)                       // dedupe held
    expect(sendCurrentIntroductionsWaitingEmail).toHaveBeenCalledTimes(1) // no second email
  })

  it('distinct queued batches each nudge once (dedupe is per queued batch, not global)', async () => {
    await notifyQueuedIntrosWaiting('M1', 'rb-1')
    await notifyQueuedIntrosWaiting('M1', 'rb-2')
    expect(h.notifications).toHaveLength(2)
    expect(sendCurrentIntroductionsWaitingEmail).toHaveBeenCalledTimes(2)
  })
})
