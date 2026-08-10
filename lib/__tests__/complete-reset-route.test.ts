import { describe, it, expect, beforeEach, vi } from 'vitest'
import { issueContinuationToken, CONTINUATION_COOKIE } from '@/lib/auth/resetContinuation'

// Route-level trust boundary: password_reset_required is cleared ONLY as a first-hand result of a
// server-performed updateUser, or on a valid server-issued continuation cookie. No client value can.

const state = vi.hoisted(() => ({
  user: { id: 'u1' } as any,
  updateUserError: null as any,
  adminExisting: { id: 'u1', profile_complete: false } as any,
  adminUpdateResult: { data: { id: 'u1', profile_complete: false }, error: null } as any,
  adminUpdateCalls: [] as any[],
  updateUserCalls: 0,
  jar: null as any,
}))

function makeJar() {
  const m = new Map<string, string>()
  return {
    _m: m,
    get: (name: string) => (m.has(name) ? { value: m.get(name)! } : undefined),
    set: (name: string, value: string, opts: any) => { if (opts && opts.maxAge === 0) m.delete(name); else m.set(name, value) },
  }
}

vi.mock('next/headers', () => ({ cookies: () => state.jar }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user }, error: state.user ? null : { message: 'no session' } }),
      updateUser: async () => { state.updateUserCalls++; return { error: state.updateUserError } },
    },
  }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.adminExisting, error: null }) }) }),
      update: (p: any) => { state.adminUpdateCalls.push(p); return { eq: () => ({ select: () => ({ maybeSingle: async () => state.adminUpdateResult }) }) } },
    }),
  }),
}))

import { POST } from '@/app/api/auth/complete-reset/route'

const post = (body: any) =>
  POST(new Request('http://localhost/api/auth/complete-reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))

beforeEach(() => {
  process.env.RESET_CONTINUATION_SECRET = 'route-test-secret'
  state.user = { id: 'u1' }
  state.updateUserError = null
  state.adminExisting = { id: 'u1', profile_complete: false }
  state.adminUpdateResult = { data: { id: 'u1', profile_complete: false }, error: null }
  state.adminUpdateCalls = []
  state.updateUserCalls = 0
  state.jar = makeJar()
})

describe('complete-reset route — auth', () => {
  it('no session → 401, no password update, no flag clear', async () => {
    state.user = null
    const res = await post({ mode: 'set', password: 'longenough' })
    expect(res.status).toBe(401)
    expect(state.updateUserCalls).toBe(0)
    expect(state.adminUpdateCalls).toHaveLength(0)
  })
})

describe('complete-reset route — mode set', () => {
  it('short password → 400 stage:update, no updateUser, no clear', async () => {
    const res = await post({ mode: 'set', password: 'short' })
    expect(res.status).toBe(400)
    expect((await res.json()).stage).toBe('update')
    expect(state.updateUserCalls).toBe(0)
    expect(state.adminUpdateCalls).toHaveLength(0)
  })
  it('updateUser FAILS → 422 stage:update, flag NOT cleared', async () => {
    state.updateUserError = { message: 'boom' }
    const res = await post({ mode: 'set', password: 'longenough' })
    expect(res.status).toBe(422)
    expect((await res.json()).stage).toBe('update')
    expect(state.adminUpdateCalls).toHaveLength(0) // never cleared without a confirmed update
  })
  it('updateUser succeeds, profile complete → clears flag + dest introductions', async () => {
    state.adminExisting = { id: 'u1', profile_complete: true }
    state.adminUpdateResult = { data: { id: 'u1', profile_complete: true }, error: null }
    const res = await post({ mode: 'set', password: 'longenough' })
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, dest: '/dashboard/introductions' })
    expect(state.adminUpdateCalls).toHaveLength(1)
  })
  it('updateUser succeeds, no profile → onboarding, no update needed', async () => {
    state.adminExisting = null
    const res = await post({ mode: 'set', password: 'longenough' })
    expect(await res.json()).toMatchObject({ ok: true, dest: '/dashboard/onboarding' })
    expect(state.adminUpdateCalls).toHaveLength(0)
  })
  it('updateUser succeeds but finalize fails → stage:finalize AND a continuation cookie is retained', async () => {
    state.adminUpdateResult = { data: null, error: { code: '42501' } } // clear fails
    const res = await post({ mode: 'set', password: 'longenough' })
    expect((await res.json())).toMatchObject({ ok: false, stage: 'finalize' })
    expect(state.jar._m.has(CONTINUATION_COOKIE)).toBe(true) // retry evidence issued
  })
})

describe('complete-reset route — mode finalize (password-free) is server-authorized only', () => {
  it('NO continuation cookie (e.g. forged client marker) → 401, flag NOT cleared', async () => {
    const res = await post({ mode: 'finalize' })
    expect(res.status).toBe(401)
    expect(state.adminUpdateCalls).toHaveLength(0)
  })
  it('FORGED cookie value → 401, flag NOT cleared', async () => {
    state.jar.set(CONTINUATION_COOKIE, 'u1.9999999999999.deadbeef', {})
    const res = await post({ mode: 'finalize' })
    expect(res.status).toBe(401)
    expect(state.adminUpdateCalls).toHaveLength(0)
  })
  it("a continuation cookie for a DIFFERENT user cannot finalize the current user", async () => {
    state.jar.set(CONTINUATION_COOKIE, issueContinuationToken('someone-else', Date.now())!, {})
    const res = await post({ mode: 'finalize' })
    expect(res.status).toBe(401)
    expect(state.adminUpdateCalls).toHaveLength(0)
  })
  it('a VALID server-issued cookie for THIS user → clears flag + dest (finalize-only retry preserved)', async () => {
    state.jar.set(CONTINUATION_COOKIE, issueContinuationToken('u1', Date.now())!, {})
    const res = await post({ mode: 'finalize' })
    expect(await res.json()).toMatchObject({ ok: true, dest: '/dashboard/onboarding' })
    expect(state.adminUpdateCalls).toHaveLength(1)
    expect(state.updateUserCalls).toBe(0) // never re-changes the password
  })
})
