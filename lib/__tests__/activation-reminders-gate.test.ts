import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The activation-reminders cron is SUPERSEDED and now sends nothing, in any mode.
 *
 * It previously sent two reminders whose only call to action was /auth/forgot-password — the
 * password-reset flow — and it disqualified anyone whose auth user had last_sign_in_at set, so the
 * people who signed in and stalled mid-onboarding could never be reminded again.
 *
 * This file used to prove the route stayed silent while the rollout gate was closed. That property
 * is now unconditional, which is strictly stronger: there is no mode, secret or input that makes it
 * send. The gate coverage that still matters moved to the staged worker that replaced it, and is
 * asserted at the bottom.
 */

const state = vi.hoisted(() => ({ emailCalls: 0, dbWrites: [] as any[], listUsersCalls: 0 }))

vi.mock('@/lib/email', () => new Proxy({}, {
  get: () => async () => { state.emailCalls++; return { success: true } },
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { listUsers: async () => { state.listUsersCalls++; return { data: { users: [] }, error: null } } } },
    from: () => ({ update: (p: any) => { state.dbWrites.push(p); return { eq: async () => ({ error: null }) } } }),
  }),
}))

import { GET } from '@/app/api/cron/activation-reminders/route'

const call = (secret = 'test-secret') =>
  GET(new Request('http://localhost/api/cron/activation-reminders', { headers: { authorization: `Bearer ${secret}` } }))

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  state.emailCalls = 0
  state.dbWrites = []
  state.listUsersCalls = 0
})

describe('activation-reminders is a permanent no-op', () => {
  it('still requires the cron secret', async () => {
    expect((await call('wrong')).status).toBe(401)
  })

  it('sends ZERO emails, writes ZERO rows and enumerates ZERO users', async () => {
    const res = await call()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ superseded: true, sent: 0 })
    expect(state.emailCalls).toBe(0)
    expect(state.dbWrites).toEqual([])
    expect(state.listUsersCalls).toBe(0)
  })

  it('is silent regardless of the rollout mode — no gate can re-enable it', async () => {
    for (const mode of ['off', 'test', 'on']) {
      process.env.INVITATIONS_MODE = mode
      await call()
      expect(state.emailCalls).toBe(0)
    }
    delete process.env.INVITATIONS_MODE
  })

  it('names its replacement, so the schedule is not a mystery', async () => {
    const body = await (await call()).json()
    expect(body.replacement).toMatch(/reminderWorker/)
  })

  it('contains no send path and no reminder-timestamp write at all', () => {
    // Code only: the file's header deliberately DOCUMENTS the old /auth/forgot-password defect, so
    // the raw text legitimately contains that string.
    const code = readFileSync('app/api/cron/activation-reminders/route.ts', 'utf8')
      .split('\n').filter(l => { const t = l.trimStart(); return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*') })
      .join('\n')
    expect(code).not.toMatch(/resend\.emails\.send|sendInviteReminder|sendOnboardingReminder/)
    expect(code).not.toMatch(/invite_reminder_[12]_sent_at/)
    expect(code).not.toMatch(/auth\/forgot-password/)
    // and the explanation is still present, in the comment where it belongs
    expect(readFileSync('app/api/cron/activation-reminders/route.ts', 'utf8')).toMatch(/auth\/forgot-password/)
  })
})

describe('the rollout gate now guards the staged worker instead', () => {
  it('the worker refuses to run unless invitations mode is "on"', () => {
    const w = readFileSync('lib/onboarding/reminderWorker.ts', 'utf8')
    expect(w).toMatch(/if \(!activationRemindersEnabled\(\)\) return \{ \.\.\.empty, paused: true \}/)
    // and the gate check precedes any query
    expect(w.indexOf('activationRemindersEnabled()')).toBeLessThan(w.indexOf(".from('waitlist')"))
  })

  it('each recipient is checked against the per-address gate as well', () => {
    const w = readFileSync('lib/onboarding/reminderWorker.ts', 'utf8')
    expect(w).toMatch(/if \(!canSendInvitation\(w\.email\)\)/)
  })
})
