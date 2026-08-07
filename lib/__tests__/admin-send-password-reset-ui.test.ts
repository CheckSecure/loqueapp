import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { requestMemberPasswordReset, RESET_SUCCESS, RESET_FAILURE } from '@/lib/admin/sendPasswordReset'

/**
 * Admin "Send password reset" UI wiring. Behavioral tests use a MOCK fetch — NO real
 * reset email is ever sent. Structural tests assert the button/confirm/states and that
 * this action is admin-only and never surfaces a link/token.
 */

// A fake fetch that records the request and returns a scripted response.
function fakeFetch(status: number, body: any, capture?: (url: string, init: any) => void) {
  return (async (url: string, init: any) => {
    capture?.(url, init)
    return { ok: status >= 200 && status < 300, status, json: async () => body } as any
  }) as unknown as typeof fetch
}

describe('requestMemberPasswordReset (behavioral, mocked fetch — no real email)', () => {
  it('sends the correct memberId to the admin route', async () => {
    let seenUrl = '', seenBody: any = null
    await requestMemberPasswordReset('member-123', fakeFetch(200, { ok: true, sent: true }, (u, i) => { seenUrl = u; seenBody = JSON.parse(i.body) }))
    expect(seenUrl).toBe('/api/admin/send-password-reset')
    expect(seenBody).toEqual({ memberId: 'member-123' })
  })

  it('SUCCESS state when the server reports sent:true', async () => {
    const r = await requestMemberPasswordReset('m1', fakeFetch(200, { ok: true, sent: true }))
    expect(r).toEqual({ kind: 'success', message: RESET_SUCCESS })
    expect(r.message).toBe('Password reset email requested.')
  })

  it('FAILURE (neutral) when the provider did not send (sent:false)', async () => {
    const r = await requestMemberPasswordReset('m1', fakeFetch(200, { ok: true, sent: false, errorClass: 'rate_limited' }))
    expect(r).toEqual({ kind: 'error', message: RESET_FAILURE })
    expect(r.message).toBe('Unable to send reset email. Try again or check auth logs.')
  })

  it('FAILURE on a non-2xx response (e.g. 401/500)', async () => {
    const r = await requestMemberPasswordReset('m1', fakeFetch(401, { error: 'Not authorized' }))
    expect(r.kind).toBe('error')
  })

  it('FAILURE on a network throw', async () => {
    const throwing = (async () => { throw new Error('network') }) as unknown as typeof fetch
    const r = await requestMemberPasswordReset('m1', throwing)
    expect(r.kind).toBe('error')
  })

  it('NEVER surfaces a link/token/password — even if the server erroneously returned one', async () => {
    const r = await requestMemberPasswordReset('m1', fakeFetch(200, { ok: true, sent: true, action_link: 'https://secret', hashed_token: 'abc', password: 'x' }))
    // The result carries ONLY the neutral kind + message — never any injected secret field.
    expect(Object.keys(r).sort()).toEqual(['kind', 'message'])
    expect(r.message).toBe(RESET_SUCCESS)
    const s = JSON.stringify(r)
    expect(s).not.toMatch(/action_link|hashed_token|https:\/\/secret|"abc"/i)
  })
})

describe('admin member UI wiring (structural)', () => {
  const client = readFileSync('components/AdminMembersClient.tsx', 'utf8')

  it('renders the "Send password reset" action button', () => {
    expect(client).toContain('Send password reset')
    expect(client).toContain("data-testid=\"send-password-reset\"")
  })

  it('has a confirmation step before sending', () => {
    expect(client).toContain('Send a password reset email to')
  })

  it('shows loading + disables repeated clicks while in flight', () => {
    expect(client).toContain('resetLoading')
    expect(client).toContain("resetLoading ? 'Sending…' : 'Send reset email'")
    expect(client).toContain('disabled={resetLoading}')
    expect(client).toContain('if (!resettingUser || resetLoading) return') // re-entrancy guard
  })

  it('delegates the request to the safe helper and shows only neutral messages', () => {
    expect(client).toContain('requestMemberPasswordReset(resettingUser.id)')
    // the component itself never parses a link/token/raw response
    expect(client).not.toMatch(/action_link|hashed_token|properties/)
  })
})

describe('admin-only surface (no non-admin component gets this action)', () => {
  it('the reset action lives only on the admin members surface, not on any member-facing component', () => {
    // AdminMembersClient is rendered only by the admin members page (route under /dashboard/admin).
    const page = readFileSync('app/dashboard/admin/members/page.tsx', 'utf8')
    expect(page).toContain('AdminMembersClient')
    // no member-facing surface references the admin reset route or button
    for (const f of ['components/NetworkCard.tsx', 'components/NetworkList.tsx', 'components/MessagesClient.tsx']) {
      const src = readFileSync(f, 'utf8')
      expect(src).not.toContain('send-password-reset')
      expect(src).not.toContain('requestMemberPasswordReset')
    }
  })
})
