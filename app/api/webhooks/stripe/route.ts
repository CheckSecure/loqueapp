/**
 * RETIRED duplicate Stripe webhook route (apex `/api/webhooks/stripe`).
 *
 * This URL previously ran its OWN, divergent fulfillment (balance-only writes, no idempotency,
 * hardcoded price IDs, cap-clamped grants) — a double-grant and drift risk. It no longer contains any
 * independent credit-granting logic: it DELEGATES to the canonical handler
 * (`/api/stripe/webhook`), so signature verification and the atomic/idempotent grant path
 * (credit_grants) are shared. The same Stripe event delivered to both URLs therefore grants exactly
 * once (the migration-052 idempotency keys dedupe across both), and this route can never grant twice
 * or bypass idempotency.
 *
 * Rollout: point Stripe at the canonical `https://www.andrel.app/api/stripe/webhook` and DISABLE this
 * endpoint in the Stripe Dashboard once the canonical endpoint is verified. Delegation keeps this URL
 * safe during the transition (an in-flight retry to the apex still fulfills once, idempotently) rather
 * than silently dropping a paid event.
 */
export { POST } from '@/app/api/stripe/webhook/route'
