/**
 * Pure builder for a nomination-invitation email. Deliberately in its OWN module with no provider
 * import, so the exact subject and body of every campaign are unit-testable without a Resend API key
 * (importing lib/email.ts constructs the client and throws in tests).
 *
 * The copy is shared across campaigns and parameterized only by the nominator's name, the campaign's
 * one-sentence intro, and the subject. It deliberately:
 *   - greets the recipient by FIRST NAME;
 *   - attributes the nomination to the nominator WITHOUT claiming they wrote the message (it is
 *     signed by Daniel, Founder — the nominator is named in the third person);
 *   - contains EXACTLY ONE call to action: the secure account-setup link;
 *   - promises nothing about admission, a match, or any particular introduction;
 *   - names no other recipient.
 */

/** Local HTML escape — duplicated rather than imported so this module stays provider-free. */
function esc(s: string | null | undefined): string {
  if (!s) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface NominationInviteCopy {
  nominatorName: string
  /** The sentence completing "<Nominator> invited you to join Andrel, <intro>." */
  intro: string
  firstName: string
  link: string
  subject: string
}

export function buildNominationInviteEmail(
  args: NominationInviteCopy,
): { subject: string; html: string; text: string } {
  const firstName = (args.firstName || '').trim() || 'there'
  const nominator = args.nominatorName.trim()
  const intro = args.intro.trim()
  return {
    subject: args.subject,
    html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; color:#334155;">
          <h2 style="color:#1B2850; margin-bottom:16px;">You're invited to Andrel</h2>
          <p style="font-size:16px; line-height:1.6;">Hi ${esc(firstName)},</p>
          <p style="font-size:16px; line-height:1.6;">${esc(nominator)} invited you to join Andrel, ${esc(intro)}.</p>
          <p style="font-size:16px; line-height:1.6;">Members are connected through selective introductions based on their experience, interests, and goals. There are no public feeds and no cold outreach.</p>
          <p style="font-size:16px; line-height:1.6;">The secure link below will set up your account:</p>
          <p style="margin:28px 0;">
            <a href="${args.link}" style="display:inline-block; background:#1B2850; color:#ffffff; text-decoration:none; font-size:16px; font-weight:600; padding:14px 32px; border-radius:10px;">Create your Andrel account</a>
          </p>
          <p style="font-size:16px; line-height:1.6; margin-top:24px;">Best,<br/>Daniel<br/><span style="color:#64748b;">Founder, Andrel</span></p>
          <p style="font-size:13px; color:#94a3b8; line-height:1.6; margin-top:20px;">This link is personal to you — please don't forward it. It expires for your protection; if it no longer works, request a new one from the Andrel sign-in page.</p>
        </div>`,
    text:
      `You're invited to Andrel.\n\n` +
      `Hi ${firstName},\n\n` +
      `${nominator} invited you to join Andrel, ${intro}.\n\n` +
      `Members are connected through selective introductions based on their experience, interests, and goals. There are no public feeds and no cold outreach.\n\n` +
      `The secure link below will set up your account:\n\n` +
      `Create your Andrel account: ${args.link}\n\n` +
      `Best,\nDaniel\nFounder, Andrel\n\n` +
      `This link is personal to you — please don't forward it. It expires for your protection.`,
  }
}
