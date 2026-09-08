import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'
import {
  buildBidirectionalBlockFilter,
  buildBidirectionalMatchFilter,
  buildBidirectionalIntroRequestFilter,
} from '@/lib/db/filters'
import { isSameCompany } from '@/lib/matching/same-company'
import { buildIntroReasons } from '@/lib/match-signals'
import { checkPairCommunity, isRetryableDenial } from '@/lib/community/pairGate'
import { createAdminIntroPairRpc } from '@/lib/relationships/adminIntroPair'

export type CreateAdminIntroFailure =
  | 'invalid_pair'
  | 'user_a_inactive'
  | 'user_b_inactive'
  | 'same_company'
  | 'blocked'
  | 'active_match_exists'
  /** The two members belong to different Andrel communities, or one could not be resolved. */
  | 'cross_community'
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

  // ── COMMUNITY BOUNDARY (Phase 3 Stage 1b) ────────────────────────────────────────────────────
  // FIRST, before any other gate, because this function's write is the EARLIEST discovery-conferring
  // row a pair can get: it inserts intro_requests with status 'admin_pending', which is inside
  // can_discover_profile's grant set (migration 079). A cross-community pair reaching the insert
  // below would become mutually discoverable immediately — before any match, credit or consent.
  //
  // DEFENCE IN DEPTH AND EARLY REFUSAL — NOT the authority. The authority is
  // public.create_admin_intro_pair (migration 098), which re-evaluates community_pair_allowed under
  // both participant advisory locks, in the same transaction as the INSERT. This check runs first
  // only so an admin gets a clear message before the five product gates below do their reads, and
  // so a cross-community pair never reaches the write at all.
  //
  // (Until migration 098 this path INSERTed intro_requests directly as service_role, which bypasses
  // RLS, with the only trigger on that table being the 070 email outbox rather than a gate — so
  // this check briefly WAS the only layer. It is not any more, and it must never be relied on as
  // one again: it reads a snapshot in a different process from the write.)
  //
  // Fails closed on every uncertainty: missing id, missing profile, unreadable member_type, or a
  // read that did not answer at all.
  const community = await checkPairCommunity(userAId, userBId)
  if (!community.allowed) {
    return {
      ok: false,
      code: 'cross_community',
      message: isRetryableDenial(community.reason)
        // A transport fault is never reported as a fact about the members.
        ? 'Could not verify these members right now. Please try again.'
        : 'These members belong to different Andrel communities and cannot be introduced.',
    }
  }

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

  // ── THE WRITE, THROUGH THE AUTHORITATIVE SQL PRIMITIVE (migration 098) ───────────────────────
  // This was a direct service-role INSERT of two 'admin_pending' rows. Because 'admin_pending' is
  // inside can_discover_profile's grant set (migration 079), that INSERT is itself the moment two
  // members become mutually discoverable — and service_role bypasses RLS, so nothing outside the
  // writing function could gate it. public.create_admin_intro_pair now performs exactly the same
  // INSERT under both participant advisory locks, with community_pair_allowed evaluated in the same
  // transaction.
  //
  // EVERYTHING THE ROWS CONTAIN IS UNCHANGED: status 'admin_pending', is_admin_initiated true, the
  // same finalReason on both rows, the same adminNotes, one shared created_at, and pair_id /
  // batch_id left NULL. The RPC is deliberately NOT materialize_admin_pair, which is the batch
  // review path and would write a tier status, a pair_id and a batch envelope instead.
  const written = await createAdminIntroPairRpc(admin, userAId, userBId, finalReason, adminNotes)

  if (written.outcome === 'ineligible') {
    // The database refused. Reported with the same code and message the pre-check uses, so an admin
    // sees one consistent answer regardless of which layer caught it. 'profile_missing' cannot
    // normally reach here (the eligibility read above already refused), so it means the row
    // disappeared mid-request — still a refusal, never a partial write.
    return {
      ok: false,
      code: 'cross_community',
      message: 'These members belong to different Andrel communities and cannot be introduced.',
    }
  }

  if (written.outcome === 'already_proposed') {
    // The duplicate-pair guard above missed a concurrent admin. The RPC caught it inside the pair
    // locks and wrote nothing; report it exactly as that guard would have.
    return {
      ok: true,
      mode: 'intro_already_proposed',
      introRequests: written.rows.map((r) => ({
        id: r.id, status: r.status, is_admin_initiated: r.is_admin_initiated,
      })),
    }
  }

  if (written.outcome !== 'created') {
    // 'invalid' and 'error' — including any outcome this client does not recognise. FAIL CLOSED:
    // no notifications, and no direct-INSERT fallback.
    console.error('[createAdminIntroPair] intro_requests write refused:', written.outcome, written.detail)
    return { ok: false, code: 'insert_failed', message: 'Failed to propose introduction' }
  }

  // Projected to exactly the shape the direct INSERT's `.select('id, requester_id, target_user_id')`
  // returned, so both admin routes' JSON responses are byte-identical to before.
  const newIntros = written.rows.map((r) => ({
    id: r.id, requester_id: r.requester_id, target_user_id: r.target_user_id,
  }))

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
