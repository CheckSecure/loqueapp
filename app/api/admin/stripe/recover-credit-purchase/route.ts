import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'
import { createAdminClient } from '@/lib/supabase/admin'
import { stripe } from '@/lib/stripe'
import { fulfillCreditPurchase, realFulfillDeps, type SessionLike } from '@/lib/stripe/fulfillCreditPurchase'

/**
 * Admin-only, single-target recovery for a Stripe credit purchase whose webhook never durably
 * fulfilled (e.g. a misconfigured/redirecting endpoint). It accepts EXACTLY ONE Stripe identifier — a
 * checkout.session.completed EVENT id OR a Checkout SESSION id — fetches it directly from Stripe, and
 * runs the SAME canonical `fulfillCreditPurchase` used by the webhook (server-side pack resolution +
 * the atomic/idempotent grant_credit_pack RPC). It CANNOT accept a user id or a credit quantity, and
 * has NO bulk/cohort capability. Re-running is idempotent (credit_grants keys on event + session), so
 * this can safely race or follow the real webhook. Response is a coarse outcome only — never customer
 * identity, email, payment payload, card data, or secrets.
 */

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: any, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })
const bad = (message: string) => json({ ok: false, outcome: 'invalid', error: message }, 400)

const EVENT_RE = /^evt_[A-Za-z0-9]+$/
const SESSION_RE = /^cs_[A-Za-z0-9_]+$/

export async function POST(req: Request) {
  // 0. CSRF: reject cross-origin cookie-authed mutations.
  const crossOrigin = assertSameOrigin(req)
  if (crossOrigin) return crossOrigin

  // 1. Admin authorization BEFORE any Stripe/service-role work.
  const { error } = await requireAdmin()
  if (error) return error

  const ctype = req.headers.get('content-type') ?? ''
  if (!ctype.toLowerCase().includes('application/json')) return bad('Content-Type must be application/json')

  // 2. Strict body: EXACTLY one of { eventId } or { sessionId }. No user id, no credits, no arrays/bulk.
  let body: any
  try { body = await req.json() } catch { return bad('Invalid JSON body') }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return bad('Body must be an object')
  const keys = Object.keys(body)
  if (keys.length !== 1 || !['eventId', 'sessionId'].includes(keys[0])) {
    return bad('Body must contain exactly one field: eventId OR sessionId')
  }
  const value = body[keys[0]]
  if (typeof value !== 'string') return bad('Identifier must be a string')

  const admin = createAdminClient()
  const deps = realFulfillDeps(admin, stripe)

  try {
    let input: { eventId: string; session?: SessionLike; sessionId?: string }

    if (keys[0] === 'eventId') {
      if (!EVENT_RE.test(value)) return bad('eventId must be a Stripe event id (evt_…)')
      const event = await stripe.events.retrieve(value)
      if (event.type !== 'checkout.session.completed') {
        return json({ ok: false, outcome: 'invalid' }, 200) // only credit checkouts are recoverable here
      }
      input = { eventId: event.id, session: event.data.object as unknown as SessionLike }
    } else {
      if (!SESSION_RE.test(value)) return bad('sessionId must be a Stripe checkout session id (cs_…)')
      const session = await stripe.checkout.sessions.retrieve(value)
      // No originating event id available → use a stable synthetic; the session UNIQUE key still makes
      // this idempotent against the real webhook event.
      input = { eventId: `recovery:${session.id}`, session: session as unknown as SessionLike }
    }

    const res = await fulfillCreditPurchase(deps, input)
    console.log('[admin-recover-credit]', JSON.stringify({ event: 'recovery', outcome: res.outcome }))
    // Map coarse outcome → status. Terminal outcomes are 200/409; a transient error is 500 (retryable).
    const status =
      res.outcome === 'error' ? 500
        : res.outcome === 'conflict' ? 409
          : res.outcome === 'payment_not_settled' ? 409
            : 200
    return json({ ok: res.outcome === 'granted' || res.outcome === 'already_processed', outcome: res.outcome }, status)
  } catch {
    // A Stripe retrieve failure (bad id / network) — coarse, no identifiers, retryable.
    console.error('[admin-recover-credit] error (class): stripe_or_server')
    return json({ ok: false, outcome: 'error' }, 502)
  }
}

// POST-only.
export async function GET() {
  return json({ error: 'Method not allowed' }, 405)
}
