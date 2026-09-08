/**
 * Typed client for public.create_support_match (migration 096).
 *
 * ─── THE ONLY SANCTIONED CROSS-COMMUNITY RELATIONSHIP ─────────────────────────────────────────
 * The platform account talks to every member — the onboarding welcome, and the reply to an issue
 * report — and it must keep doing so when members belong to two communities. That is a genuine
 * exception to the Professional/Next boundary, and it is the ONLY one. Mentorship is not built on
 * it; the Andrel Next bridge will be its own reviewed path.
 *
 * ─── WHERE THE AUTHORITY LIVES, AND WHY NOT HERE ──────────────────────────────────────────────
 * The exemption is keyed on profiles.is_admin = TRUE, read FOR SHARE INSIDE the SQL function, so
 * the flag cannot change between the check and the write. It is NOT keyed on an email address:
 * ADMIN_EMAIL / ADMIN_USER_EMAIL are mutable application configuration, and a security boundary
 * must not rest on a string in an env var.
 *
 * getAdminUser() still LOOKS UP the platform account by email — that is how the id is discovered,
 * not how the exemption is granted. If that lookup ever returned an ordinary member's id, this RPC
 * refuses with 'not_platform_account' and no cross-community match is created. The lookup is
 * untrusted input to a function that verifies it.
 *
 * ─── WHY THIS IS NOT A GENERAL HELPER ─────────────────────────────────────────────────────────
 * There is deliberately no exported "isPlatformAccount()" predicate and no bypass flag on
 * createGatedMatch. A general-purpose exemption predicate is a callable bypass waiting for a
 * caller, and a boolean parameter on an ordinary writer is precisely the "admin bypasses
 * community" mechanism this design forbids. Because the exemption lives inside a function that can
 * only ever create a platform-account ↔ member pair, there is no argument any caller can pass to
 * pair two ordinary members across the wall — in either argument position.
 *
 * TWO CALLERS ONLY: lib/onboarding/welcomeFromAdmin.ts and app/api/admin/issues/[id]/reply/route.ts.
 * A test asserts that count. Anything else wanting a match uses createGatedMatch and obeys the
 * boundary.
 */

export type SupportMatchOutcome =
  /** Match + conversation written in one transaction. */
  | 'created'
  /** A match already linked the platform account and this member. Idempotent success. */
  | 'already_matched'
  /**
   * Refused. `detail` is 'not_platform_account' (the named platform participant is not is_admin —
   * including the args-swapped and two-ordinary-members cases) or 'member_unavailable'.
   */
  | 'ineligible'
  /** Missing argument or self-pair. Never wrote anything. */
  | 'invalid'
  /** Client-side only: transport fault, timeout, or an unrecognised outcome. */
  | 'error'

export interface SupportMatchResult {
  outcome: SupportMatchOutcome
  matchId?: string | null
  conversationId?: string | null
  detail?: string | null
}

/** Outcomes after which the support conversation exists. The only ones a caller may proceed on. */
export function isSupportConnected(o: SupportMatchOutcome): boolean {
  return o === 'created' || o === 'already_matched'
}

/**
 * Create (or find) the platform-account ↔ member match and its conversation.
 *
 * `platformUserId` is asserted by the caller and VERIFIED by the RPC. `admin` must be a
 * service_role client; migration 096 grants EXECUTE to service_role only.
 */
export async function createSupportMatch(
  admin: any,
  platformUserId: string,
  memberId: string,
  adminNotes: string | null = null,
): Promise<SupportMatchResult> {
  if (!platformUserId || !memberId || platformUserId === memberId) {
    return { outcome: 'invalid', detail: 'client_precheck' }
  }

  const { data, error } = await admin.rpc('create_support_match', {
    p_platform_user: platformUserId,
    p_member: memberId,
    p_admin_notes: adminNotes,
  })

  if (error) {
    console.error('[create-support-match] rpc failed (class):', error.code ?? 'unknown')
    return { outcome: 'error' }
  }

  const r = (data ?? {}) as Record<string, any>
  const raw = r.outcome as string | undefined
  const known: SupportMatchOutcome[] = ['created', 'already_matched', 'ineligible', 'invalid']
  const outcome: SupportMatchOutcome = known.includes(raw as SupportMatchOutcome)
    ? (raw as SupportMatchOutcome)
    : 'error'

  return {
    outcome,
    matchId: r.match_id ?? null,
    conversationId: r.conversation_id ?? null,
    detail: r.detail ?? null,
  }
}
