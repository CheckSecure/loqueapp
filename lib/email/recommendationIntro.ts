/**
 * Pure builder for the warm recommendation-introduction email — the message a
 * founder sends BEFORE any account is created, to start the relationship. Shared
 * by the email sender (server) and the admin preview modal (client) so the preview
 * is byte-identical to what actually sends.
 *
 * This email intentionally contains NO password, NO login button, NO credentials,
 * and NO signup CTA — only a plain, personally-written note with a reply-based CTA
 * and a privacy-management link. Keep it plain-text.
 */

/** First name only, for a personal greeting ("Hello Sarah,"). Empty string when
 *  no usable name — the caller drops to a plain "Hello," rather than "Hello there,". */
export function firstNameOf(fullName: string | null | undefined): string {
  return (fullName || '').trim().split(/\s+/)[0] || ''
}

export interface RecommendationIntroInput {
  recommenderName: string
  nomineeName: string
  /** Absolute URL to the privacy / manage-information page (token embedded). */
  manageUrl: string
}

export interface RecommendationIntroEmail {
  subject: string
  /** Plain-text body — rendered as-is (no HTML). */
  text: string
}

export function buildRecommendationIntroEmail(input: RecommendationIntroInput): RecommendationIntroEmail {
  const name = (input.recommenderName || '').trim()
  const hasName = name.length > 0

  // Subject + opening read naturally whether or not we have a recommender name —
  // no doubled "A founding member, a founding member of Andrel…".
  const subject = hasName ? `${name} recommended you` : 'A founding member of Andrel recommended you'
  const opening = hasName
    ? `${name}, a founding member of Andrel, recommended you for consideration and shared your professional contact information with us.`
    : `A founding member of Andrel recommended you for consideration and shared your professional contact information with us.`

  // "Hello Sarah," when we have a first name; a plain "Hello," otherwise.
  const firstName = firstNameOf(input.nomineeName)
  const greeting = firstName ? `Hello ${firstName},` : 'Hello,'

  const text = `${greeting}

${opening}

Andrel is a private network for senior legal and executive leaders. Members don't send connection requests or browse profiles—they receive a small number of curated introductions, and only when both people have expressed interest.

If you're interested, I'd be happy to tell you more or answer any questions. Just reply to this email.

Best,

Daniel Abramoff
Founder, Andrel

Manage your information here: ${input.manageUrl}`

  return { subject, text }
}
