import { CREDIT_PACKS } from '@/lib/stripe'
import { isUuid } from '@/lib/stripe/creditReservations'

/**
 * Canonical, idempotent credit-pack fulfillment — the SINGLE source of truth for turning a paid
 * Stripe Checkout into purchased credits. Used by BOTH the webhook and the admin recovery endpoint.
 *
 * TRUST MODEL: the purchased pack is resolved SERVER-SIDE from the Checkout Session's line-item Stripe
 * Price ID matched against the server-controlled CREDIT_PACKS mapping — NEVER from client-adjacent
 * `metadata.credits`/`type`. The paid amount/currency are re-verified against that pack as a
 * consistency check (a shared $ amount can never by itself select a pack — the Price ID is
 * authoritative). Ownership is proven: the metadata `supabase_user_id` must own the session customer.
 *
 * New checkouts are bound to a migration-089 capacity reservation and granted through
 * `grant_reserved_credit_pack`, which consumes the reservation, records the grant marker, and mutates
 * the balance in one transaction. A narrow legacy fallback preserves already-open pre-089 sessions.
 */

export type FulfillOutcome =
  | 'granted'            // credits granted this call
  | 'already_processed'  // this event/session already granted → zero additional credits
  | 'invalid'            // not a fulfillable credit purchase (wrong mode, unknown price, missing user)
  | 'payment_not_settled'// session not complete/paid
  | 'conflict'           // ownership / amount / currency / line-item mismatch
  | 'error'              // transient (Stripe API or DB) — retry is safe

export interface FulfillResult { outcome: FulfillOutcome; retryable: boolean }

export interface SessionLike {
  id: string
  mode: string | null
  status: string | null
  payment_status: string | null
  currency: string | null
  amount_total: number | null
  expires_at?: number | null
  customer: string | null
  metadata: Record<string, string> | null
}

export interface FulfillDeps {
  /** retrieve a Checkout Session when only its id is known (recovery path). */
  retrieveSession: (sessionId: string) => Promise<SessionLike>
  /** the session's line items, normalized to { priceId, quantity }. */
  listLineItems: (sessionId: string) => Promise<Array<{ priceId: string | null; quantity: number | null }>>
  /** profile lookup by the metadata user id (to prove customer ownership). */
  loadProfileById: (userId: string) => Promise<{ id: string; stripe_customer_id: string | null } | null>
  bindReservation: (args: { reservationId: string; userId: string; sessionId: string; expiresAt: Date }) => Promise<'bound' | 'already_bound' | 'conflict'>
  grantReserved: (args: { reservationId: string; eventId: string; sessionId: string; userId: string; priceId: string; credits: number; amountTotal: number; currency: string }) => Promise<'granted' | 'already_processed' | 'conflict'>
  /** Transitional path solely for Stripe sessions created before reservation metadata shipped. */
  grantLegacy: (args: { eventId: string; sessionId: string; userId: string; priceId: string; credits: number; amountTotal: number; currency: string }) => Promise<'granted' | 'already_processed'>
  /** server-controlled pack config (priceId → credits + expected USD amount). */
  creditPacks: ReadonlyArray<{ priceId?: string; credits: number; amount: number }>
  /** privacy-safe log (event + coarse fields ONLY — never customer/user id, email, amount, or session). */
  log: (event: string, fields?: Record<string, unknown>) => void
}

const EXPECTED_CURRENCY = 'usd'

