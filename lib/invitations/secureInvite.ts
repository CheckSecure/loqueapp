import { normalizeEmail } from '@/lib/auth/normalizeEmail'

// Shared, single-purpose account-access invitation logic.
//
// SECURITY MODEL: no plaintext password ever exists. For a new invitee we mint the auth user
// via generateLink({type:'invite'}) (Supabase creates the user WITHOUT a usable password) and
// for an existing not-activated user via generateLink({type:'recovery'}). We take ONLY the
// `hashed_token` and build a link into the EXISTING scanner-hardened page:
//   https://andrel.app/auth/recover#token_hash=<hashed_token>&type=<invite|recovery>&next=/auth/reset-password
// The token lives in the FRAGMENT (never sent to any server / log) and is consumed only on a
// deliberate human click (verifyOtp) — email scanners that prefetch the GET cannot burn it.
// The link/token is passed ONLY to the email sender; it is never returned, logged, or stored.

export type InvitePlan = 'create' | 'link_existing' | 'active' | 'ambiguous'
export type InviteLinkType = 'invite' | 'recovery'

/** Decide what to do from the member's auth state. `authCount` = auth users at the normalized
 *  email (>1 → ambiguous hard-stop). Pure. */
export function classifyInviteTarget(args: {
  authCount: number
  activated: boolean
}): InvitePlan {
  if (args.authCount > 1) return 'ambiguous'
  if (args.authCount === 0) return 'create'
  if (args.activated) return 'active'
  return 'link_existing'
}

export function linkTypeForPlan(plan: InvitePlan): InviteLinkType | null {
  if (plan === 'create') return 'invite'
  if (plan === 'link_existing') return 'recovery'
  return null
}

/**
 * Build the scanner-resistant recover URL from a Supabase `hashed_token`. The token sits in
 * the URL FRAGMENT so it never reaches a server/CDN/proxy log; `/auth/recover` consumes it on
 * an explicit click. Pure. (This value contains the token — treat it as a secret: only ever
 * pass it to the trusted email sender.)
 */
export function buildRecoverLink(args: {
  siteUrl: string
  hashedToken: string
  type: InviteLinkType
  next?: string
}): string {
  const next = args.next || '/auth/reset-password'
  const base = args.siteUrl.replace(/\/+$/, '')
  const frag = new URLSearchParams({ token_hash: args.hashedToken, type: args.type, next }).toString()
  return `${base}/auth/recover#${frag}`
}

export type SecureInviteState =
  | 'invited' | 'link_sent' | 'active' | 'ambiguous'
  | 'pending'        // an unresolved/in-flight claim exists — DO NOT resend (idempotency window)
  | 'uncertain'      // this send's provider outcome is unknown — left claimed; wait for webhook
  | 'needs_review'   // claim past the 24h window — explicit admin review required for a new attempt
  | 'unavailable'    // delivery tracking could not be persisted — FAIL CLOSED, nothing sent
  | 'error'

export interface SecureInviteResult {
  ok: boolean
  state: SecureInviteState
  /** provider accepted the send (→ caller may stamp invited_at for a first_invite) */
  sent: boolean
  /** durable delivery-record id, when an attempt was claimed */
  deliveryId?: string | null
  /** SAFE admin-facing message; never contains a token/link/password */
  message?: string
  authUserId?: string | null
  errorClass?: string
}

