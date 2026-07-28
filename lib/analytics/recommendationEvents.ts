/**
 * Lightweight recommendation-funnel instrumentation. Deliberately minimal: one
 * structured console line per event (same style as the app's other structured
 * logs), no external analytics service, no DB table. A log pipeline can grep these.
 *
 * The only five events tracked:
 *   recommendation_submitted   — a member submitted a nomination
 *   recommendation_approved    — founder approved a nomination
 *   recommendation_email_sent  — founder sent the warm recommendation email
 *   recommendation_invite_sent — founder sent the official (temp-password) invite
 *   recommendation_joined      — nominee activated (completed onboarding)
 */
export type RecommendationEvent =
  | 'recommendation_submitted'
  | 'recommendation_approved'
  | 'recommendation_email_sent'
  | 'recommendation_invite_sent'
  | 'recommendation_joined'

export function logRecommendationEvent(
  event: RecommendationEvent,
  data: Record<string, unknown> = {},
): void {
  try {
    // eslint-disable-next-line no-console
    console.log(`[analytics] ${JSON.stringify({ event, ...data })}`)
  } catch {
    // eslint-disable-next-line no-console
    console.log(`[analytics] event=${event}`)
  }
}