export async function fulfillCreditPurchase(
  deps: FulfillDeps,
  input: { eventId: string; session?: SessionLike; sessionId?: string },
): Promise<FulfillResult> {
  const done = (outcome: FulfillOutcome, retryable = false, reason?: string): FulfillResult => {
    deps.log('credit_fulfillment', { outcome, ...(reason ? { reason } : {}) })
    return { outcome, retryable }
  }

  // 0) Resolve the session (transient Stripe failure → retryable error).
  let session: SessionLike
  try {
    if (input.session) session = input.session
    else if (input.sessionId) session = await deps.retrieveSession(input.sessionId)
    else return done('invalid', false, 'no_session')
  } catch {
    return done('error', true, 'session_fetch_failed')
  }

  // 1) Must be a one-time payment that is fully settled.
  if (session.mode !== 'payment') return done('invalid', false, 'not_payment_mode')
  if (session.status !== 'complete' || session.payment_status !== 'paid') return done('payment_not_settled', false)

  // 2) Ownership: metadata user must exist AND own the session customer.
  const userId = session.metadata?.supabase_user_id
  if (!userId) return done('invalid', false, 'no_user_metadata')
  if (!session.customer) return done('conflict', false, 'no_customer')
  let profile
  try { profile = await deps.loadProfileById(userId) } catch { return done('error', true, 'profile_lookup_failed') }
  if (!profile) return done('conflict', false, 'user_not_found')
  if (!profile.stripe_customer_id || profile.stripe_customer_id !== session.customer) {
    return done('conflict', false, 'customer_owner_mismatch')
  }

  // 3) Resolve the pack SERVER-SIDE from the line-item Price ID (authoritative — never metadata).
  let items: Array<{ priceId: string | null; quantity: number | null }>
  try { items = await deps.listLineItems(session.id) } catch { return done('error', true, 'line_items_failed') }
  const priced = items.filter((i) => i.priceId)
  if (priced.length !== 1) return done('conflict', false, 'ambiguous_line_items') // exactly one priced line
  const priceId = priced[0].priceId as string
  const quantity = priced[0].quantity ?? 1
  if (quantity !== 1) return done('conflict', false, 'unexpected_quantity')

  const pack = deps.creditPacks.find((p) => p.priceId && p.priceId === priceId)
  if (!pack) return done('invalid', false, 'unknown_price') // not a credit pack (e.g. a subscription price)

  // 4) Consistency: currency + amount must match the resolved pack (defence in depth; Price ID already chosen).
  if ((session.currency ?? '').toLowerCase() !== EXPECTED_CURRENCY) return done('conflict', false, 'currency_mismatch')
  if (session.amount_total !== pack.amount * 100) return done('conflict', false, 'amount_mismatch')

  // 5) New sessions must prove and bind their pre-payment capacity reservation. Sessions without
  // reservation metadata are treated as pre-089 legacy sessions so already-open checkouts remain
  // fulfillable during the safe deployment transition.
  const reservationId = session.metadata?.credit_reservation_id
  const grantArgs = {
    eventId: input.eventId, sessionId: session.id, userId, priceId,
    credits: pack.credits, amountTotal: session.amount_total ?? pack.amount * 100, currency: EXPECTED_CURRENCY,
  }
  let result: 'granted' | 'already_processed'
  try {
    if (reservationId) {
      if (!isUuid(reservationId)) return done('conflict', false, 'invalid_reservation')
      const expiresAt = new Date((session.expires_at ?? Math.floor(Date.now() / 1000)) * 1000)
      const bind = await deps.bindReservation({ reservationId, userId, sessionId: session.id, expiresAt })
      if (bind === 'conflict') return done('conflict', false, 'reservation_conflict')
      const reservedResult = await deps.grantReserved({ reservationId, ...grantArgs })
      if (reservedResult === 'conflict') return done('conflict', false, 'reserved_grant_conflict')
      result = reservedResult
    } else {
      result = await deps.grantLegacy(grantArgs)
    }
  } catch {
    return done('error', true, 'grant_failed') // DB/RPC transient → nothing recorded → safe to retry
  }
  return done(result, false)
}

/** Real deps: Stripe client + service-role Supabase. Kept here so the webhook + recovery share ONE wiring. */
export function realFulfillDeps(admin: any, stripe: any): FulfillDeps {
  return {
    retrieveSession: (id) => stripe.checkout.sessions.retrieve(id),
    listLineItems: async (id) => {
      const li = await stripe.checkout.sessions.listLineItems(id, { limit: 100 })
      return (li?.data ?? []).map((x: any) => ({ priceId: x?.price?.id ?? null, quantity: x?.quantity ?? null }))
    },
    loadProfileById: async (uid) => {
      const { data } = await admin.from('profiles').select('id, stripe_customer_id').eq('id', uid).maybeSingle()
      return data ?? null
    },
    bindReservation: async (a) => {
      const { data, error } = await admin.rpc('bind_credit_purchase_reservation', {
        p_reservation_id: a.reservationId, p_user_id: a.userId, p_session_id: a.sessionId,
        p_expires_at: a.expiresAt.toISOString(),
      })
      if (error) throw new Error('bind_rpc_failed')
      return data as 'bound' | 'already_bound' | 'conflict'
    },
    grantReserved: async (a) => {
      const { data, error } = await admin.rpc('grant_reserved_credit_pack', {
        p_reservation_id: a.reservationId,
        p_event_id: a.eventId, p_session_id: a.sessionId, p_user_id: a.userId, p_price_id: a.priceId,
        p_credits: a.credits, p_amount_total: a.amountTotal, p_currency: a.currency,
      })
      if (error) throw new Error('reserved_grant_rpc_failed')
      return data as 'granted' | 'already_processed' | 'conflict'
    },
    grantLegacy: async (a) => {
      const { data, error } = await admin.rpc('grant_credit_pack', {
        p_event_id: a.eventId, p_session_id: a.sessionId, p_user_id: a.userId, p_price_id: a.priceId,
        p_credits: a.credits, p_amount_total: a.amountTotal, p_currency: a.currency,
      })
      if (error) throw new Error('legacy_grant_rpc_failed')
      return (data as 'granted' | 'already_processed')
    },
    creditPacks: CREDIT_PACKS,
    log: (event, fields) => console.log('[credit-fulfillment]', JSON.stringify({ event, ...(fields ?? {}) })),
  }
}
