import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from '@/lib/supabase/server'
import { isSameCompany } from '@/lib/matching/same-company'
import { EXPRESSED_STATUSES, findReusableOutboundIntro } from '@/lib/introRequests/state'
import { promoteIfResolved } from '@/lib/introductions/queue'
import { notifyNewVisibleBatch } from '@/lib/notifications/engagement'
import { decideAdminReject, ADMIN_APPROVE_DISABLED_MSG } from '@/lib/introRequests/classify'

async function resolveProfileId(supabase: ReturnType<typeof createClient>, authUserId: string, authUserEmail?: string) {
  const orClause = authUserEmail
    ? `id.eq.${authUserId},email.eq.${authUserEmail}`
    : `id.eq.${authUserId}`
  const { data } = await supabase
    .from('profiles')
    .select('id')
    .or(orClause)
    .limit(1)
  return data?.[0]?.id ?? authUserId
}

/**
 * NOT the Express-Interest-on-a-card path. See lib/introRequests/expressInterest.ts.
 *
 * This is the person-addressed contract: "record that this member wants to meet that person", with
 * no recommendation card behind it. It writes an UNCORRELATED row — responds_to_id stays NULL — so
 * such a row is never a capacity-release candidate and behaves exactly as it did before migration
 * 080. It deliberately has NO parameter for a card id: an optional one is what previously allowed
 * the card path to degrade silently to this one.
 *
 * Its (requester, target) idempotency reuse is correct HERE, where there is no epoch to confuse,
 * and is the reason it must never serve the card path: findReusableOutboundIntro returns the OLDEST
 * live row, which after a cooldown re-recommendation is an expression from a previous epoch.
 *
 * No server action and no route reaches this function today; it is retained as the non-card
 * contract and is unreachable from the member-facing UI.
 */
export async function createIntroRequest(
  authUserId: string,
  authUserEmail: string,
  targetUserId: string,
  note?: string,
) {
  const supabase = createAdminClient()
  console.log('[createIntroRequest] authUserId:', authUserId, 'targetUserId:', targetUserId)

  if (authUserId === targetUserId) {
    return { error: 'You cannot request an introduction to yourself.' }
  }

  // Idempotency: if the viewer already has an OUTBOUND request for this person
  // that is pending or approved, reuse it instead of inserting a duplicate on
  // repeated clicks or retries. (A prior 'suggested' recommendation row is left
  // as-is; the feed suppresses the "Express interest" card whenever an outbound
  // pending/approved row exists — see app/dashboard/introductions/page.tsx and
  // lib/introRequests/state.ts.)
  const { data: existingActive, error: dupErr } = await supabase
    .from('intro_requests')
    .select('id, status, created_at')
    .eq('requester_id', authUserId)
    .eq('target_user_id', targetUserId)
    .in('status', EXPRESSED_STATUSES as unknown as string[])
    .order('created_at', { ascending: true })

  if (dupErr) {
    console.error('[createIntroRequest] duplicate check failed:', JSON.stringify(dupErr))
    return { error: dupErr.message }
  }

  const reusable = findReusableOutboundIntro(existingActive ?? [])
  if (reusable) {
    console.log('[createIntroRequest] reusing existing outbound intro:', reusable.id, reusable.status)
    return { success: true, introRequestId: reusable.id, alreadyExpressed: true }
  }

  // Same-company gate (V1: unconditional suppression)
  const { data: companyProfiles } = await supabase
    .from('profiles')
    .select('id, company')
    .in('id', [authUserId, targetUserId])

  const requesterCompany = companyProfiles?.find(p => p.id === authUserId)
  const targetCompany = companyProfiles?.find(p => p.id === targetUserId)

  if (isSameCompany(
    { company: requesterCompany?.company },
    { company: targetCompany?.company }
  )) {
    return { error: 'Introductions between colleagues at the same company are not available.', code: 'SAME_COMPANY_BLOCKED' }
  }

  // Check active interest limit (max 5 concurrent)
  const { count: activeCount } = await supabase
    .from('intro_requests')
    .select('id', { count: 'exact', head: true })
    .eq('requester_id', authUserId)
    .eq('status', 'pending')

  if ((activeCount ?? 0) >= 5) {
    return { error: 'You have reached the maximum of 5 active interests. Withdraw one to express interest in someone new.', code: 'OUTBOUND_PENDING_CAP_REACHED' }
  }

  // Soft rate limit: max 5 new interests per 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count: recentCount } = await supabase
    .from('intro_requests')
    .select('id', { count: 'exact', head: true })
    .eq('requester_id', authUserId)
    .gte('created_at', oneDayAgo)

  if ((recentCount ?? 0) >= 5) {
    return { error: 'You have expressed interest in 5 people today. Check back tomorrow.' }
  }

  const { data: introRequest, error } = await supabase.from('intro_requests').insert({
    requester_id: authUserId,
    target_user_id: targetUserId,
    status: 'pending',
    note: note || null,
  })
  .select('id')
  .single()

  console.log('[createIntroRequest] insert result — error:', JSON.stringify(error))

  if (error) return { error: error.message }

  const newIntroRequestId = introRequest?.id
  if (!newIntroRequestId) {
    // Insert reported no error but returned no row — do not report success.
    return { error: 'Could not create introduction request. Please try again.' }
  }

  // Auto-match: check if target has already expressed interest in requester
  const { data: reverseRequest } = await supabase
    .from('intro_requests')
    .select('id')
    .eq('requester_id', targetUserId)
    .eq('target_user_id', authUserId)
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle()

  if (reverseRequest?.id) {
    console.log('[createIntroRequest] mutual interest detected — ready for admin review')
  }

  // Expressing interest resolves this recommendation. If it was the active batch's
  // last open recommendation, promote the queued batch (reveal only). Never blocks
  // the interest result on a promotion hiccup.
  try {
    const promo = await promoteIfResolved(supabase, authUserId)
    // Revealing a queued batch surfaces new visible introductions → announce it.
    if (promo.promoted && promo.newActive) {
      await notifyNewVisibleBatch(authUserId, promo.newActive)
    }
  } catch (promoteErr) {
    console.error('[createIntroRequest] promoteIfResolved failed (non-fatal):', promoteErr)
  }

  return { success: true, introRequestId: newIntroRequestId }
}

