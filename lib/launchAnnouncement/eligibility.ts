/**
 * lib/launchAnnouncement/eligibility.ts
 *
 * Shared eligibility logic for the launch-announcement email flow.
 * Used by both the preview route (read-only count + breakdown) and the
 * send route (the bulk fire). Keeping this in one place ensures the two
 * code paths can't drift on who is or isn't a valid recipient.
 */

import { createAdminClient } from '@/lib/supabase/admin'

export const OPERATOR_EMAIL_LOWER = 'bizdev91@gmail.com'

export type WaitlistRow = {
  id: string
  full_name: string | null
  email: string
  status: string | null
  created_at: string
  launch_announcement_sent_at: string | null
}

export type IneligibleReason =
  | 'already_sent'
  | 'status_declined'
  | 'status_invited'
  | 'already_active_member'
  | 'operator_account'

export type EligibilityResult = {
  eligible: WaitlistRow[]
  ineligible: Array<{ row: WaitlistRow; reason: IneligibleReason }>
}

/**
 * Compute the eligible set for the launch announcement.
 *
 * Two-step active-profile filter: PostgREST does not support correlated
 * subqueries, so we cannot express
 *   "waitlist.email NOT IN (SELECT email FROM profiles WHERE account_status='active')"
 * in a single PostgREST call. We fetch the two sets separately, normalize
 * emails to lowercase in JS, and apply the membership check after the
 * fetch. Same result as the SQL form, two round-trips instead of one.
 *
 * Rows whose status is anything other than 'pending', 'approved',
 * 'invited', or 'declined' (e.g. NULL or a future status string) are
 * silently dropped — they are neither eligible nor counted in the
 * ineligible breakdown. If a new status emerges, add an explicit
 * branch here so the operator can see it in the preview breakdown.
 */
export async function computeLaunchAnnouncementEligibility(): Promise<EligibilityResult> {
  const admin = createAdminClient()

  const { data: activeProfiles } = await admin
    .from('profiles')
    .select('email')
    .eq('account_status', 'active')

  const activeEmailSet = new Set(
    (activeProfiles ?? [])
      .map((p) => (typeof p.email === 'string' ? p.email.toLowerCase() : null))
      .filter((e): e is string => !!e)
  )

  const { data: waitlistRows } = await admin
    .from('waitlist')
    .select('id, full_name, email, status, created_at, launch_announcement_sent_at')
    .order('created_at', { ascending: true })

  const eligible: WaitlistRow[] = []
  const ineligible: Array<{ row: WaitlistRow; reason: IneligibleReason }> = []

  for (const row of (waitlistRows ?? []) as WaitlistRow[]) {
    // Order matters for the breakdown — most specific reason first.
    if (row.launch_announcement_sent_at !== null) {
      ineligible.push({ row, reason: 'already_sent' })
      continue
    }
    if (row.status === 'declined') {
      ineligible.push({ row, reason: 'status_declined' })
      continue
    }
    if (row.status === 'invited') {
      ineligible.push({ row, reason: 'status_invited' })
      continue
    }
    const emailLower = (row.email ?? '').toLowerCase()
    if (emailLower === OPERATOR_EMAIL_LOWER) {
      ineligible.push({ row, reason: 'operator_account' })
      continue
    }
    if (activeEmailSet.has(emailLower)) {
      ineligible.push({ row, reason: 'already_active_member' })
      continue
    }
    if (row.status !== 'pending' && row.status !== 'approved') {
      // Unknown status — silently drop, don't count.
      continue
    }
    eligible.push(row)
  }

  return { eligible, ineligible }
}
