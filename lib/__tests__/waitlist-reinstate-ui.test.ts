import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { computeLifecycle, lifecycleLabel } from '@/lib/waitlist/lifecycle'
import { resolveInviteAction } from '@/lib/invitations'

const base = {
  email: 'x@example.com',
  invite_reminder_1_sent_at: null,
  invite_reminder_2_sent_at: null,
  first_matching_reminder_sent_at: null,
  profileComplete: false,
}
const NOW = Date.parse('2026-08-10T12:00:00Z')

describe('Reinstate is never shown as a delivered invitation', () => {
  it("status='invited' with invited_at NULL (reinstated) → 'Reinstated — invitation not sent'", () => {
    const lc = computeLifecycle({ ...base, status: 'invited', invited_at: null }, NOW)
    expect(lc.state).toBe('missing_invited_at')
    expect(lc.lastEmail).toBeNull()             // no email was ever sent
    expect(lc.canSendActivationEmail).toBe(false)
    expect(lifecycleLabel(lc.state)).toBe('Reinstated — invitation not sent')
  })
  it("a genuinely sent invitation (invited_at set) reads as 'Invite sent' — a DISTINCT state", () => {
    const lc = computeLifecycle({ ...base, status: 'invited', invited_at: '2026-08-10T11:50:00Z' }, NOW)
    expect(lc.state).toBe('invite_sent')
    expect(lifecycleLabel(lc.state)).toBe('Invite sent')
    expect(lifecycleLabel(lc.state)).not.toBe('Reinstated — invitation not sent')
  })
})

describe('safe next-action routing (resolveInviteAction — reinstate recovery paths)', () => {
  it('NO auth user → invitation (create exactly one auth user), never a reset', () => {
    const d = resolveInviteAction({ authExists: false, activated: false, action: 'invite' })
    expect(d.plan).toBe('create')
    expect(d.plan).not.toBe('reset')
  })
  it('auth user exists (not activated) → password reset, NEVER a duplicate create', () => {
    const d = resolveInviteAction({ authExists: true, activated: false, action: 'invite' })
    expect(d.plan).toBe('reset')
    expect(d.plan).not.toBe('create')
  })
  it('active member + generic send → refuses (must use explicit password reset); no auto-reset', () => {
    const d = resolveInviteAction({ authExists: true, activated: true, action: 'invite' })
    expect(d.plan).toBe('active')
  })
})

describe('Invited tab UI uses the ONE shared invitation-state model (structural)', () => {
  const client = readFileSync('components/AdminWaitlistClient.tsx', 'utf8')
  it('renders the shared inviteStatus badge (no competing lifecycle-derived status logic)', () => {
    expect(client).toContain('entry.inviteStatus')            // the shared model drives the badge
    expect(client).toMatch(/INVITE_TONE_CLASS\[st\.tone\]/)   // tone → style via the shared map
    expect(client).toMatch(/warning: 'text-amber-800/)        // reinstated/not_sent → amber (warning tone)
  })
  it('a reinstated (not_sent) row shows an explicit "no email sent" helper keyed off the shared model', () => {
    expect(client).toMatch(/st\?\.key === 'not_sent'/)
    expect(client).toContain('no invitation email has been sent yet')
  })
  it('the next action label is "Send invitation" for a not_sent row (shared-model driven)', () => {
    expect(client).toMatch(/st\?\.key === 'not_sent' \? 'Send invitation'/)
  })
  it('bounced/blocked/complained disable a blind resend (button disabled on the blocked flag)', () => {
    expect(client).toMatch(/disabled=\{processing === entry\.id \|\| blocked\}/)
  })
  it('delivered-but-inactive requires confirmation before a NEW secure link', () => {
    expect(client).toMatch(/needsConfirmResend && !stale && !window\.confirm/)
  })
  it('a stale (past-window) claim requires an explicit confirm + forces a new attempt', () => {
    expect(client).toMatch(/stale && !window\.confirm/)
    expect(client).toMatch(/handleSendInvite\(entry\.id, stale\)/) // stale → force=true
  })
  it('does NOT auto-send during Reinstate (reinstate handler posts only to the reinstate route)', () => {
    expect(client).toContain("fetch('/api/admin/waitlist/reinstate'")
    // the reinstate handler must not call the invite/send-invite/password-reset routes
    expect(client).not.toMatch(/doReinstate[\s\S]{0,600}\/api\/admin\/send-invite/)
    expect(client).not.toMatch(/doReinstate[\s\S]{0,600}send-password-reset/)
  })
  it('no recovery link / token / password reaches the client (only state/message are read)', () => {
    expect(client).not.toMatch(/data\.(link|action_link|token|hashed_token|recovery_url|password)/)
  })
})
