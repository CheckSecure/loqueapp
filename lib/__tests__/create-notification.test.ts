import { describe, it, expect, beforeEach, vi } from 'vitest'

// Shared, resettable state the mocked admin client reads/writes. vi.hoisted so
// it exists before the vi.mock factory runs.
const state = vi.hoisted(() => ({
  existingRow: null as any,
  inserts: [] as any[],
  dupeFilters: [] as Array<[string, unknown]>,
  insertError: null as { code?: string; message?: string } | null,
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from() {
      const b: any = {
        _isInsert: false,
        _payload: null,
        select() { return b },
        insert(payload: any) { b._isInsert = true; b._payload = payload; state.inserts.push(payload); return b },
        // Only the dupe-check query records filters (before .insert()).
        eq(col: string, val: unknown) { if (!b._isInsert) state.dupeFilters.push([col, val]); return b },
        gte(col: string, val: unknown) { state.dupeFilters.push([col, val]); return b },
        maybeSingle() { return Promise.resolve({ data: state.existingRow, error: null }) },
        single() {
          if (state.insertError) return Promise.resolve({ data: null, error: state.insertError })
          return Promise.resolve({ data: { id: 'notif-new', ...b._payload }, error: null })
        },
      }
      return b
    },
    rpc() { return Promise.resolve({ data: null, error: null }) },
  }),
}))

import { createNotificationSafe } from '@/lib/notifications'

beforeEach(() => {
  state.existingRow = null
  state.inserts = []
  state.dupeFilters = []
  state.insertError = null
})

const sendMessageNotification = (over: Record<string, unknown> = {}) =>
  createNotificationSafe({
    userId: 'user-B',
    type: 'message_received',
    data: { conversationId: 'conv-1', fromUserId: 'user-A', messageId: 'msg-1' },
    link: '/dashboard/messages/conv-1',
    dedupeKey: 'msg-1',
    ...over,
  })

describe('message_received notification — recipient + payload', () => {
  it('creates a notification for the recipient with the conversation link and messageId', async () => {
    const res = await sendMessageNotification()
    expect(res).not.toBeNull()
    expect(state.inserts).toHaveLength(1)
    const row = state.inserts[0]
    expect(row.user_id).toBe('user-B')                         // recipient, never the sender
    expect(row.link).toBe('/dashboard/messages/conv-1')        // opens the right conversation
    expect(row.data.conversationId).toBe('conv-1')
    expect(row.data.messageId).toBe('msg-1')
    expect(row.data.dedupeKey).toBe('msg-1')                   // key persisted for future dedup
  })

  it('sender-vs-recipient derivation (mirrors the send route) targets the other user', () => {
    const recipientOf = (m: { user_a_id: string; user_b_id: string }, senderId: string) =>
      m.user_a_id === senderId ? m.user_b_id : m.user_a_id
    expect(recipientOf({ user_a_id: 'A', user_b_id: 'B' }, 'A')).toBe('B')
    expect(recipientOf({ user_a_id: 'A', user_b_id: 'B' }, 'B')).toBe('A')
  })
})

describe('idempotency — dedupeKey path', () => {
  it('dedups by data->>dedupeKey with NO 24h time window', async () => {
    await sendMessageNotification()
    expect(state.dupeFilters).toContainEqual(['data->>dedupeKey', 'msg-1'])
    expect(state.dupeFilters.some(([c]) => c === 'created_at')).toBe(false)
  })

  it('a retry for the same message id does NOT create a duplicate', async () => {
    state.existingRow = { id: 'already-there' } // simulate the message notification already exists
    const res = await sendMessageNotification()
    expect(res).toBeNull()
    expect(state.inserts).toHaveLength(0)
  })

  it('a DIFFERENT message id still notifies', async () => {
    state.existingRow = null
    await sendMessageNotification({ dedupeKey: 'msg-2', data: { conversationId: 'conv-1', messageId: 'msg-2' } })
    expect(state.inserts).toHaveLength(1)
    expect(state.inserts[0].data.dedupeKey).toBe('msg-2')
  })
})

describe('race-proof idempotency — DB unique conflict is a clean no-op', () => {
  it('a 23505 unique_violation on insert returns null without throwing or surfacing an error', async () => {
    // Simulate the concurrency loser: the pre-select found nothing, but the DB
    // partial unique index (notifications_user_type_dedupe_key_uniq) rejects the
    // concurrent duplicate insert.
    state.existingRow = null
    state.insertError = { code: '23505', message: 'duplicate key value violates unique constraint' }
    let threw = false
    let res: unknown = 'unset'
    try {
      res = await sendMessageNotification()
    } catch {
      threw = true
    }
    expect(threw).toBe(false) // no error surfaced to the caller
    expect(res).toBeNull()    // clean idempotent no-op
    expect(state.inserts).toHaveLength(1) // it did attempt exactly one insert
  })

  it('a non-conflict insert error still returns null (unchanged behavior)', async () => {
    state.insertError = { code: '500', message: 'some other failure' }
    const res = await sendMessageNotification()
    expect(res).toBeNull()
  })
})

describe('existing notification types are unaffected (legacy 24h digest dedup)', () => {
  it('without a dedupeKey, dedups by created_at within 24h (not by data->>dedupeKey)', async () => {
    await createNotificationSafe({ userId: 'user-B', type: 'message_received', data: { conversationId: 'c' } })
    expect(state.dupeFilters.some(([c]) => c === 'created_at')).toBe(true)
    expect(state.dupeFilters.some(([c]) => c === 'data->>dedupeKey')).toBe(false)
  })
})
