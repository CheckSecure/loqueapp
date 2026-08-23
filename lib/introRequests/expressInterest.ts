import { createAdminClient } from '@/lib/supabase/admin'
import { isSameCompany } from '@/lib/matching/same-company'
import { promoteIfResolved } from '@/lib/introductions/queue'
import { notifyNewVisibleBatch } from '@/lib/notifications/engagement'

/**
 * THE production write path for "Express interest" on a recommendation card.
 *
 * ─── WHY THIS IS A SEPARATE FUNCTION FROM createIntroRequest ──────────────────────────────────
 * createIntroRequest answers the question "record that this member wants to meet that PERSON". This
 * function answers "record that this member answered that CARD". They are different contracts and
 * they were previously the same function with an optional argument, which meant the card path could
 * silently degrade to the person path — an expression with no responds_to_id, invisible to capacity
 * release and indistinguishable from a legacy row. The card id is mandatory here, and there is no
 * fallback branch: if the correlated writer refuses, nothing is written at all.
 *
 * ─── WHY THE CARD IS NEVER INSPECTED IN TYPESCRIPT ────────────────────────────────────────────
 * Every fact about the card — that it exists, belongs to the acting member, points at the requested
 * target, is still an actionable suggestion rather than an expression or a terminal row, carries a
 * pair, that the pair is active, and that the target is still eligible — is decided inside
 * public.express_intro_interest(), holding BOTH members' advisory locks, in the same transaction as
 * the insert. Reading the card here first and inserting afterwards would reintroduce exactly the
 * window this replaces: a pass, an expiry or a concurrent click landing in between.
 *
 * The gates below are deliberately NOT card facts. They are the pre-existing account-level policy
 * throttles (same employer, five concurrent interests, five per day), unchanged in behaviour and
 * evaluated against the SAME targetId the database then binds the card to — so a mismatched pair of
 * (card, target) cannot slip past a gate, because it writes nothing at all.
 *
 * The acting member's identity is a server-derived session value in every caller. It is never read
 * from the request body, and a forged value cannot help: it names a card that must already belong
 * to that member.
 */

export type ExpressInterestResult =
  | { success: true; introRequestId: string; alreadyExpressed: boolean }
  | { success?: false; error: string; code?: string }

/** Statuses that mean "this member already has a live outbound interest". */
const LIVE_EXPRESSION_STATUSES = ['pending', 'approved', 'accepted', 'accepted_pending_payment', 'admin_pending']

export const MAX_CONCURRENT_INTERESTS = 5
export const MAX_INTERESTS_PER_DAY = 5

export async function expressInterestOnCard(args: {
  authUserId: string
  /** The exact intro_requests.id of the visible card being answered. Mandatory. */
  suggestedRowId: string
  /** The target the member believes that card names. The database binds the two. */
  targetUserId: string
  note?: string
  admin?: any
}): Promise<ExpressInterestResult> {
  const { authUserId, suggestedRowId, targetUserId, note } = args
  const supabase = args.admin ?? createAdminClient()

  if (!suggestedRowId) return { error: 'That introduction is no longer available.', code: 'CARD_REQUIRED' }
  if (!authUserId || !targetUserId) return { error: 'Could not record your interest. Please try again.', code: 'INVALID' }
  if (authUserId === targetUserId) return { error: 'You cannot request an introduction to yourself.' }

  // ── Account-level policy gates (unchanged from createIntroRequest) ──────────────────────────
  const { data: companyProfiles } = await supabase
    .from('profiles')
    .select('id, company')
    .in('id', [authUserId, targetUserId])

  const requesterCompany = companyProfiles?.find((p: any) => p.id === authUserId)
  const targetCompany = companyProfiles?.find((p: any) => p.id === targetUserId)
  if (isSameCompany({ company: requesterCompany?.company }, { company: targetCompany?.company })) {
    return { error: 'Introductions between colleagues at the same company are not available.', code: 'SAME_COMPANY_BLOCKED' }
  }

  const { count: activeCount } = await supabase
    .from('intro_requests')
    .select('id', { count: 'exact', head: true })
    .eq('requester_id', authUserId)
    .eq('status', 'pending')
  if ((activeCount ?? 0) >= MAX_CONCURRENT_INTERESTS) {
    return {
      error: 'You have reached the maximum of 5 active interests. Withdraw one to express interest in someone new.',
      code: 'OUTBOUND_PENDING_CAP_REACHED',
    }
  }

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count: recentCount } = await supabase
    .from('intro_requests')
    .select('id', { count: 'exact', head: true })
    .eq('requester_id', authUserId)
    .gte('created_at', oneDayAgo)
  if ((recentCount ?? 0) >= MAX_INTERESTS_PER_DAY) {
    return { error: 'You have expressed interest in 5 people today. Check back tomorrow.' }
  }

  // ── The atomic correlated write. No fallback. ───────────────────────────────────────────────
  const { data: rpcRows, error: rpcErr } = await supabase.rpc('express_intro_interest', {
    p_suggested_id: suggestedRowId,
    p_requester_id: authUserId,
    p_target_user_id: targetUserId,
    p_note: note || null,
  })

  if (rpcErr) {
    // Class only — never the raw database message, which has leaked schema to members before.
    console.error('[expressInterestOnCard] express_intro_interest failed:', (rpcErr as any)?.code ?? 'unknown')
    return { error: 'Could not record your interest. Please try again.', code: 'WRITE_FAILED' }
  }

  const row = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as
    | { out_state?: string; out_detail?: string; out_intro_request_id?: string }
    | null
    | undefined
  const state = row?.out_state

  if ((state === 'created' || state === 'already_expressed') && row?.out_intro_request_id) {
    // Expressing interest can resolve the active batch's last open recommendation. Non-fatal and
    // idempotent, exactly as on the path this replaces — a promotion hiccup must never turn a
    // recorded interest into an error the member sees.
    try {
      const promo = await promoteIfResolved(supabase, authUserId)
      if (promo.promoted && promo.newActive) await notifyNewVisibleBatch(authUserId, promo.newActive)
    } catch (promoteErr) {
      console.error('[expressInterestOnCard] promoteIfResolved failed (non-fatal):', promoteErr)
    }
    return { success: true, introRequestId: row.out_intro_request_id, alreadyExpressed: state === 'already_expressed' }
  }

  // 'not_actionable' / 'invalid' / an unrecognised state — the card is gone, terminal, not this
  // member's, or names a different target. Nothing was written. The member sees one neutral message
  // that reveals nothing about which of those it was.
  console.warn('[expressInterestOnCard] refused:', state ?? 'no_state', row?.out_detail ?? '')
  return { error: 'This introduction is no longer available.', code: 'CARD_NOT_ACTIONABLE' }
}