export async function getUserIntroRequests(userId: string) {
  const supabase = createAdminClient()
  const profileId = await resolveProfileId(supabase, userId)

  const { data, error } = await supabase
    .from('intro_requests')
    .select('id, target_user_id, status, note, created_at')
    .eq('requester_id', profileId)
    .order('created_at', { ascending: false })

  return { data: data ?? [], error }
}

export async function adminGetPendingRequests() {
  const supabase = createAdminClient()

  const { data: requests, error } = await supabase
    .from('intro_requests')
    .select('id, requester_id, target_user_id, status, note, created_at')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error || !requests) return { data: [], error }

  const allIds = [
    ...requests.map(r => r.requester_id),
    ...requests.map(r => r.target_user_id),
  ].filter(Boolean)

  const uniqueIds = Array.from(new Set(allIds))

  let profileMap: Record<string, any> = {}
  if (uniqueIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, title, company, role_type')
      .in('id', uniqueIds)
    for (const p of profiles ?? []) profileMap[p.id] = p
  }

  const enriched = requests.map(r => ({
    ...r,
    requester: profileMap[r.requester_id] ?? null,
    target: profileMap[r.target_user_id] ?? null,
  }))

  return { data: enriched, error: null }
}

/**
 * Admin approval — FULLY DISABLED / FAIL-CLOSED.
 *
 * An admin click can NEVER stand in for either member's consent. "Admin initiated" is NOT member
 * consent, and no product policy authorizes an admin-forced connection. Finalization happens ONLY
 * through the two member-facing acceptance routes (express-interest / accept-incoming), which each
 * record one authenticated member's consent; the SECOND acceptance triggers finalizeMutualMatch,
 * whose pre-RPC revalidation re-checks bothMembersConsented().
 *
 * This function therefore performs ZERO reads and ZERO writes and never finalizes — it exists only
 * so the (defensively-retained) server action and any forged direct call fail closed with a clear,
 * non-sensitive message.
 */
export async function approveIntroRequest(_requestId: string) {
  return { error: ADMIN_APPROVE_DISABLED_MSG }
}

/**
 * Admin reject — scoped archival. Refuses reciprocal (pair-governed) rows so it can never
 * accidentally mutate pair state (pass/expire is pair-aware and private). For legacy/admin rows it
 * simply archives the record to 'rejected' with no other side effects.
 */
export async function rejectIntroRequest(requestId: string) {
  const adminClient = createAdminClient()

  const { data: req, error: fetchErr } = await adminClient
    .from('intro_requests')
    .select('id, pair_id')
    .eq('id', requestId)
    .maybeSingle()

  if (fetchErr) return { error: fetchErr.message }
  if (!req) return { error: 'Request not found' }

  const decision = decideAdminReject(req)
  if (!decision.allow) {
    return { error: 'Reciprocal recommendations are managed automatically and cannot be rejected here.' }
  }

  const { error } = await adminClient
    .from('intro_requests')
    .update({ status: 'rejected', updated_at: new Date().toISOString() })
    .eq('id', requestId)

  if (error) return { error: error.message }
  return { success: true }
}
