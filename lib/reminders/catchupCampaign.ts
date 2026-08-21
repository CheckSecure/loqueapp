/**
 * The ONE-TIME unanswered-introduction catch-up campaign.
 *
 * This week's ordinary Wednesday window passed before the reminder code was deployed, so the
 * members who currently hold unanswered cards were never reminded. This campaign covers exactly
 * that gap, once, under explicit admin action — it is not a schedule and must never become one.
 *
 * REQUEST SHAPE IS A WHITELIST, NOT A FILTER. Anything not exactly one of the three permitted
 * shapes is rejected. A campaign endpoint that accepts a cohort, a date, a wildcard, or a list of
 * recipients is a mass-mail primitive; this one can only do three things, and the campaign key it
 * dedupes on is not one of its inputs.
 */

export const CATCHUP_MAX_RECIPIENTS = 300
export const CATCHUP_DEADLINE_MS = 25_000

export type CatchupMode =
  | { kind: 'dry_run' }
  | { kind: 'test_recipient'; email: string }
  | { kind: 'full_campaign' }

export type ParseResult =
  | { ok: true; mode: CatchupMode }
  | { ok: false; reason: string }

const ALLOWED_KEY_SETS: ReadonlyArray<ReadonlyArray<string>> = [
  ['dryRun'],
  ['dryRun', 'testRecipient'],
  ['dryRun', 'confirmFullCampaign'],
]

function keysMatch(keys: string[], allowed: ReadonlyArray<string>): boolean {
  return keys.length === allowed.length && allowed.every((k) => keys.includes(k))
}

/**
 * Strict shape validation. Pure, so the whole rejection surface is testable without a request.
 * Rejects: non-objects, arrays, extra keys, missing keys, wrong types, wildcards, and anything
 * resembling a UUID or cohort selector — none of which are accepted keys in the first place.
 */
export function parseCatchupBody(raw: unknown): ParseResult {
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'body_not_object' }
  if (Array.isArray(raw)) return { ok: false, reason: 'body_is_array' }

  const body = raw as Record<string, unknown>
  const keys = Object.keys(body)
  if (!ALLOWED_KEY_SETS.some((a) => keysMatch(keys, a))) return { ok: false, reason: 'unrecognised_keys' }
  if (typeof body.dryRun !== 'boolean') return { ok: false, reason: 'dryRun_not_boolean' }

  if (keysMatch(keys, ['dryRun'])) {
    // The single-key shape is the DRY RUN. { dryRun: false } alone is not a licence to mail
    // everyone — the full campaign needs its own explicit confirmation key.
    if (body.dryRun !== true) return { ok: false, reason: 'full_campaign_requires_confirmation' }
    return { ok: true, mode: { kind: 'dry_run' } }
  }

  if (keysMatch(keys, ['dryRun', 'testRecipient'])) {
    if (body.dryRun !== false) return { ok: false, reason: 'test_recipient_requires_dryRun_false' }
    const email = body.testRecipient
    if (typeof email !== 'string') return { ok: false, reason: 'testRecipient_not_string' }
    const trimmed = email.trim()
    // EXACT address only. No wildcard, no list, no pattern.
    if (!trimmed || trimmed.length > 320) return { ok: false, reason: 'testRecipient_invalid' }
    if (/[*%,;\s]/.test(trimmed)) return { ok: false, reason: 'testRecipient_not_exact' }
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(trimmed)) return { ok: false, reason: 'testRecipient_invalid' }
    return { ok: true, mode: { kind: 'test_recipient', email: trimmed.toLowerCase() } }
  }

  if (body.dryRun !== false) return { ok: false, reason: 'full_campaign_requires_dryRun_false' }
  if (body.confirmFullCampaign !== true) return { ok: false, reason: 'full_campaign_requires_confirmation' }
  return { ok: true, mode: { kind: 'full_campaign' } }
}

/**
 * Masked address for the admin response. Enough for the operator to recognise a recipient they
 * already know, not enough to be an address list: `daniel@example.com` -> `d****l@example.com`.
 */
export function maskEmail(email: string | null): string {
  if (!email || !email.includes('@')) return '(no email)'
  const [local, domain] = email.split('@')
  if (local.length <= 2) return `${local[0] ?? ''}***@${domain}`
  return `${local[0]}${'*'.repeat(Math.max(1, local.length - 2))}${local[local.length - 1]}@${domain}`
}
