import { describe, it, expect, vi, beforeEach } from 'vitest'

// The mirror route reads the AUTHORITATIVE email from getUser() and writes it to the caller's own
// profiles row. It must ignore/reject any client-supplied email or user id.
let user: any = { id: 'me', email: 'old@x.com' }   // getUser() — the authoritative (verified) auth email
let currentMirror = 'old@x.com'                     // what profiles.email currently holds
const updateSpy = vi.fn((_p: any) => {})
let eqTarget: any[] = []

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (_t: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: currentMirror } }) }) }),
      update: (payload: any) => { updateSpy(payload); return { eq: async (c: string, v: any) => { eqTarget = [c, v]; return { error: null } } } },
    }),
  }),
}))

import { POST } from '@/app/api/profile/change-email/route'

const req = (body?: any, opts: { origin?: boolean } = {}) => ({
  headers: new Headers({
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(opts.origin === false ? { 'sec-fetch-site': 'cross-site' } : { 'sec-fetch-site': 'same-origin' }),
  }),
  json: async () => (body ?? {}),
}) as any

beforeEach(() => { user = { id: 'me', email: 'old@x.com' }; currentMirror = 'old@x.com'; updateSpy.mockClear(); eqTarget = [] })

describe('profile/change-email — mirror is authoritative (never client-supplied)', () => {
  it('cross-origin → 403, no write', async () => {
    const res = await POST(req({}, { origin: false }))
    expect(res.status).toBe(403); expect(updateSpy).not.toHaveBeenCalled()
  })
  it('unauthenticated → 401', async () => {
    user = null
    const res = await POST(req())
    expect(res.status).toBe(401); expect(updateSpy).not.toHaveBeenCalled()
  })
  it('client-supplied arbitrary email → 400, mirror NOT written with it', async () => {
    user = { id: 'me', email: 'old@x.com' }
    const res = await POST(req({ email: 'attacker@evil.com' }))
    expect(res.status).toBe(400)
    expect(updateSpy).not.toHaveBeenCalled()
  })
  it('client-supplied user id → 400, no cross-user write', async () => {
    const res = await POST(req({ userId: 'victim' }))
    expect(res.status).toBe(400)
    expect(updateSpy).not.toHaveBeenCalled()
  })
  it('mirrors ONLY getUser().user.email (writes the authoritative auth email, scoped to the caller)', async () => {
    user = { id: 'me', email: 'new@x.com' }; currentMirror = 'old@x.com' // auth email already changed (confirmed)
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ email: 'new@x.com' })
    expect(eqTarget).toEqual(['id', 'me']) // caller's OWN row only
  })
  it('pending/unverified new email does NOT become authoritative (getUser still old → no-op)', async () => {
    user = { id: 'me', email: 'old@x.com' }; currentMirror = 'old@x.com' // change not yet confirmed
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect((await res.json()).updated).toBe(false)
    expect(updateSpy).not.toHaveBeenCalled() // pending address never mirrored
  })
  it('another member cannot be changed — even a matching body id is rejected; valid path targets user.id', async () => {
    // Forged body id → 400 (no write).
    expect((await POST(req({ userId: 'someone-else', email: 'x@x.com' }))).status).toBe(400)
    expect(updateSpy).not.toHaveBeenCalled()
    // Valid path always writes .eq('id', <session user id>).
    user = { id: 'me', email: 'new@x.com' }; currentMirror = 'old@x.com'
    await POST(req())
    expect(eqTarget).toEqual(['id', 'me'])
  })
  it('legitimate confirmed change → mirror updated to the verified auth email', async () => {
    user = { id: 'me', email: 'confirmed@x.com' }; currentMirror = 'old@x.com'
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect((await res.json()).updated).toBe(true)
    expect(updateSpy.mock.calls[0][0].email).toBe('confirmed@x.com')
  })
})
