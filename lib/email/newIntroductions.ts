/**
 * The "new introductions are available" email.
 *
 * WHAT THIS EMAIL MUST NOT DO, and why each rule exists:
 *
 *   It never identifies the proposed connections. Knowing WHO was suggested, before either side
 *   has responded, is precisely the disclosure the reciprocal design exists to prevent.
 *
 *   It never reveals whether anyone responded. A one-sided private interest must produce NO signal
 *   of any kind — the counterpart learns nothing until interest is mutual.
 *
 *   It states no count. The number is knowable from committed cards, but printing it turns the
 *   email into a side channel about the member's own queue depth for anyone reading over a
 *   shoulder, and it buys nothing. The copy works identically for one card or two.
 *
 *   It promises no match, no quality, no mutual interest, and does not claim that every member
 *   receives introductions every week. It says what is true: something is there to review.
 */

export const INTRODUCTIONS_URL = 'https://www.andrel.app/dashboard/introductions'

export interface BuiltEmail { subject: string; html: string; text: string }

/** Local escaper. lib/email.ts instantiates Resend at module load, so it is not imported here. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function newIntroductionsCopy(firstName: string | null) {
  const name = (firstName || '').trim() || 'there'
  return {
    subject: 'New introductions are available in Andrel',
    greeting: `Hi ${name},`,
    body: 'New curated introductions are available for you to review in Andrel.',
    privacy: 'Your response remains private. A connection is made only when interest is mutual.',
    cta: 'Review introductions',
    closing: ['Best,', 'Daniel', 'Founder, Andrel'],
  }
}

export function buildNewIntroductionsEmail(firstName: string | null): BuiltEmail {
  const c = newIntroductionsCopy(firstName)
  const html = `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1B2850; margin-bottom: 24px;">New introductions in Andrel</h2>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">${escapeHtml(c.greeting)}</p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">${escapeHtml(c.body)}</p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">${escapeHtml(c.privacy)}</p>
        <a href="${INTRODUCTIONS_URL}"
           style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
          ${escapeHtml(c.cta)}
        </a>
        <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
          ${c.closing.map(escapeHtml).join('<br/>')}
        </p>
      </div>`
  const text = [c.greeting, '', c.body, '', c.privacy, '', `${c.cta}: ${INTRODUCTIONS_URL}`, '', ...c.closing].join('\n')
  return { subject: c.subject, html, text }
}
