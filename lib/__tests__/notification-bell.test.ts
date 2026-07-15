import { describe, it, expect } from 'vitest'
import {
  realtimeFilterForUser,
  isOwnNotification,
  scopedNotificationsQuery,
  markAllReadQuery,
  markOneReadQuery,
  markConversationMessageNotificationsReadQuery,
} from '@/lib/notifications/bell'

/**
 * Fake PostgREST-style query builder that records the filter/mutation calls the
 * helpers make, so we can assert user-ownership scoping without Supabase.
 */
function makeFakeClient() {
  const calls = {
    from: null as string | null,
    select: null as string | null,
    update: null as unknown,
    eq: [] as [string, unknown][],
    in: [] as [string, unknown][],
    is: [] as [string, unknown][],
  }
  const builder: any = {
    from(t: string) { calls.from = t; return builder },
    select(s: string) { calls.select = s; return builder },
    update(u: unknown) { calls.update = u; return builder },
    eq(col: string, val: unknown) { calls.eq.push([col, val]); return builder },
    in(col: string, vals: unknown) { calls.in.push([col, vals]); return builder },
    is(col: string, val: unknown) { calls.is.push([col, val]); return builder },
    order() { return builder },
    limit() { return builder },
  }
  return { builder, calls }
}

const USER = 'user-A'
const OTHER = 'user-B'

describe('realtime ownership — another user\'s insert is ignored', () => {
  it('rejects a payload row belonging to a different user', () => {
    expect(isOwnNotification({ user_id: OTHER }, USER)).toBe(false)
  })
  it('rejects null/undefined rows and missing user', () => {
    expect(isOwnNotification(null, USER)).toBe(false)
    expect(isOwnNotification(undefined, USER)).toBe(false)
    expect(isOwnNotification({ user_id: undefined }, USER)).toBe(false)
    expect(isOwnNotification({ user_id: USER }, null)).toBe(false)
  })
})

describe('realtime ownership — the signed-in user\'s insert appears', () => {
  it('accepts a payload row belonging to the signed-in user', () => {
    expect(isOwnNotification({ user_id: USER }, USER)).toBe(true)
  })
  it('builds a server-side filter scoped to the user', () => {
    expect(realtimeFilterForUser(USER)).toBe('user_id=eq.user-A')
  })
})

describe('initial query is scoped to the signed-in user', () => {
  it('adds .eq(user_id, uid) to the notifications read (not RLS-only)', () => {
    const { builder, calls } = makeFakeClient()
    scopedNotificationsQuery(builder, USER)
    expect(calls.from).toBe('notifications')
    expect(calls.select).toBe('*')
    expect(calls.eq).toContainEqual(['user_id', USER])
  })
})

describe('mark-read cannot affect another user\'s rows', () => {
  it('mark-all-read constrains by user_id AND the id set', () => {
    const { builder, calls } = makeFakeClient()
    markAllReadQuery(builder, USER, ['1', '2'], '2026-01-01T00:00:00.000Z')
    expect(calls.from).toBe('notifications')
    expect(calls.update).toEqual({ read_at: '2026-01-01T00:00:00.000Z' })
    expect(calls.eq).toContainEqual(['user_id', USER])
    expect(calls.in).toContainEqual(['id', ['1', '2']])
  })
  it('mark-one-read constrains by user_id AND the row id', () => {
    const { builder, calls } = makeFakeClient()
    markOneReadQuery(builder, USER, 'notif-1', '2026-01-01T00:00:00.000Z')
    expect(calls.eq).toContainEqual(['user_id', USER])
    expect(calls.eq).toContainEqual(['id', 'notif-1'])
    // The user_id constraint is always present, so it can never target another user's row.
    expect(calls.eq.some(([col]) => col === 'user_id')).toBe(true)
  })
})

describe('marking one conversation read does not clear unrelated notifications', () => {
  it('scopes to user + message_received + THIS conversation + still-unread only', () => {
    const { builder, calls } = makeFakeClient()
    markConversationMessageNotificationsReadQuery(builder, USER, 'conv-1', '2026-01-01T00:00:00.000Z')
    expect(calls.from).toBe('notifications')
    expect(calls.update).toEqual({ read_at: '2026-01-01T00:00:00.000Z' })
    expect(calls.eq).toContainEqual(['user_id', USER])
    expect(calls.eq).toContainEqual(['type', 'message_received'])
    expect(calls.eq).toContainEqual(['data->>conversationId', 'conv-1'])
    expect(calls.is).toContainEqual(['read_at', null])
  })

  it('a different conversation targets a different filter (never each other)', () => {
    const a = makeFakeClient()
    const b = makeFakeClient()
    markConversationMessageNotificationsReadQuery(a.builder, USER, 'conv-1', 'T')
    markConversationMessageNotificationsReadQuery(b.builder, USER, 'conv-2', 'T')
    expect(a.calls.eq).toContainEqual(['data->>conversationId', 'conv-1'])
    expect(a.calls.eq).not.toContainEqual(['data->>conversationId', 'conv-2'])
    expect(b.calls.eq).toContainEqual(['data->>conversationId', 'conv-2'])
  })
})

describe('bell live-update reducer (realtime INSERT) + unread count', () => {
  // Mirrors NotificationBell: dedupe by id, prepend, unread = !read_at count.
  const applyInsert = (prev: any[], row: any) => (prev.some(n => n.id === row.id) ? prev : [row, ...prev])
  const unread = (list: any[]) => list.filter(n => !n.read_at).length

  it('a new realtime row appears and increments the unread count', () => {
    const start = [{ id: 'n1', read_at: '2026-01-01' }] // already read
    expect(unread(start)).toBe(0)
    const next = applyInsert(start, { id: 'n2', read_at: null })
    expect(next).toHaveLength(2)
    expect(unread(next)).toBe(1)
  })

  it('a duplicate realtime row (same id) does not double-count', () => {
    const list = [{ id: 'n2', read_at: null }]
    const next = applyInsert(list, { id: 'n2', read_at: null })
    expect(next).toHaveLength(1)
    expect(unread(next)).toBe(1)
  })
})
