/**
 * Typed client for public.create_admin_intro_pair (migration 098).
 *
 * ─── WHY THIS RPC EXISTS ──────────────────────────────────────────────────────────────────────
 * createAdminIntroPair used to INSERT its two intro_requests rows directly, as service_role. That
 * write is discovery-conferring: status 'admin_pending' is inside can_discover_profile's grant set
 * (migration 079), so the row itself makes both members mutually discoverable the moment it
 * commits. service_role bypasses RLS, so no policy could gate it, and a TypeScript pre-check runs
 * in a different process against a snapshot that can be stale by the time the INSERT lands. This
 * was the last discovery-conferring writer in the product without an authoritative database gate.
 *
 * ─── WHAT IT IS NOT ───────────────────────────────────────────────────────────────────────────
 * Not materialize_admin_pair. That is the weekly batch-REVIEW path: it requires two symmetric
 * batch_suggestions rows, writes a TIER status ('suggested'/'queued'), creates member_pairs and
 * stamps pair_id, creates recommendation_batches envelopes, and enforces capacity. This path has
 * no batch, writes 'admin_pending', and leaves pair_id and batch_id NULL. Routing one through the
 * other would change status, tier, pair_id, batch_id, capacity and email behaviour at once.
 *
 * ─── WHAT STAYED IN TYPESCRIPT, AND WHY THAT IS CORRECT ───────────────────────────────────────
 * The account-status, same-company, block, existing-match and duplicate-proposal gates remain in
 * the caller. They are product rules, not the community boundary, and their inputs (isSameCompany's
 * normalisation, the signal-derived match_reason) live in TypeScript. Moving them would have
 * changed refusals this task was told to preserve exactly. The RPC re-checks only what must be
 * authoritative at write time: pair identity, participant existence, community, and — under the
 * pair advisory locks — the duplicate proposal, which the caller's unlocked read cannot make
 * race-safe on its own.
 */

export type AdminIntroOutcome =
  /** Two symmetric 'admin_pending' rows written in one transaction. */
  | 'created'
  /** An admin-initiated proposal already links these two. Idempotent; nothing written. */
  | 'already_proposed'
  /** Refused. `detail` is 'cross_community' or 'profile_missing'. */
  | 'ineligible'
  /** Missing argument or self-pair. Never wrote anything. */
  | 'invalid'
  /** Client-side only: transport fault, or an outcome this client does not recognise. */
  | 'error'

/** Exactly the columns the RPC returns for each written row. */
export interface AdminIntroRow {
  id: string
  requester_id: string
  target_user_id: string
  status: string
  is_admin_initiated: boolean
}

export interface AdminIntroResult {
  outcome: AdminIntroOutcome
  rows: AdminIntroRow[]
  /** Coarse reason. Never an identity, never a raw database message. */
  detail?: string | null
}

/**
 * Write the admin-proposed introduction pair, gated on the community boundary.
 *
 * `admin` must be a service_role client — migration 098 grants EXECUTE to service_role only, so a
 * session client gets a permission error and this returns 'error', which is the correct failure
 * rather than a bypass.
 */
export async function createAdminIntroPairRpc(
  admin: any,
  userAId: string,
  userBId: string,
  matchReason: string | null,
  adminNotes: string,
): Promise<AdminIntroResult> {
  if (!userAId || !userBId || userAId === userBId) {
    return { outcome: 'invalid', rows: [], detail: 'client_precheck' }
  }

  const { data, error } = await admin.rpc('create_admin_intro_pair', {
    p_user_a: userAId,
    p_user_b: userBId,
    p_match_reason: matchReason,
    p_admin_notes: adminNotes,
  })

  if (error) {
    // CLASS only — never a member id, never a raw database message. A retry is safe: the function
    // takes both participant advisory locks and re-reads live state, so a call that committed
    // before a timeout returns 'already_proposed' on the retry instead of inserting a second pair.
    console.error('[create-admin-intro-pair] rpc failed (class):', error.code ?? 'unknown')
    return { outcome: 'error', rows: [] }
  }

  const r = (data ?? {}) as Record<string, any>
  const raw = r.outcome as string | undefined
  const known: AdminIntroOutcome[] = ['created', 'already_proposed', 'ineligible', 'invalid']
  // FAIL CLOSED on anything unrecognised. If the RPC grows a new refusal, the caller reports a
  // failure rather than notifying two members about an introduction that was never written.
  const outcome: AdminIntroOutcome = known.includes(raw as AdminIntroOutcome)
    ? (raw as AdminIntroOutcome)
    : 'error'

  const rows: AdminIntroRow[] = Array.isArray(r.rows) ? (r.rows as AdminIntroRow[]) : []

  // A 'created' that did not come back with its two rows is not a success this client will report:
  // the caller logs and returns those ids, and inventing them would be worse than failing.
  if (outcome === 'created' && rows.length !== 2) {
    console.error('[create-admin-intro-pair] created outcome without two rows')
    return { outcome: 'error', rows: [] }
  }

  return { outcome, rows, detail: r.detail ?? null }
}
