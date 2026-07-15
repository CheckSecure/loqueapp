import { describe, it, expect } from 'vitest'
import {
  realtimeFilterForUser,
  isOwnNotification,
  scopedNotificationsQuery,
  markAllReadQuery,
  markOneReadQuery,
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
  }
  const builder: any = {
    from(t: string) { calls.from = t; return builder },
    select(s: string) { calls.select = s; return builder },
    update(u: unknown) { calls.update = u; return builder },
    eq(col: string, val: unknown) { calls.eq.push([col, val]); return builder },
    in(col: string, vals: unknown) { calls.in.push([col, vals]); return builder },
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
