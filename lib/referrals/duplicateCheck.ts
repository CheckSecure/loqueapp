/**
 * Pre-send duplicate protection for the warm recommendation email.
 *
 * Before the founder contacts a nominee we check the nominee's email against every
 * place a prior relationship could exist — active member profiles, existing auth
 * users, other waitlist rows (already contacted / invited), and prior referrals
 * (previously declined). If a conflict is found we return a human-readable reason
 * plus whether the founder may override it, so nothing is ever sent silently.
 *
 * Override policy (enforced by the caller):
 *   • already an active member        → never overridable
 *   • already invited / contacted      → overridable (stale, unanswered outreach)
 *   • previously recommended (pending) → overridable (added context may matter)
 *   • previously DECLINED              → overridable ONLY with a new recommender AND
 *                                        an explicit founder reason (not "time passed")
 */

import { findAuthUserByEmail } from '@/lib/invitations'

export type DuplicateCode =
  | 'ALREADY_MEMBER'
  | 'ALREADY_INVITED'
  | 'ALREADY_CONTACTED'
  | 'DUPLICATE_RECOMMENDATION'
  | 'PREVIOUSLY_DECLINED'

export interface DuplicateFinding {
  blocked: boolean
  code?: DuplicateCode
  reason?: string
  /** Whether the founder is permitted to override this block at all. */
  overridable?: boolean
  /** Whether an explicit founder reason is required to override (declined case). */
  requiresReason?: boolean
}

const CLEAR: DuplicateFinding = { blocked: false }

function shortDate(iso: string | null | undefined): string {
  if (!iso) return 'an earlier date'
  const d = new Date(iso)
  return isNaN(d.getTime())
    ? 'an earlier date'
    : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/**
 * Run the duplicate checks for `email`, ignoring the nominee's own waitlist row
 * (`selfWaitlistId`). `admin` is a service-role Supabase client.
 */
export async function checkNomineeDuplicates(
  admin: any,
  email: string,
  selfWaitlistId: string,
): Promise<DuplicateFinding> {
  const target = (email || '').trim()
  if (!target) return CLEAR

  // 1) Already an active member (profiles). Never overridable.
  const { data: member } = await admin
    .from('profiles')
    .select('id')
    .ilike('email', target)
    .neq('account_status', 'deactivated')
    .maybeSingle()
  if (member) {
    return { blocked: true, code: 'ALREADY_MEMBER', reason: 'Already an Andrel member', overridable: false }
  }

  // 2) Already an auth user (has an account even if profile is incomplete). Never
  //    overridable. Uses findAuthUserByEmail, which paginates ALL auth users
  //    (perPage 1000, looping) — reliable regardless of account count, unlike a
  //    single listUsers() page.
  try {
    const authUser = await findAuthUserByEmail(admin, target)
    if (authUser) {
      return { blocked: true, code: 'ALREADY_MEMBER', reason: 'Already has an Andrel account', overridable: false }
    }
  } catch {
    // Auth lookup is best-effort; the profiles + waitlist checks are the primary gate.
  }

  // 3) Other waitlist rows for this email (invited / contacted). Overridable (stale outreach).
  const { data: otherRows } = await admin
    .from('waitlist')
    .select('id, status, invited_at, recommendation_email_sent_at')
    .ilike('email', target)
  for (const row of otherRows ?? []) {
    if (row.id === selfWaitlistId) continue
    if (row.status === 'invited') {
      return {
        blocked: true,
        code: 'ALREADY_INVITED',
        reason: `Already invited on ${shortDate(row.invited_at)}`,
        overridable: true,
      }
    }
    if (row.status === 'contacted') {
      return {
        blocked: true,
        code: 'ALREADY_CONTACTED',
        reason: `Already contacted on ${shortDate(row.recommendation_email_sent_at)}`,
        overridable: true,
      }
    }
  }

  // 4) Referrals tied to any waitlist row for this email — prior recommendation / decline.
  const waitlistIds = (otherRows ?? []).map((r: any) => r.id)
  if (waitlistIds.length > 0) {
    const { data: refs } = await admin
      .from('referrals')
      .select('status, rejected_at, referrer:profiles!referrer_user_id(full_name)')
      .in('waitlist_id', waitlistIds)

    const declined = (refs ?? []).find((r: any) => r.status === 'rejected')
    if (declined) {
      return {
        blocked: true,
        code: 'PREVIOUSLY_DECLINED',
        reason: `Previously declined on ${shortDate(declined.rejected_at)}`,
        overridable: true,
        requiresReason: true,
      }
    }
    const priorPending = (refs ?? []).find((r: any) => r.status === 'pending' || r.status === 'invited')
    if (priorPending) {
      const by = (priorPending.referrer as any)?.full_name
      return {
        blocked: true,
        code: 'DUPLICATE_RECOMMENDATION',
        reason: by ? `Previously recommended by ${by}` : 'Already recommended',
        overridable: true,
      }
    }
  }

  return CLEAR
}