export interface SecureInviteDeps {
  /** normalized email → { count, user:{id,last_sign_in_at}|null } (count>1 ⇒ ambiguous). */
  lookupAuth: (email: string) => Promise<{ count: number; user: { id: string; last_sign_in_at: string | null } | null }>
  /** true when the auth user has a profiles row (activated even if never signed in). */
  hasProfile: (userId: string) => Promise<boolean>
  /** PRE-SEND atomic claim, FAIL CLOSED. `claimFailed` ⇒ tracking could not be persisted → the
   *  caller must send nothing. isNew=false ⇒ an active attempt already exists; `existingStatus`
   *  is its durable status and `stale` is true when it is an unresolved `claimed` attempt PAST
   *  the 24h idempotency window (eligible for an explicit admin-reviewed new attempt). */
  claimDelivery: (purpose: 'first_invite' | 'access_resend', authUserId: string | null) => Promise<{ deliveryId: string | null; isNew: boolean; claimFailed?: boolean; existingStatus?: string | null; stale?: boolean }>
  /** generateLink for the chosen type; returns ONLY the hashed_token + resolved user id. */
  generateLink: (type: InviteLinkType, email: string) => Promise<{ hashedToken: string; userId: string | null }>
  /** send the secure email with a stable idempotency key; NO token echoed. `uncertain` ⇒ a
   *  timeout/unknown outcome that must be retried with the SAME key (not a definite failure). */
  sendEmail: (args: { to: string; toName: string; link: string; idempotencyKey?: string }) => Promise<{ success: boolean; messageId?: string | null; errorClass?: string; uncertain?: boolean }>
  markAccepted: (deliveryId: string | null, providerMessageId: string | null, authUserId: string | null) => Promise<void>
  markFailed: (deliveryId: string | null, errorClass: string) => Promise<void>
  siteUrl: string
}

export interface SecureInviteInput {
  email: string
  fullName: string | null
  waitlistId: string | null
  /** explicit admin "new attempt": retire a stale/unresolved claim and start a fresh one.
   *  Used only after the safe retry window, from a confirmed review action. */
  force?: boolean
}

/**
 * Orchestrate a secure invitation/access link, durably + concurrency-safe. Order: classify →
 * PRE-SEND claim (before any link generation) → generateLink → send (idempotency key from the
 * claim id) → mark accepted/failed. A concurrent second call resolves onto the same claim and
 * no-ops (in_flight). NEVER returns or logs the token/link.
 */
