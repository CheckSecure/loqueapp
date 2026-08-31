/**
 * Shared eligibility logic for the one-time member referral campaign
 * ("Help us grow the Andrel network"). Used by the preview route (read-only
 * report) and the send route (the bulk fire) so the two paths can never drift on
 * who is or isn't a valid recipient.
 *
 * Recipient rules (a member must satisfy ALL to be eligible):
 *   • active account         — profiles.account_status === 'active'
 *   • completed onboarding    — profiles.profile_complete === true
 *   • usable email            — non-blank, passes a basic format check
 *   • NOT a test/demo account — profiles.is_test_account !== true (demo accounts
 *                               are flagged the same way; there is no separate flag)
 *   • NOT the operator/admin  — profiles.is_admin !== true and not the operator email
 *   • NOT already sent        — profiles.referral_campaign_sent_at IS NULL (the sole
 *                               dedupe source of truth; makes the campaign resumable)
 *
 *   • NOT unsubscribed        — the member has not turned OFF email_product_updates
 *                               in notification_preferences (the existing unsubscribe
 *                               mechanism; fails open if migration 002 isn't applied)
 *
 * Dedupe column safety: referral_campaign_sent_at arrives in migration 035. Until
 * it is applied the select fails open — we retry WITHOUT the column and treat every
 * member as un-sent. (Do not run the campaign before 035 is applied; the preview
 * surfaces `dedupeColumnPresent: false` so this is visible.)
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { probeExpectation, SCHEMA_EXPECTATIONS } from '@/lib/db/migrationHealth'

export const OPERATOR_EMAIL_LOWER = 'bizdev91@gmail.com'

/**
 * Migrations the SEND route hard-depends on. 035 backs the dedupe/resume marker;
 * 037 backs referrer-consent storage, which the campaign email explicitly promises
 * ("if you choose to allow it, we'll mention that you recommended them"). The send
 * route refuses to run until BOTH are present — do NOT assume only 035 is required.
 * (036/relationship is NOT required — it is unrelated to the campaign's guarantees.)
 */
export const REQUIRED_CAMPAIGN_MIGRATIONS = [
  '035_profiles_referral_campaign_sent.sql',
  '037_referrals_referrer_consent.sql',
]

/** Read-only probe of the campaign's required migrations. */
export async function checkRequiredCampaignMigrations(): Promise<{ ok: boolean; missing: string[] }> {
  const admin = createAdminClient()
  const needed = SCHEMA_EXPECTATIONS.filter((e) => REQUIRED_CAMPAIGN_MIGRATIONS.includes(e.migration))
  const missing: string[] = []
  for (const e of needed) {
    const { present } = await probeExpectation(admin, e)
    if (!present) missing.push(e.migration)
  }
  return { ok: missing.length === 0, missing }
}

// Same basic format check the referral submit route uses. Not a deliverability
// guarantee — just "is this a usable-looking address" so we never send to junk.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type MemberRow = {
  id: string
  email: string | null
  full_name: string | null
  account_status: string | null
  is_test_account: boolean | null
  is_admin: boolean | null
  profile_complete: boolean | null
  referral_campaign_sent_at: string | null
}

export type ReferralCampaignEligibility = {
  eligible: Array<{ id: string; email: string; full_name: string | null }>
  breakdown: {
    totalProfiles: number
    activeMembers: number
    eligible: number
    excludedDeactivated: number
    excludedTestDemo: number
    excludedAdminOperator: number
    excludedOnboarding: number
    excludedInvalidEmail: number
    excludedOptedOut: number
    alreadySent: number
    internalOverridden: number
  }
  dedupeColumnPresent: boolean
}

const BASE_COLS = 'id, email, full_name, account_status, is_test_account, is_admin, profile_complete'
const ABSENT_RE = /does not exist|schema cache|could not find|42703|42P01|PGRST20[45]/i

function isEligible(m: MemberRow): boolean {
  if (m.account_status !== 'active') return false
  if (m.is_test_account === true) return false
  if (m.is_admin === true) return false
  if ((m.email ?? '').toLowerCase() === OPERATOR_EMAIL_LOWER) return false
  if (m.profile_complete !== true) return false
  const email = (m.email ?? '').trim()
  if (!email || !EMAIL_REGEX.test(email)) return false
  if (m.referral_campaign_sent_at != null) return false
  return true
}

/**
 * Which exclusions apply. Both default TRUE, preserving the email campaign's behaviour exactly —
 * a caller that passes nothing gets what /api/admin/referral-campaign/send has always got.
 *
 * The notification broadcast overrides `respectEmailSentStamp`, because
 * profiles.referral_campaign_sent_at is the EMAIL channel's bookkeeping. Letting it suppress an
 * in-app notification would mean the members most engaged with the campaign — the ones already
 * emailed — are the only ones who never see it in the product. The notification has its own
 * exact-once guarantee via the dedupeKey unique index, so it does not need this stamp at all.
 */
