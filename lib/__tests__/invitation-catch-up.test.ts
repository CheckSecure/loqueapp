import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const ROUTE = readFileSync('app/api/admin/invitations/catch-up/route.ts', 'utf8')
const EMAIL = readFileSync('lib/email.ts', 'utf8')
const FORWAITLIST = readFileSync('lib/invitations/sendForWaitlist.ts', 'utf8')
const SECURE = readFileSync('lib/invitations/secureInvite.ts', 'utf8')

describe('catch-up route: dry run is the default', () => {
  it('sends only on the exact string "execute"', () => {
    expect(ROUTE).toContain("const execute = body.action === 'execute'")
  })

  it('the send call is guarded by that flag', () => {
    const guard = ROUTE.indexOf('if (!execute) {')
    const send = ROUTE.indexOf('await sendSecureInviteForWaitlist(')
    expect(guard).toBeGreaterThan(-1)
    expect(send).toBeGreaterThan(guard) // the early-return precedes any send
  })

  it('caps a single run so a filter mistake cannot mail everyone', () => {
    expect(ROUTE).toMatch(/const MAX_PER_RUN = \d+/)
    expect(ROUTE).toContain('Math.min(\n    MAX_PER_RUN,')
  })

  it('reuses the hardened ceremony rather than re-implementing it', () => {
    // If this route ever calls generateLink or the email sender directly, the pre-send delivery
    // claim and idempotency key are no longer guaranteed.
    expect(ROUTE).not.toContain('generateLink')
    expect(ROUTE).not.toContain('sendSecureInviteEmail')
  })

  it('separates a pending delivery from a bad address', () => {
    expect(ROUTE).toContain('blocked_delivery_pending')
    expect(ROUTE).toContain('blocked_bad_address')
    expect(ROUTE).toContain("['bounced', 'blocked', 'complained']")
  })

  it('uses the same status model the admin panel renders', () => {
    expect(ROUTE).toContain('inviteStatusModel(')
    expect(ROUTE).toContain('model.canResend || model.canRetry || model.needsConfirmResend')
  })

  it('gates the referrer name on explicit consent', () => {
    expect(ROUTE).toContain('referrer_consent_to_share')
    expect(ROUTE).toMatch(/referrer_consent_to_share\] === true|\.referrer_consent_to_share === true/)
  })

  it('honours the invitations pause switch', () => {
    expect(ROUTE).toContain('invitationsEnabled()')
    expect(ROUTE).toContain('canSendInvitation(email)')
  })
})

describe('purpose-aware invite copy', () => {
  it('one purpose drives both the delivery claim and the copy', () => {
    // secureInvite computes purpose for the claim; it must hand the SAME value to the sender.
    expect(SECURE).toContain("const purpose = plan === 'create' ? 'first_invite' : 'access_resend'")
    expect(SECURE).toMatch(/deps\.sendEmail\(\{[\s\S]{0,200}?purpose,/)
  })

  it('the resend variant acknowledges the gap and blames nobody but us', () => {
    expect(EMAIL).toContain("we sent you an invitation that expired before you had a chance to use it")
    expect(EMAIL).toContain("We didn't follow up — that's on us.")
    expect(EMAIL).toContain("Here's a fresh link, and this time a backup if it lapses again.")
  })

  it('carries no hardcoded month — the cohort spans several', () => {
    const resendCopy = EMAIL.slice(EMAIL.indexOf('const isResend'), EMAIL.indexOf('const secondLine'))
    expect(resendCopy).not.toMatch(/January|February|March|April|May|June|July|August|September|October|November|December/)
  })

  it('FIRST INVITES ARE UNAFFECTED — the original copy is still the default branch', () => {
    expect(EMAIL).toContain("You've been invited to join Andrel. Use the secure link below to set your password and finish setting up your account.")
    expect(EMAIL).toContain("recommended you for Andrel. Use the secure link below to set your password")
    expect(EMAIL).toContain("'Welcome to Andrel — set up your account'")
  })

  it('the plain-text part branches too, so a text client never sees the wrong wording', () => {
    const textPart = EMAIL.slice(EMAIL.indexOf('      text:\n'))
    expect(textPart.slice(0, 900)).toContain('isResend')
  })

  it('the anonymous resend variant exists for nominees with no consent', () => {
    expect(EMAIL).toContain('You were recommended for Andrel, and we')
  })

  it('sendForWaitlist passes the consent-gated name through rather than looking it up', () => {
    expect(FORWAITLIST).toContain('referrerName: args.referrerName ?? null')
    // CODE lines only — the file's doc comment names the consent column while explaining that the
    // lookup lives at the caller, and a bare toContain would match that prose.
    const code = FORWAITLIST.split('\n')
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('*') && !l.startsWith('//') && !l.startsWith('/*'))
      .join('\n')
    expect(code).not.toContain('referrer_consent_to_share')
  })
})