export async function sendSecureInvite(deps: SecureInviteDeps, input: SecureInviteInput): Promise<SecureInviteResult> {
  const email = normalizeEmail(input.email)
  if (!email) return { ok: false, state: 'error', sent: false, message: 'Missing email' }

  const { count, user } = await deps.lookupAuth(email)
  let activated = false
  if (user) activated = !!user.last_sign_in_at || (await deps.hasProfile(user.id))

  const plan = classifyInviteTarget({ authCount: count, activated })
  if (plan === 'active') {
    return { ok: false, state: 'active', sent: false, authUserId: user?.id ?? null,
      message: 'This member already has an active account. Use the password-reset tool if they need access.' }
  }
  if (plan === 'ambiguous') {
    return { ok: false, state: 'ambiguous', sent: false,
      message: 'Multiple accounts exist for this email — manual review required before sending.' }
  }

  const type = linkTypeForPlan(plan)! // 'invite' (create) | 'recovery' (link_existing)
  const purpose = plan === 'create' ? 'first_invite' : 'access_resend'

  const unavailable = (): SecureInviteResult => ({
    ok: false, state: 'unavailable', sent: false,
    message: 'Invitation delivery tracking is unavailable right now. No invitation was sent. Please try again once the system is ready.',
  })

  // PRE-SEND CLAIM — serializes concurrent clicks (one provider send) and gives a stable
  // idempotency key. Happens BEFORE generateLink so a duplicate never creates a second user.
  // FAILS CLOSED: a claim that cannot be persisted means we send NOTHING.
  let claim = await deps.claimDelivery(purpose, user?.id ?? null)
  if (claim.claimFailed) return unavailable()

  if (!claim.isNew) {
    // An in-flight attempt already exists (claimed/accepted/deferred). NEVER re-send under the same
    // idempotency key with a regenerated token (changed payload → 409 invalid_idempotent_request),
    // and NEVER create a new attempt inside the review window. Only an attempt PAST the window can
    // be retired and replaced, and only on an explicit admin-confirmed force.
    if (claim.stale && input.force) {
      // Explicit, reviewed new attempt: retire the stale claim (history preserved) and take a
      // FRESH claim → new row, new token, NEW idempotency key.
      await deps.markFailed(claim.deliveryId, 'superseded_by_admin')
      const fresh = await deps.claimDelivery(purpose, user?.id ?? null)
      if (fresh.claimFailed) return unavailable()
      if (!fresh.isNew) {
        return { ok: true, state: 'pending', sent: false, deliveryId: fresh.deliveryId,
          message: 'Another attempt is already in progress for this person. Do not resend.' }
      }
      claim = fresh
    } else if (claim.stale) {
      return { ok: false, state: 'needs_review', sent: false, deliveryId: claim.deliveryId,
        message: 'A previous send is unresolved and past the 24-hour window. Review the delivery status, then confirm a new attempt.' }
    } else {
      // Accepted (already sent) OR claimed within the window → pending. DO NOT resend.
      return { ok: true, state: 'pending', sent: false, deliveryId: claim.deliveryId,
        message: 'Delivery status is pending — do not resend. It resolves automatically, or can be retried after 24 hours.' }
    }
  }

  // Fresh claim only past this point. A missing durable id means we CANNOT track → do not send.
  if (!claim.deliveryId) return unavailable()

  let hashedToken: string, userId: string | null
  try {
    ;({ hashedToken, userId } = await deps.generateLink(type, email))
  } catch {
    await deps.markFailed(claim.deliveryId, 'link_generation_failed')
    return { ok: false, state: 'error', sent: false, deliveryId: claim.deliveryId, message: 'Could not generate the secure access link. Please try again.' }
  }
  const link = buildRecoverLink({ siteUrl: deps.siteUrl, hashedToken, type }) // token ONLY flows to sendEmail
  const idempotencyKey = `invite:${claim.deliveryId}` // one key ⇄ one token/payload; never reused with a new token

  const send = await deps.sendEmail({ to: email, toName: input.fullName || 'there', link, idempotencyKey })

  if (send.success) {
    // AT-MOST-ONCE: the provider ACCEPTED the send. Recording that locally is best-effort — a failure
    // here (DB error/timeout/crash) must NEVER surface as a retryable `error`, or a re-run would send a
    // SECOND email. Swallow it and still report sent=true: the claim row simply stays `claimed`, which
    // (a) blocks any resend within the 24h window (→ pending) and (b) is reconciled by the delivery
    // webhook (or admin review after 24h). Post-dispatch bookkeeping never triggers another email.
    try {
      await deps.markAccepted(claim.deliveryId, send.messageId ?? null, userId ?? user?.id ?? null)
    } catch {
      /* provider already accepted — do not downgrade to a retryable failure */
    }
    return { ok: true, state: plan === 'create' ? 'invited' : 'link_sent', sent: true, deliveryId: claim.deliveryId, authUserId: userId ?? user?.id ?? null }
  }
  if (send.uncertain) {
    // Provider outcome unknown. Leave the claim in `claimed` and DO NOT resend: a same-key
    // re-send with a regenerated token would be a 409 invalid_idempotent_request, and a different
    // key could double-send. If the provider accepted it, the delivery webhook resolves the claim;
    // otherwise the admin can retire it and start a new attempt after the 24h window.
    return { ok: false, state: 'uncertain', sent: false, deliveryId: claim.deliveryId, authUserId: userId ?? user?.id ?? null,
      message: 'Delivery status is pending — do not resend. It resolves automatically, or can be retried after 24 hours.' }
  }
  await deps.markFailed(claim.deliveryId, send.errorClass ?? 'provider_error')
  return { ok: false, state: 'error', sent: false, deliveryId: claim.deliveryId, authUserId: userId ?? user?.id ?? null,
    errorClass: send.errorClass ?? 'provider_error', message: 'The secure email could not be sent. It is safe to retry.' }
}
