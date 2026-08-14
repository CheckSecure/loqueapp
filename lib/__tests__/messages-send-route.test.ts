import { describe, it, expect, vi, beforeEach } from 'vitest'

let user: any = { id: 'u1' }
const coreSpy = vi.fn(async (..._a: any[]): Promise<any> => ({ ok: true, status: 200, message: { id: 'm' }, isFirstMessage: true }))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/messages/sendMessageCore', () => ({ sendMessageCore: (...a: any[]) => coreSpy(...a) }))

import { POST } from '@/app/api/messages/send/route'

const req = (body: any, opts: { origin?: boolean; ct?: string } = {}) => ({
  headers: new Headers({
    'content-type': opts.ct ?? 'application/json',
    ...(opts.origin === false ? { 'sec-fetch-site': 'cross-site' } : { 'sec-fetch-site': 'same-origin' }),
  }),
  json: async () => body,
}) as any

beforeEach(() => { user = { id: 'u1' }; coreSpy.mockClear(); coreSpy.mockResolvedValue({ ok: true, status: 200, message: { id: 'm' }, isFirstMessage: true }) })

describe('messages/send route — same-origin + strict body, delegates to the shared core', () => {
  it('cross-origin → 403, core never called', async () => {
    const res = await POST(req({ conversationId: 'c', content: 'hi' }, { origin: false }))
    expect(res.status).toBe(403); expect(coreSpy).not.toHaveBeenCalled()
  })
  it('unauthenticated → 401', async () => {
    user = null
    const res = await POST(req({ conversationId: 'c', content: 'hi' }))
    expect(res.status).toBe(401); expect(coreSpy).not.toHaveBeenCalled()
  })
  it('extra key → 400, core never called', async () => {
    const res = await POST(req({ conversationId: 'c', content: 'hi', evil: 1 }))
    expect(res.status).toBe(400); expect(coreSpy).not.toHaveBeenCalled()
  })
  it('non-string fields → 400', async () => {
    const res = await POST(req({ conversationId: ['c'], content: 'hi' }))
    expect(res.status).toBe(400); expect(coreSpy).not.toHaveBeenCalled()
  })
  it('valid → passes server-derived senderId (user.id) to the core, maps ok', async () => {
    const res = await POST(req({ conversationId: 'c1', content: 'hi' }))
    expect(res.status).toBe(200)
    expect(coreSpy).toHaveBeenCalledTimes(1)
    expect(coreSpy.mock.calls[0][1]).toMatchObject({ senderId: 'u1', conversationId: 'c1', content: 'hi' })
  })
  it('core rejection is surfaced with its status (generic 403)', async () => {
    coreSpy.mockResolvedValue({ ok: false, status: 403, code: 'forbidden', error: 'This conversation is unavailable.' })
    const res = await POST(req({ conversationId: 'c1', content: 'hi' }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('This conversation is unavailable.')
  })
})
