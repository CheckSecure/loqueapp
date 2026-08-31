import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildSecureInviteEmail } from '../email/secureInvite'

const PREVIEW = readFileSync('app/api/admin/invitations/catch-up/preview/route.ts', 'utf8')
const EMAIL = readFileSync('lib/email.ts', 'utf8')

describe('preview never mints or leaks a real link', () => {
  it('does not call the link minters at all', () => {
    // A preview endpoint is exactly where "never returned, never logged, never stored" would
    // quietly break. Returning a real link would hand the holder a sign-in for someone else.
    // CODE lines only — the route's header comment names these functions while explaining that it
    // deliberately does not call them, and a bare toContain would match that prose.
    const code = PREVIEW.split('\n')
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('*') && !l.startsWith('//') && !l.startsWith('/*'))
      .join('\n')
    for (const fn of ['generateLink', 'mintBoundResumeLink', 'sendSecureInviteEmail', 'sendSecureInviteForWaitlist']) {
      expect(code, fn).not.toContain(fn)
    }
  })

  it('uses visibly inert placeholders', () => {
    expect(PREVIEW).toContain('#preview-only-no-real-sign-in-link-is-minted')
    expect(PREVIEW).toContain('#preview-only-no-real-resume-link-is-minted')
  })

  it('is admin-gated', () => {
    expect(PREVIEW).toContain("user.email !== ADMIN_EMAIL")
  })

  it('reads the referral lookup error rather than treating failure as no-consent', () => {
    expect(PREVIEW).toContain('if (rErr) return NextResponse.json')
  })
})

describe('preview renders the same code that sends', () => {
  it('the sender builds its payload from the shared builder', () => {
    expect(EMAIL).toContain('const built = buildSecureInviteEmail({')
    expect(EMAIL).toContain('subject: built.subject')
    expect(EMAIL).toContain('html: built.html')
    expect(EMAIL).toContain('text: built.text')
  })

  it('the template no longer lives inline in the sender', () => {
    // If the copy reappears in lib/email.ts, preview and send can drift again.
    expect(EMAIL).not.toContain("Set up my account</a>")
    expect(EMAIL).not.toContain("that's on us.")
  })
})

describe('builder output', () => {
  const named = buildSecureInviteEmail({
    toName: 'Paul Skalny', referrerName: 'Larry Katz',
    purpose: 'access_resend', link: 'https://x.test/a', resumeLink: 'https://x.test/r',
  })

  it('names the referrer and uses the first name only', () => {
    expect(named.html).toContain('Larry Katz recommended you for Andrel, and we sent you an invitation that expired')
    expect(named.html).toContain('Hi Paul,')
    expect(named.subject).toBe('Your Andrel invitation — a working link')
    expect(named.variant).toBe('access_resend')
  })

  it('renders the button and the resume fallback', () => {
    expect(named.html).toContain('>Set up my account</a>')
    expect(named.html).toContain('https://x.test/a')
    expect(named.html).toContain('request a fresh secure link')
    expect(named.html).toContain('https://x.test/r')
  })

  it('falls back to the anonymous variant with no consent', () => {
    const anon = buildSecureInviteEmail({
      toName: 'Paul Skalny', referrerName: null,
      purpose: 'access_resend', link: 'https://x.test/a', resumeLink: 'https://x.test/r',
    })
    expect(anon.html).toContain('You were recommended for Andrel, and we sent you an invitation that expired')
    expect(anon.html).not.toContain('Larry')
  })

  it('escapes a referrer name — it is member-supplied text in an HTML body', () => {
    const evil = buildSecureInviteEmail({
      toName: 'A B', referrerName: '<script>alert(1)</script>',
      purpose: 'access_resend', link: 'https://x.test/a',
    })
    expect(evil.html).not.toContain('<script>')
    expect(evil.html).toContain('&lt;script&gt;')
  })

  it('drops the resume paragraph when there is no resume link', () => {
    const noResume = buildSecureInviteEmail({
      toName: 'A B', purpose: 'access_resend', link: 'https://x.test/a', resumeLink: null,
    })
    expect(noResume.html).toContain('request a new link from the Andrel sign-in page')
    expect(noResume.html).not.toContain('request a fresh secure link')
  })

  it('first invite copy is unchanged', () => {
    const first = buildSecureInviteEmail({
      toName: 'Paul Skalny', referrerName: 'Larry Katz',
      purpose: 'first_invite', link: 'https://x.test/a',
    })
    expect(first.subject).toBe('Welcome to Andrel — set up your account')
    expect(first.html).toContain("You're invited to Andrel")
    expect(first.html).toContain('Larry Katz recommended you for Andrel. Use the secure link below')
    expect(first.html).not.toContain("that's on us")
  })
})
