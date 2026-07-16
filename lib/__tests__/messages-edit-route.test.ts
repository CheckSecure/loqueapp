import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const nowIso = () => new Date().toISOString()
const minsAgoIso = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

const state = vi.hoisted(() => ({
  user: { id: 'sender-1' } as { id: string } | null,
  message: null as any,
  fetchError: null as any,
  updateResult: [] as any[],
  updateError: null as any,
  lastUpdatePayload: null as any,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const b: any = {
        _isUpdate: false,
        select: () => b,
        update: (payload: any) => { b._isUpdate = true; state.lastUpdatePayload = payload; return b },
        eq: () => b,
        maybeSingle: () => Promise.resolve({ data: state.message, error: state.fetchError }),
        then: (res: any, rej: any) =>
          Promise.resolve(
            b._isUpdate
              ? { data: state.updateResult, error: state.updateError }
              : { data: state.message, error: state.fetchError },
          ).then(res, rej),
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/messages/edit/route'

const post = (body: any) =>
  POST(new Request('http://localhost/api/messages/edit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))

beforeEach(() => {
  state.user = { id: 'sender-1' }
  state.message = { id: 'm1', sender_id: 'sender-1', is_system: false, created_at: minsAgoIso(10) }
  state.fetchError = null
  state.updateResult = [{ id: 'm1', content: 'edited', edited_at: nowIso(), created_at: state.message.created_at }]
  state.updateError = null
  state.lastUpdatePayload = null
})

describe('messages/edit route — authorization & window', () => {
  it('sender can edit within 60 minutes; updates only content + edited_at (created_at preserved)', async () => {
    const res = await post({ messageId: 'm1', content: '  new text  ' })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data).toMatchObject({ success: true })
    expect(data.message.edited_at).toBeTruthy()
    // The DB update payload sets ONLY content + edited_at — never created_at.
    expect(Object.keys(state.lastUpdatePayload).sort()).toEqual(['content', 'edited_at'])
    expect(state.lastUpdatePayload.content).toBe('new text') // trimmed
    expect('created_at' in state.lastUpdatePayload).toBe(false)
  })

  it('sender cannot edit after 60 minutes', async () => {
    state.message.created_at = minsAgoIso(61)
    const res = await post({ messageId: 'm1', content: 'late edit' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/edit window/i)
    expect(state.lastUpdatePayload).toBeNull() // no write attempted
  })

  it('recipient (not the sender) cannot edit', async () => {
    state.user = { id: 'recipient-1' }
    const res = await post({ messageId: 'm1', content: 'hijack' })
    expect(res.status).toBe(403)
    expect(state.lastUpdatePayload).toBeNull()
  })

  it('unauthenticated request fails', async () => {
    state.user = null
    const res = await post({ messageId: 'm1', content: 'x' })
    expect(res.status).toBe(401)
  })

  it('system message cannot be edited', async () => {
    state.message.is_system = true
    const res = await post({ messageId: 'm1', content: 'x' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/system/i)
  })

  it('blank / whitespace-only content is rejected', async () => {
    const res = await post({ messageId: 'm1', content: '   ' })
    expect(res.status).toBe(400)
    expect(state.lastUpdatePayload).toBeNull()
  })

  it('missing message → 404', async () => {
    state.message = null
    const res = await post({ messageId: 'nope', content: 'x' })
    expect(res.status).toBe(404)
  })

  it('a 0-row update never reports a false success', async () => {
    state.updateResult = [] // e.g. lost a race / guard mismatch
    const res = await post({ messageId: 'm1', content: 'x' })
    expect(res.status).toBe(409)
    expect((await res.json()).success).toBeUndefined()
  })
})

describe('messages/edit route — no notification, no email', () => {
  it('the route imports/uses no notification or email side effects', () => {
    const src = readFileSync('app/api/messages/edit/route.ts', 'utf8')
    // No notification module or helper is imported/called.
    expect(src).not.toMatch(/from ['"]@\/lib\/notifications['"]/)
    expect(src).not.toMatch(/createNotificationSafe|createNotification\b/)
    // No email module or send helper is imported/called.
    expect(src).not.toMatch(/from ['"]@\/lib\/email['"]/)
    expect(src).not.toMatch(/sendInviteEmail|sendNewMessageEmail|sendMatchCreatedEmail/)
  })
})