export interface EligibilityOptions {
  /** Skip members already stamped referral_campaign_sent_at (the EMAIL channel's marker). */
  respectEmailSentStamp?: boolean
  /** Skip members who turned OFF email_product_updates in settings. */
  respectEmailOptOut?: boolean
  /**
   * Member ids that bypass the INTERNAL exclusions (is_test_account, is_admin, operator email).
   *
   * Exists so an operator can send a campaign to themselves and actually see it. Every internal
   * marker is on the operator's own account, so a self-test otherwise returns attempted: 0 with no
   * indication why.
   *
   * MUST ONLY EVER BE POPULATED FROM AN EXPLICIT LIST OF IDS. A broadcast — any run that does not
   * name its recipients — has to pass this empty, or the campaign reaches internal accounts. The
   * override is deliberately narrow: it waives the internal markers ONLY. Deactivated, incomplete
   * profile, invalid email and the opt-out still exclude a named account, because none of those
   * are about being internal and all of them would make the send wrong or impossible.
   */
  alwaysInclude?: string[]
}

export async function computeReferralCampaignEligibility(
  opts: EligibilityOptions = {},
): Promise<ReferralCampaignEligibility> {
  const respectEmailSentStamp = opts.respectEmailSentStamp !== false
  const respectEmailOptOut = opts.respectEmailOptOut !== false
  const alwaysInclude = new Set(opts.alwaysInclude ?? [])
  const admin = createAdminClient()

  // Try to read the dedupe column; fail open to "column absent → all un-sent" if
  // migration 035 has not been applied yet.
  let dedupeColumnPresent = true
  let rows: MemberRow[] = []
  const withCol = await admin.from('profiles').select(`${BASE_COLS}, referral_campaign_sent_at`)
  if (withCol.error && ABSENT_RE.test(`${withCol.error.message} ${withCol.error.code ?? ''}`)) {
    dedupeColumnPresent = false
    const withoutCol = await admin.from('profiles').select(BASE_COLS)
    rows = (withoutCol.data ?? []).map((r: any) => ({ ...r, referral_campaign_sent_at: null }))
  } else {
    rows = (withCol.data ?? []) as MemberRow[]
  }

  // Unsubscribe: exclude members who turned OFF email_product_updates (the existing
  // preference/unsubscribe mechanism, managed at /dashboard/settings). Fails open —
  // if notification_preferences (migration 002) isn't applied, nobody is excluded.
  const optedOut = new Set<string>()
  const prefs = await admin.from('notification_preferences').select('user_id, email_product_updates')
  if (!prefs.error) {
    for (const p of (prefs.data ?? []) as any[]) {
      if (p.email_product_updates === false) optedOut.add(p.user_id)
    }
  }

  const breakdown = {
    totalProfiles: rows.length,
    activeMembers: 0,
    eligible: 0,
    excludedDeactivated: 0,
    excludedTestDemo: 0,
    excludedAdminOperator: 0,
    excludedOnboarding: 0,
    excludedInvalidEmail: 0,
    excludedOptedOut: 0,
    alreadySent: 0,
    /** Internal accounts admitted because they were explicitly named. Always 0 on a broadcast. */
    internalOverridden: 0,
  }
  const eligible: Array<{ id: string; email: string; full_name: string | null }> = []

  for (const m of rows) {
    // Deactivated / non-active is counted against the whole population, then the
    // remaining funnel is measured on active members only (each active member is
    // assigned to exactly ONE bucket, first match wins, so buckets sum to active).
    if (m.account_status !== 'active') { breakdown.excludedDeactivated++; continue }
    breakdown.activeMembers++

    // Explicitly named → the internal markers are waived, and the override is COUNTED so a dry
    // run shows it happened rather than silently including an account that is normally excluded.
    const internalOverride = alwaysInclude.has(m.id)
    const isInternal = m.is_test_account === true
      || m.is_admin === true
      || (m.email ?? '').toLowerCase() === OPERATOR_EMAIL_LOWER
    if (isInternal && internalOverride) {
      breakdown.internalOverridden++
    } else {
      if (m.is_test_account === true) { breakdown.excludedTestDemo++; continue }
      if (m.is_admin === true || (m.email ?? '').toLowerCase() === OPERATOR_EMAIL_LOWER) { breakdown.excludedAdminOperator++; continue }
    }
    if (m.profile_complete !== true) { breakdown.excludedOnboarding++; continue }
    const email = (m.email ?? '').trim()
    if (!email || !EMAIL_REGEX.test(email)) { breakdown.excludedInvalidEmail++; continue }
    if (respectEmailOptOut && optedOut.has(m.id)) { breakdown.excludedOptedOut++; continue }
    if (respectEmailSentStamp && m.referral_campaign_sent_at != null) { breakdown.alreadySent++; continue }

    eligible.push({ id: m.id, email, full_name: m.full_name })
  }
  breakdown.eligible = eligible.length

  return { eligible, breakdown, dedupeColumnPresent }
}

export { isEligible }
