import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'
import {
  buildBidirectionalBlockFilter,
  buildBidirectionalMatchFilter,
  buildBidirectionalIntroRequestFilter,
} from '@/lib/db/filters'
import { isSameCompany } from '@/lib/matching/same-company'
import { buildIntroReasons } from '@/lib/match-signals'

export type CreateAdminIntroFailure =
  | 'invalid_pair'
  | 'user_a_inactive'
  | 'user_b_inactive'
  | 'same_company'
  | 'blocked'
  | 'active_match_exists'
  | 'insert_failed'

export type CreateAdminIntroResult =
  | { ok: false; code: CreateAdminIntroFailure; message: string; matchId?: string }
  | { ok: true; mode: 'intro_already_proposed' | 'intro_proposed'; introRequests: any[] }

interface Options {
  /** Stored on both rows; rendered as the "Introduced by Andrel" reason. Null = none (matches legacy behavior). */
  matchReason?: string | null
  /** Provenance tag. 'manual_create' for the admin tool, 'concierge' for the Concierge flow. */
  adminNotes?: string
}

/**
 * Single source of truth for "admin proposes a reciprocal introduction between
 * A and B." Extracted verbatim (behavior-preserving) from
 * app/api/admin/admin-create-match/route.ts.
 *
 * Creates TWO admin_pending, is_admin_initiated intro_requests rows — one in
 * each direction — so BOTH members see "Introduced by Andrel" on their own
 * Introductions page and can still Express Interest / Pass. It NEVER creates a
 * matches row; the match forms only on mutual acceptance via the existing
 * express-interest path. All writes use the service-role admin client.
 */
export async function createAdminIntroPair(
  userAId: string,
  userBId: string,
  { matchReason = null, adminNotes = 'manual_create' }: Options = {}
): Promise<CreateAdminIntroResult> {
  if (!userAId || !userBId || userAId === userBId) {
    return { ok: false, code: 'invalid_pair', message: 'Two distinct user ids required' }
  }

  const admin = createAdminClient()

  // Block if either user is deactivated. Also pulls the signal fields so we can
  // enrich the stored reason with a real, symmetric pair signal (see below).
  const { data: deactProfiles } = await admin
    .from('profiles')
    .select('id, full_name, account_status, company, role_type, seniority, industry, location, city, expertise, purposes, interests, mentorship_role, open_to_mentorship, open_to_business_solutions, open_to_roles, desired_connections')
    .in('id', [userAId, userBId])

  const deactA = (deactProfiles || []).find(p => p.id === userAId)
  const deactB = (deactProfiles || []).find(p => p.id === userBId)

  if (!deactA || deactA.account_status !== 'active') {
    const name = deactA?.full_name
    return { ok: false, code: 'user_a_inactive', message: `User A is no longer active${name ? ` (${name})` : ''}` }
  }
  if (!deactB || deactB.account_status !== 'active') {
    const name = deactB?.full_name
    return { ok: false, code: 'user_b_inactive', message: `User B is no longer active${name ? ` (${name})` : ''}` }
  }

  // Safety check: same company
  if (isSameCompany(deactA, deactB)) {
    return { ok: false, code: 'same_company', message: 'Users are at the same company. Same-company introductions are not permitted.' }
  }

  // Safety check: no active block
  const { data: blocks } = await admin
    .from('blocked_users')
    .select('id')
    .or(buildBidirectionalBlockFilter(userAId, userBId))
    .limit(1)
  if (blocks && blocks.length > 0) {
    return { ok: false, code: 'blocked', message: 'Users have an active block. Unblock first.' }
  }

  // Safety check: no duplicate active match
  const { data: existingMatches } = await admin
    .from('matches')
    .select('id, status')
    .or(buildBidirectionalMatchFilter(userAId, userBId))

  const activeDupe = (existingMatches || []).find(m => m.status !== 'removed')
  if (activeDupe) {
    return { ok: false, code: 'active_match_exists', message: 'Active match already exists', matchId: activeDupe.id }
  }

  // Check: existing admin-initiated intro already pending? (duplicate-pair guard)
  const { data: existingIntros } = await admin
    .from('intro_requests')
    .select('id, status, is_admin_initiated')
    .or(buildBidirectionalIntroRequestFilter(userAId, userBId))
    .eq('is_admin_initiated', true)
    .in('status', ['admin_pending', 'approved'])

  if (existingIntros && existingIntros.length > 0) {
    return { ok: true, mode: 'intro_already_proposed', introRequests: existingIntros }
  }

  // Enrich the stored reason: keep the "Introduced by Andrel" facilitation
  // context AND add one real, symmetric pair signal when available (item 13).
  // Symmetric ({ mutual: true }) because the SAME string is shown to both
  // members. Falls back to the provided reason (or null) when no signal fires.
  const mutualSignal = buildIntroReasons(deactA, deactB, { mutual: true, max: 1 })[0] || null
  const finalReason =
    matchReason && mutualSignal
      ? `${matchReason.replace(/\.\s*$/, '')}. ${mutualSignal}.`
      : matchReason || (mutualSignal ? `${mutualSignal}.` : null)

  // Create TWO intro_requests in admin_pending state, both directions
  const now = new Date().toISOString()
  const { data: newIntros, error: insErr } = await admin
    .from('intro_requests')
    .insert([
      {
        requester_id: userAId,
        target_user_id: userBId,
        status: 'admin_pending',
        is_admin_initiated: true,
        match_reason: finalReason,
        admin_notes: adminNotes,
        created_at: now,
      },
      {
        requester_id: userBId,
        target_user_id: userAId,
        status: 'admin_pending',
        is_admin_initiated: true,
        match_reason: finalReason,
        admin_notes: adminNotes,
        created_at: now,
      },
    ])
    .select('id, requester_id, target_user_id')

  if (insErr || !newIntros) {
    console.error('[createAdminIntroPair] intro_requests insert failed:', insErr)
    return { ok: false, code: 'insert_failed', message: 'Failed to propose introduction' }
  }

  // Names for notification personalization
  const { data: profileA } = await admin.from('profiles').select('full_name').eq('id', userAId).maybeSingle()
  const { data: profileB } = await admin.from('profiles').select('full_name').eq('id', userBId).maybeSingle()

  // Send admin_intro notifications to both users (non-fatal)
  try {
    await createNotificationSafe({
      userId: userAId,
      type: 'admin_intro',
      data: { fromUserId: userBId, fromUserName: profileB?.full_name || 'a curated connection' },
    })
    await createNotificationSafe({
      userId: userBId,
      type: 'admin_intro',
      data: { fromUserId: userAId, fromUserName: profileA?.full_name || 'a curated connection' },
    })
  } catch (e) {
    console.error('[createAdminIntroPair] notification send failed (non-fatal):', e)
  }

  return { ok: true, mode: 'intro_proposed', introRequests: newIntros }
}
