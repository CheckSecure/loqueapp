import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  makeUnsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeHeaders,
  unsubscribeFooterHtml,
  unsubscribeFooterText,
} from '../email/unsubscribe'

const EMAIL_TS = readFileSync(join(__dirname, '..', 'email.ts'), 'utf8')

describe('unsubscribe token', () => {
  it('round-trips email and category', () => {
    const t = makeUnsubscribeToken('Person@Example.COM', 'email_messages')
    expect(verifyUnsubscribeToken(t)).toEqual({ email: 'person@example.com', category: 'email_messages' })
  })

  it('is deterministic, so a link in an old email keeps working', () => {
    expect(makeUnsubscribeToken('a@b.com', 'invitations')).toBe(makeUnsubscribeToken('a@b.com', 'invitations'))
  })

  it('rejects a tampered payload', () => {
    const t = makeUnsubscribeToken('a@b.com', 'invitations')
    const [payload, sig] = t.split('.')
    const forged = Buffer.from('victim@b.com|invitations', 'utf8').toString('base64url')
    expect(verifyUnsubscribeToken(`${forged}.${sig}`)).toBeNull()
    expect(verifyUnsubscribeToken(`${payload}.${sig.slice(0, -1)}x`)).toBeNull()
    expect(verifyUnsubscribeToken(payload)).toBeNull()
    expect(verifyUnsubscribeToken(null)).toBeNull()
  })
})

describe('RFC 8058 headers', () => {
  const h = unsubscribeHeaders('a@b.com', 'email_messages')

  it('emits the one-click POST header', () => {
    expect(h['List-Unsubscribe-Post']).toBe('List=One-Click')
  })

  it('carries both a mailto and an https URI, in that order', () => {
    expect(h['List-Unsubscribe']).toMatch(/^<mailto:[^>]+>, <https:\/\/[^>]+>$/)
  })

  it('points at the token route, NOT the login-gated settings page', () => {
    // The pre-existing referral header pointed at /dashboard/settings, which a gateway probe hits
    // as a login redirect and an invitee cannot use at all. That must never come back.
    expect(h['List-Unsubscribe']).toContain('/api/email/unsubscribe?token=')
    expect(h['List-Unsubscribe']).not.toContain('/dashboard/settings')
  })

  it('the URL resolves back to the recipient it was built for', () => {
    const url = h['List-Unsubscribe'].match(/<(https:[^>]+)>/)![1]
    const token = decodeURIComponent(new URL(url).searchParams.get('token')!)
    expect(verifyUnsubscribeToken(token)).toEqual({ email: 'a@b.com', category: 'email_messages' })
  })
})

describe('visible footer', () => {
  it('html footer links to the token URL', () => {
    expect(unsubscribeFooterHtml('a@b.com', 'invitations')).toContain('/api/email/unsubscribe?token=')
  })
  it('text footer links to the token URL', () => {
    expect(unsubscribeFooterText('a@b.com', 'invitations')).toContain('/api/email/unsubscribe?token=')
  })
})

describe('coverage: every outbound send carries unsubscribe metadata', () => {
  // Mirrors lib/__tests__/graph-read-hardening.test.ts: the point is not to test one call site but
  // to make it impossible to ADD a send that silently skips the headers.
  const rawSendLines = EMAIL_TS.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes('resend.emails.send('))

  it('only sendManaged and the operator alert call resend directly', () => {
    // sendManaged's own call is the wrapper itself; sendAdminAlertEmail is hardcoded to the
    // operator's address and is not list mail. Any third raw send is a coverage hole.
    expect(rawSendLines).toHaveLength(2)
  })

  it('transactional mail carries no headers and no footer', () => {
    const h = unsubscribeHeaders('a@b.com', 'invitations')
    // Sanity: the helper itself always builds headers; the exemption lives in sendManaged, which
    // skips both the headers and the footer when the category is 'transactional'.
    expect(h['List-Unsubscribe-Post']).toBe('List=One-Click')
    expect(EMAIL_TS).toContain("const transactional = unsubscribeCategory === 'transactional'")
    expect(EMAIL_TS).toMatch(/transactional \? \{\} : unsubscribeHeaders\(/)
    expect(EMAIL_TS).toMatch(/transactional \? html : html \+ unsubscribeFooterHtml\(/)
    expect(EMAIL_TS).toMatch(/transactional \? text : text \+ unsubscribeFooterText\(/)
  })

  it('the transactional exemptions are exactly the three we intend', () => {
    // A deliberately brittle list. Adding a fourth exemption should require justifying it here.
    // Password reset / magic link / email verification are absent because Supabase Auth sends
    // them — they never pass through this file at all.
    // Count CODE lines only — a prose mention of the literal in a doc comment must not count.
    const codeLines = EMAIL_TS.split('\n')
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('*') && !l.startsWith('//') && !l.startsWith('/*'))
    const exemptions = codeLines.filter((l) => l === "unsubscribeCategory: 'transactional',")
    const conditional = codeLines.filter((l) =>
      l.startsWith("unsubscribeCategory: args.purpose === 'account_recovery'"))
    expect(exemptions).toHaveLength(2)   // calendar invite (.ics), waitlist confirmation
    expect(conditional).toHaveLength(1)  // secure invite, recovery path only
  })

  it('ungated bulk sends check suppressions, so a one-click unsubscribe is honored', () => {
    // isPrefEnabled only covers sends that have a notification_preferences row to consult. The
    // pre-account mail has none, so it must consult email_suppressions directly or the unsubscribe
    // link would be decorative.
    const guards = EMAIL_TS.match(/await isSuppressed\(/g) ?? []
    expect(guards.length).toBe(8)
  })

  it('every sendManaged call declares an unsubscribeCategory', () => {
    const calls = EMAIL_TS.split('sendManaged(').slice(1)
    // slice(1) drops the text before the first occurrence; the first remaining chunk is the
    // function DEFINITION, the rest are call sites.
    const callSites = calls.slice(1)
    expect(callSites.length).toBe(25)
    for (const chunk of callSites) {
      expect(chunk.slice(0, 400)).toContain('unsubscribeCategory:')
    }
  })
})
