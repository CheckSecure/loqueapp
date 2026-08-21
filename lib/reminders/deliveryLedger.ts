/**
 * Typed client for public.reminder_deliveries (migration 065).
 *
 * THE CLAIM IS AN INSERT. The table's partial unique index over the active states means a second
 * concurrent worker's insert raises 23505 and it simply skips — no lease, no timestamp to expire,
 * nothing to reconcile. Everything below is a thin, honest wrapper around that.
 */

export type DeliveryStatus =
  | 'claimed' | 'accepted' | 'delivered' | 'deferred'
  | 'bounced' | 'blocked' | 'complained' | 'failed'

export interface ClaimResult {
  /** True when THIS worker owns the send. False means someone already claimed it this week. */
  claimed: boolean
  deliveryId?: string
  /** True when this claim recovered an abandoned lease rather than creating a new row. */
  reclaimed?: boolean
  /** Set when the claim failed for a reason other than an existing claim. */
  errorClass?: string
}

/** Postgres unique_violation — the claim was already taken. Expected, not an error. */
const UNIQUE_VIOLATION = '23505'

/**
 * How long a 'claimed' row is considered live. Deliberately generous: reclaiming early risks a
 * duplicate email, reclaiming late costs at most one weekly reminder. A send takes well under a
 * second, so 15 minutes only ever fires after a genuine crash.
 */
export const CLAIM_LEASE_MS = 15 * 60 * 1000

export async function claimReminder(
  admin: any,
  args: { memberId: string; purpose: string; cycleKey: string; openCardCount: number },
): Promise<ClaimResult> {
  const { data, error } = await admin
    .from('reminder_deliveries')
    .insert({
      member_id: args.memberId,
      purpose: args.purpose,
      cycle_key: args.cycleKey,
      open_card_count: args.openCardCount,
      status: 'claimed',
    })
    .select('id')
    .single()

  if (error) {
    if ((error as any).code === UNIQUE_VIOLATION) {
      // A claim already exists this week. It is ours to take ONLY if it is a STALE 'claimed' lease —
      // never an 'accepted' one, because the provider may already hold that message.
      const staleBefore = new Date(Date.now() - CLAIM_LEASE_MS).toISOString()
      const { data: revived, error: reviveErr } = await admin
        .from('reminder_deliveries')
        .update({ claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('member_id', args.memberId)
        .eq('purpose', args.purpose)
        .eq('cycle_key', args.cycleKey)
        .eq('status', 'claimed')          // never steals 'accepted'
        .lt('claimed_at', staleBefore)    // never steals a FRESH claim
        .select('id')
        .maybeSingle()
      if (reviveErr) {
        console.error('[wednesday-reminder] stale-claim recovery failed (class):', (reviveErr as any).code ?? 'unknown')
        return { claimed: false, errorClass: 'reclaim_error' }
      }
      if (revived?.id) return { claimed: true, deliveryId: revived.id, reclaimed: true }
      return { claimed: false }
    }
    // CLASS only — never a member id or a raw database message.
    console.error('[wednesday-reminder] claim failed (class):', (error as any).code ?? 'unknown')
    return { claimed: false, errorClass: 'claim_error' }
  }
  return { claimed: true, deliveryId: (data as any)?.id }
}

/** Provider accepted the message. Records the message id so a webhook can reconcile later. */
export async function markAccepted(admin: any, deliveryId: string, providerMessageId: string | null) {
  const { error } = await admin
    .from('reminder_deliveries')
    .update({ status: 'accepted', accepted_at: new Date().toISOString(),
              provider_message_id: providerMessageId, updated_at: new Date().toISOString() })
    .eq('id', deliveryId)
  if (error) console.error('[wednesday-reminder] accept update failed (class):', (error as any).code ?? 'unknown')
}

/**
 * Provider call failed. 'failed' sits OUTSIDE the active-claim index, so the next run may re-claim.
 * A send that may already have reached the provider must NOT be marked failed — leave it 'claimed',
 * which blocks a retry. A missed reminder is recoverable; a duplicate one is not.
 */
export async function markFailed(admin: any, deliveryId: string, errorClass: string) {
  const { error } = await admin
    .from('reminder_deliveries')
    .update({ status: 'failed', error_class: errorClass, updated_at: new Date().toISOString() })
    .eq('id', deliveryId)
  if (error) console.error('[wednesday-reminder] fail update failed (class):', (error as any).code ?? 'unknown')
}

/**
 * Claim an EVENT-keyed delivery (migration 069).
 *
 * The weekly claim above is keyed on the calendar week, which is the right authority for something
 * that happens once a week. It is the WRONG authority for new introductions: a member can
 * legitimately receive introductions twice in one week, and a week key would swallow the second.
 * This claims on (member_id, purpose, event_key) instead, where event_key fingerprints the
 * committed cards. `cycle_key` is still written, still meaning the calendar week — it is recorded,
 * not used as the authority.
 *
 * Identical lease semantics to claimReminder: 23505 means someone already holds it, and only a
 * STALE 'claimed' row may be taken over — never an 'accepted' one, because the provider may already
 * hold that message.
 */
export async function claimEventDelivery(
  admin: any,
  args: { memberId: string; purpose: string; cycleKey: string; eventKey: string; openCardCount: number },
): Promise<ClaimResult> {
  const { data, error } = await admin
    .from('reminder_deliveries')
    .insert({
      member_id: args.memberId,
      purpose: args.purpose,
      cycle_key: args.cycleKey,
      event_key: args.eventKey,
      open_card_count: args.openCardCount,
      status: 'claimed',
    })
    .select('id')
    .single()

  if (error) {
    if ((error as any).code === UNIQUE_VIOLATION) {
      const staleBefore = new Date(Date.now() - CLAIM_LEASE_MS).toISOString()
      const { data: revived, error: reviveErr } = await admin
        .from('reminder_deliveries')
        .update({ claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('member_id', args.memberId)
        .eq('purpose', args.purpose)
        .eq('event_key', args.eventKey)
        .eq('status', 'claimed')
        .lt('claimed_at', staleBefore)
        .select('id')
        .maybeSingle()
      if (reviveErr) {
        console.error('[new-introductions] stale-claim recovery failed (class):', (reviveErr as any).code ?? 'unknown')
        return { claimed: false, errorClass: 'reclaim_error' }
      }
      if (revived?.id) return { claimed: true, deliveryId: revived.id, reclaimed: true }
      return { claimed: false }
    }
    console.error('[new-introductions] claim failed (class):', (error as any).code ?? 'unknown')
    return { claimed: false, errorClass: 'claim_error' }
  }
  return { claimed: true, deliveryId: (data as any)?.id }
}
