/**
 * The delivery purposes recorded in public.reminder_deliveries.
 *
 * Each purpose carries its OWN dedupe authority, and they must never be conflated:
 *
 *   WEDNESDAY_UNANSWERED    keyed on the ISO week. One per member per week, by definition.
 *   CATCHUP_UNANSWERED      keyed on a fixed campaign string. One per member, ever.
 *   NEW_INTRODUCTIONS       keyed on event_key — a fingerprint of the COMMITTED cards. A member can
 *                           legitimately receive introductions twice in one week, so a week key
 *                           would silently swallow the second delivery.
 *
 * NAME NOTE: the review called the weekly purpose 'wednesday_unanswered'. The value already
 * deployed and pinned by migration 065's CHECK is 'wednesday_intro_reminder'. Renaming it would
 * break the running cron the moment the constraint changed, so the live name is kept. See 069.
 */

export const WEDNESDAY_UNANSWERED = 'wednesday_intro_reminder' as const
export const NEW_INTRODUCTIONS = 'new_introductions' as const

/**
 * THE catch-up campaign key. Fixed in server code and never accepted from a request body — a
 * caller who could choose the key could choose a key nobody has used and re-mail everyone.
 */
export const CATCHUP_CAMPAIGN_KEY = 'unanswered-intros-catchup-2026-08-20' as const
export const CATCHUP_UNANSWERED = 'catchup_unanswered_2026_08_20' as const

export type DeliveryPurpose =
  | typeof WEDNESDAY_UNANSWERED
  | typeof CATCHUP_UNANSWERED
  | typeof NEW_INTRODUCTIONS
