export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { readProfileById } from '@/lib/profiles/serverProfile'
import { stripe, CREDIT_PACKS } from '@/lib/stripe'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getEffectiveTier } from '@/lib/tier-override'
import {
  bindCreditReservation,
  CREDIT_CHECKOUT_TTL_SECONDS,
  releaseCreditReservation,
  reserveCreditPurchase,
} from '@/lib/stripe/creditReservations'

const TEMPORARILY_UNAVAILABLE = 'Credit purchases are temporarily unavailable. Please try again shortly.'
const SUBSCRIPTION_PRICE_IDS = new Set([
  process.env.STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID,
  process.env.STRIPE_PROFESSIONAL_ANNUAL_PRICE_ID,
  process.env.STRIPE_EXECUTIVE_MONTHLY_PRICE_ID,
  process.env.STRIPE_EXECUTIVE_ANNUAL_PRICE_ID,
].filter((value): value is string => Boolean(value)))

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: { priceId?: unknown; mode?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
  if (typeof body.priceId !== 'string' || !['payment', 'subscription'].includes(String(body.mode))) {
    return NextResponse.json({ error: 'Invalid checkout request' }, { status: 400 })
  }
  const priceId = body.priceId
  const mode = body.mode as 'payment' | 'subscription'

  // A payment Price must resolve to a server-owned credit pack before Stripe is contacted. This
  // prevents charging for an unknown product that the webhook can never safely fulfil.
  const creditPack = mode === 'payment' ? CREDIT_PACKS.find((p) => p.priceId === priceId) : null
  if (mode === 'payment' && !creditPack) {
    return NextResponse.json({ error: 'This credit pack is unavailable.' }, { status: 400 })
  }
  if (mode === 'subscription' && !SUBSCRIPTION_PRICE_IDS.has(priceId)) {
    return NextResponse.json({ error: 'This membership option is unavailable.' }, { status: 400 })
  }

  const read = await readProfileById<{
    stripe_customer_id: string | null; full_name: string | null; is_founding_member: boolean | null
    founding_member_expires_at: string | null; subscription_tier: string | null
  }>(user.id, 'stripe_customer_id, full_name, is_founding_member, founding_member_expires_at, subscription_tier', 'stripe-checkout')
  if (!read.ok) {
    const status = read.reason === 'unavailable' ? 503 : 404
    return NextResponse.json({ error: status === 503 ? 'Billing is temporarily unavailable. Please try again.' : 'Profile not found' }, { status })
  }
  const profile = read.profile
  if (mode === 'subscription' && getEffectiveTier(profile) === 'founding') {
    return NextResponse.json({ error: 'Founding members already have equivalent benefits.' }, { status: 400 })
  }

  const admin = createAdminClient()
  const reservationExpiresAt = new Date(Date.now() + CREDIT_CHECKOUT_TTL_SECONDS * 1000)
  let reservationId: string | null = null
  let sessionCreationStarted = false

  // The database reservation is the purchase-cap authority. This deliberately fails closed when
  // migration 089 is absent, making it safe to deploy this application before applying the migration.
  if (creditPack) {
    try {
      const reservation = await reserveCreditPurchase(admin, {
        userId: user.id, priceId, credits: creditPack.credits, expiresAt: reservationExpiresAt,
      })
      if (reservation.outcome === 'at_capacity') {
        return NextResponse.json(
          { error: 'You can hold up to 50 credits. Use some credits before purchasing this pack.' },
          { status: 409 },
        )
      }
      if (reservation.outcome !== 'reserved') {
        return NextResponse.json({ error: TEMPORARILY_UNAVAILABLE }, { status: 503 })
      }
      reservationId = reservation.reservation_id
    } catch {
      return NextResponse.json({ error: TEMPORARILY_UNAVAILABLE }, { status: 503 })
    }
  }

  const releaseUnboundReservation = async () => {
    if (!reservationId) return
    try {
      await releaseCreditReservation(admin, {
        reservationId, sessionId: null, reason: 'checkout_creation_failed',
      })
    } catch {
      // The short lease remains the safety net if cleanup itself is temporarily unavailable.
    }
  }

  try {
    let customerId = profile.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email!,
        name: profile.full_name || undefined,
        metadata: { supabase_user_id: user.id },
      })
      customerId = customer.id
      const { error } = await admin.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id)
      if (error) {
        await releaseUnboundReservation()
        return NextResponse.json({ error: mode === 'payment' ? TEMPORARILY_UNAVAILABLE : 'Billing is temporarily unavailable. Please try again.' }, { status: 503 })
      }
    }

    const metadata: Record<string, string> = { supabase_user_id: user.id }
    if (creditPack && reservationId) {
      metadata.type = 'credit_purchase'
      metadata.credits = String(creditPack.credits)
      metadata.credit_reservation_id = reservationId
    }

    sessionCreationStarted = true
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode,
      success_url: `${process.env.NEXT_PUBLIC_SITE_URL}/dashboard/billing?success=true`,
      cancel_url: `${process.env.NEXT_PUBLIC_SITE_URL}/dashboard/billing?cancelled=true`,
      metadata,
      ...(reservationId ? {
        client_reference_id: reservationId,
        expires_at: Math.floor(reservationExpiresAt.getTime() / 1000),
      } : {}),
    }, reservationId ? { idempotencyKey: `credit-reservation:${reservationId}` } : undefined)

    if (reservationId) {
      let bound = false
      try {
        const outcome = await bindCreditReservation(admin, {
          reservationId, userId: user.id, sessionId: session.id, expiresAt: reservationExpiresAt,
        })
        bound = outcome === 'bound' || outcome === 'already_bound'
      } catch {
        bound = false
      }
      if (!bound) {
        // Never expose a payable URL unless its capacity reservation is durably bound. If Stripe
        // expiration fails, retain the lease: the expiration webhook can later bind from metadata
        // and release it safely, while the short TTL prevents permanent capacity loss.
        try {
          await stripe.checkout.sessions.expire(session.id)
          await releaseUnboundReservation()
        } catch {
          // Intentionally retain the reservation when session expiration is unconfirmed.
        }
        return NextResponse.json({ error: TEMPORARILY_UNAVAILABLE }, { status: 503 })
      }
    }

    return NextResponse.json({ url: session.url })
  } catch {
    // Once Stripe creation has started, a network failure is ambiguous: Stripe may have created a
    // payable session even though this process never received its id. Keep the short reservation
    // rather than freeing capacity underneath a potentially active checkout.
    if (!sessionCreationStarted) await releaseUnboundReservation()
    return NextResponse.json({ error: mode === 'payment' ? TEMPORARILY_UNAVAILABLE : 'Billing is temporarily unavailable. Please try again.' }, { status: 503 })
  }
}
