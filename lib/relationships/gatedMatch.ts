/**
 * Typed client for public.create_gated_match (migration 096).
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 * Three flows used to INSERT a `matches` row directly from TypeScript as service_role, then INSERT
 * its `conversations` row in a second, unrelated statement: adminForceMatch, the admin
 * facilitate-intro route, and the opportunity connect path. Two problems, both structural:
 *
 *   1. service_role BYPASSES RLS, so no policy could ever have gated those writes. The only place
 *      a community rule can bind them is inside the function that performs the write.
 *   2. A match and its conversation were two round trips. A failure between them left a match with
 *      no conversation — a state the product has no repair path for.
 *
 * create_gated_match fixes both: one SECURITY DEFINER call, both advisory locks, the community
 * predicate evaluated in the same transaction as the INSERT, and match + conversation written
 * together or not at all.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────────
 * No credits, no consent requirement, no intro_requests row, no notifications, no emails, no
 * system message. Those differ per flow and stay in the callers, which is where they already
 * lived. It is NOT finalize_mutual_match_atomic, which requires an approved intro_requests row in
 * each direction (all three flows have none — connect.ts actively REFUSES when one exists),
 * charges both members (all three charge nothing), and writes only three columns (connect.ts needs
 * is_opportunity_initiated / opportunity_id / matched_at / admin_notes, which lib/opportunities
 * caps.ts and rateLimits.ts read).
 *
 * ─── FAIL CLOSED ──────────────────────────────────────────────────────────────────────────────
 * Every outcome below is handled explicitly by every caller. An unrecognised outcome maps to
 * 'error' here rather than being treated as success, so a future RPC change cannot make a caller
 * proceed as if a match exists when it does not.
 */

export type GatedMatchOutcome =
  /** Match + conversation written in one transaction. */
  | 'created'
  /** A match already linked these two, in either column order. Idempotent success. */
  | 'already_matched'
  /** community_pair_allowed said no. `detail` is 'cross_community'. */
  | 'ineligible'
  /** Missing argument or self-pair. Never wrote anything. */
  | 'invalid'
  /** Client-side only: transport fault, timeout, or an outcome this client does not recognise. */
  | 'error'

export interface GatedMatchResult {
  outcome: GatedMatchOutcome
  matchId?: string | null
  conversationId?: string | null
  /** Coarse reason. Never an identity, never a raw database message. */
  detail?: string | null
}

export interface GatedMatchOptions {
  /** Written to matches.admin_facilitated. Carries no authority over anything. */
  adminFacilitated?: boolean
  /** matches.status. Defaults to 'active' inside the RPC. */
  status?: string
  adminNotes?: string | null
  /** matches.matched_at. Defaults to now() inside the RPC. */
  matchedAt?: string | null
  isOpportunityInitiated?: boolean
  opportunityId?: string | null
  /** conversations.suggested_prompts. Defaults to [] inside the RPC. */
  suggestedPrompts?: unknown[] | null
}

/** Outcomes after which a match between these two exists. The ONLY ones a caller may proceed on. */
export function isConnected(o: GatedMatchOutcome): boolean {
  return o === 'created' || o === 'already_matched'
}

/**
 * Create the match and its conversation atomically, gated on the community boundary.
 *
 * `admin` must be a service_role client: migration 096 grants EXECUTE to service_role only, so a
 * session client receives a permission error and this returns 'error' — which is the correct
 * failure, not a bypass.
 */
export async function createGatedMatch(
  admin: any,
  userAId: string,
  userBId: string,
  opts: GatedMatchOptions = {},
): Promise<GatedMatchResult> {
  if (!userAId || !userBId || userAId === userBId) {
    return { outcome: 'invalid', detail: 'client_precheck' }
  }

  const { data, error } = await admin.rpc('create_gated_match', {
    p_user_a: userAId,
    p_user_b: userBId,
    p_admin_facilitated: opts.adminFacilitated ?? false,
    p_status: opts.status ?? 'active',
    p_admin_notes: opts.adminNotes ?? null,
    p_matched_at: opts.matchedAt ?? null,
    p_is_opportunity_initiated: opts.isOpportunityInitiated ?? false,
    p_opportunity_id: opts.opportunityId ?? null,
    p_suggested_prompts: opts.suggestedPrompts ?? null,
  })

  if (error) {
    // CLASS only — never an id, never a raw database message. A retry is safe: the RPC takes both
    // participant advisory locks and re-reads live state, so a call that committed before a
    // timeout returns 'already_matched' on the retry rather than creating a second row.
    console.error('[create-gated-match] rpc failed (class):', error.code ?? 'unknown')
    return { outcome: 'error' }
  }

  const r = (data ?? {}) as Record<string, any>
  const raw = r.outcome as string | undefined
  const known: GatedMatchOutcome[] = ['created', 'already_matched', 'ineligible', 'invalid']
  // An unrecognised outcome is 'error', never a silent success. If the RPC grows a new refusal,
  // every caller refuses rather than proceeding to notify members about a match that is not there.
  const outcome: GatedMatchOutcome = known.includes(raw as GatedMatchOutcome)
    ? (raw as GatedMatchOutcome)
    : 'error'

  return {
    outcome,
    matchId: r.match_id ?? null,
    conversationId: r.conversation_id ?? null,
    detail: r.detail ?? null,
  }
}
