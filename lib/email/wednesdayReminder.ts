import { wednesdayReminderCopy, INTRODUCTIONS_URL } from '@/lib/reminders/wednesdayIntroReminder'

/**
 * Local escape, deliberately NOT imported from lib/email.ts. That module constructs the Resend
 * client at import time, so depending on it would make this pure builder unloadable — and therefore
 * untestable — without a provider API key. A template should not require a mail provider to exist.
 */
function escapeHtml(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * The Wednesday unanswered-introduction email.
 *
 * PRIVACY IS THE POINT. The body knows the RECIPIENT'S first name and a COUNT, and nothing else.
 * It never names the proposed connection, their employer, whether they responded, or whether they
 * expressed interest — and it carries no pair id, request id or user id. That is why the builder
 * takes only (firstName, openCount): there is no parameter through which an identity could leak.
 *
 * It also never promises a Thursday introduction. It says the next batch is PREPARED Thursday and
 * that unanswered cards occupy slots — true for every recipient, and a promise to none.
 */
export interface BuiltEmail { subject: string; html: string; text: string }

export function buildWednesdayReminderEmail(firstName: string | null, openCount: number): BuiltEmail {
  const c = wednesdayReminderCopy(firstName, openCount)
  const g = escapeHtml(c.greeting)
  const html = `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1B2850; margin-bottom: 24px;">Your Andrel introductions</h2>
      <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">${g}</p>
      <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
        ${escapeHtml(c.countLine)}
      </p>
      <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
        ${escapeHtml(c.body)}
      </p>
      <a href="${INTRODUCTIONS_URL}"
         style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
        ${escapeHtml(c.cta)}
      </a>
      <p style="color: #64748b; font-size: 14px; margin-top: 32px; line-height: 1.6;">
        ${c.closing.map((l) => escapeHtml(l)).join('<br />')}
      </p>
    </div>
  `.trim()

  const text = [
    c.greeting, '', c.countLine, '', c.body, '',
    `${c.cta}: ${INTRODUCTIONS_URL}`, '', ...c.closing,
  ].join('\n')

  return { subject: c.subject, html, text }
}
