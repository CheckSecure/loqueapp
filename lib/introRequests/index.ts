import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from '@/lib/supabase/server'
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

// ── createIntroRequest WAS DELETED IN PHASE 3 STAGE 1b ────────────────────────────────────────
// The "person-addressed" (non-card) intro contract. It had ZERO callers — reconfirmed repo-wide
// immediately before deletion — and its own doc comment already recorded that: "No server action
// and no route reaches this function today; it is retained as the non-card contract and is
// unreachable from the member-facing UI."
//
// Retaining it was a standing liability rather than a spare part. It INSERTed into intro_requests
// directly as service_role with status 'pending', which is inside can_discover_profile's grant set
// (migration 079) — so it was an unreferenced, ungated, discovery-conferring writer sitting one
// import away from any future caller. Phase 3's whole premise is that such a write must go through
// a gated path, and the cheapest way to guarantee that for this one is that it no longer exists.
//
// The live paths are unchanged and are where new work belongs:
//   • card path            -> lib/introRequests/expressInterest.ts
//   • admin-proposed pair  -> lib/introRequests/createAdminIntroPair.ts
//   • batch approval       -> lib/introductions/materializeAdminPair.ts (materialize_admin_pair)

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
