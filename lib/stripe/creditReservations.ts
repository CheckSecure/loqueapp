export const CREDIT_CHECKOUT_TTL_SECONDS = 30 * 60
export const CREDIT_CAPACITY = 50

export type ReserveOutcome =
  | { outcome: 'reserved'; reservation_id: string; headroom_after: number }
  | { outcome: 'at_capacity'; headroom: number }
  | { outcome: 'credit_account_missing' }

export async function reserveCreditPurchase(
  admin: any,
  args: { userId: string; priceId: string; credits: number; expiresAt: Date },
): Promise<ReserveOutcome> {
  const { data, error } = await admin.rpc('reserve_credit_purchase', {
    p_user_id: args.userId,
    p_price_id: args.priceId,
    p_credits: args.credits,
    p_expires_at: args.expiresAt.toISOString(),
  })
  if (error || !data || typeof data.outcome !== 'string') throw new Error('reserve_rpc_failed')
  return data as ReserveOutcome
}

export async function bindCreditReservation(
  admin: any,
  args: { reservationId: string; userId: string; sessionId: string; expiresAt: Date },
): Promise<'bound' | 'already_bound' | 'conflict'> {
  const { data, error } = await admin.rpc('bind_credit_purchase_reservation', {
    p_reservation_id: args.reservationId,
    p_user_id: args.userId,
    p_session_id: args.sessionId,
    p_expires_at: args.expiresAt.toISOString(),
  })
  if (error) throw new Error('bind_rpc_failed')
  return data as 'bound' | 'already_bound' | 'conflict'
}

export async function releaseCreditReservation(
  admin: any,
  args: { reservationId: string; sessionId: string | null; reason: 'checkout_creation_failed' | 'stripe_expired' | 'stripe_expired_by_operator' },
): Promise<'released' | 'already_released' | 'not_found' | 'conflict'> {
  const { data, error } = await admin.rpc('release_credit_purchase_reservation', {
    p_reservation_id: args.reservationId,
    p_session_id: args.sessionId,
    p_reason: args.reason,
  })
  if (error) throw new Error('release_rpc_failed')
  return data as 'released' | 'already_released' | 'not_found' | 'conflict'
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
