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
  /**
   * Mint a durable RESUME link for this invitation and bind it to the resolved auth user.
   *
   * WHY THE FIRST EMAIL NEEDS ONE. The primary button is a Supabase authentication link, which
   * expires by design. Until now nothing else was in that email, so once it expired the invitation
   * was simply dead and the member had no way back — the exact complaint this work exists to fix.
   * Resume tokens were minted only by later reminders, which is no help to someone who never got
   * a reminder or who opened the first email a week late.
   *
   * Returns null — or throws — when the token could not be persisted. When this dep is SUPPLIED,
   * EITHER outcome is FAIL-CLOSED: the attempt is marked failed and NO provider call is made, no
   * success is reported, and nothing downstream stamps invited_at or reminder_enrollment_at.
   *
   * The dep remains OPTIONAL only for legacy call sites that deliberately do not supply it. Every
   * production invitation path supplies it and therefore fails closed.
   *
   * The earlier reasoning — "an invitation with only a primary link is the status quo, and no
   * invitation at all is worse" — was wrong once the durable fallback became the approved product
   * behaviour. An email whose only link expires is exactly the failure this work exists to remove,
   * and sending one silently would leave the member in the original broken state while the system
   * recorded a success. Refusing is visible, retryable, and leaves invited_at and
   * reminder_enrollment_at unstamped, so nothing downstream believes an invitation went out.
   *
   * The returned string contains the plaintext token in its fragment — treat it as a secret. It is
   * passed to sendEmail and to nothing else, and MUST NOT be logged or returned.
   */
  mintResumeLink?: (authUserId: string) => Promise<{ link: string; tokenId: string } | null>
  /** Revoke a resume token minted for an attempt whose provider send definitively failed. */
  revokeResumeToken?: (tokenId: string) => Promise<void>
  /** send the secure email with a stable idempotency key; NO token echoed. `uncertain` ⇒ a
   *  timeout/unknown outcome that must be retried with the SAME key (not a definite failure). */
  // `purpose` is the SAME value used for the delivery claim, handed to the sender so the copy and
  // the claim can never disagree about whether this person has been invited before. A caller that
  // ignores it still compiles — but then an expired-invite resend reads as a first contact.
  sendEmail: (args: { to: string; toName: string; link: string; resumeLink?: string | null; idempotencyKey?: string; purpose: 'first_invite' | 'access_resend' }) => Promise<{ success: boolean; messageId?: string | null; errorClass?: string; uncertain?: boolean }>
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

  // DURABLE FALLBACK. Minted after generateLink so it can be bound to the resolved auth user id —
  // a token with no bound identity can never be invalidated by completion. Minted BEFORE the send
  // so the email can carry it; a failure here degrades to an invitation without a fallback, never
  // to no invitation.
  const resolvedUserId = userId ?? user?.id ?? null
  let resume: { link: string; tokenId: string } | null = null
  if (deps.mintResumeLink) {
    // FAIL CLOSED. No identity to bind, or no token persisted, means we cannot honour the durable
    // guarantee — so nothing is sent. This runs BEFORE sendEmail, so no provider call happens.
    if (!resolvedUserId) {
      await deps.markFailed(claim.deliveryId, 'resume_identity_unresolved')
      return { ok: false, state: 'error', sent: false, deliveryId: claim.deliveryId,
        authUserId: null, errorClass: 'resume_identity_unresolved',
        message: 'Could not prepare a durable recovery link. Nothing was sent; it is safe to retry.' }
    }
    // A THROW is the same failure as a null, and must not escape. An unhandled rejection here
    // would leave the delivery row stranded in 'claimed' and surface as a 500, which is both less
    // informative and less safe than the explicit refusal below.
    try {
      resume = await deps.mintResumeLink(resolvedUserId)
    } catch {
      resume = null
    }
    if (!resume) {
      await deps.markFailed(claim.deliveryId, 'resume_token_unavailable')
      return { ok: false, state: 'error', sent: false, deliveryId: claim.deliveryId,
        authUserId: resolvedUserId, errorClass: 'resume_token_unavailable',
        message: 'Could not prepare a durable recovery link. Nothing was sent; it is safe to retry.' }
    }
  }

  // One key ⇄ one payload. The key is derived from THIS claim, and this claim minted THIS token, so
  // a retry (which takes a fresh claim) can never reuse a key with a different link or token.
  const idempotencyKey = `invite:${claim.deliveryId}`

  const send = await deps.sendEmail({
    to: email, toName: input.fullName || 'there', link, resumeLink: resume?.link ?? null, idempotencyKey,
    purpose,
  })

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
    // Provider outcome unknown — the message MAY have arrived, so the resume token stays LIVE. A
    // revoked token here would silently break a fallback link that is sitting in someone's inbox.
    // Leave the claim in `claimed` and DO NOT resend: a same-key
    // re-send with a regenerated token would be a 409 invalid_idempotent_request, and a different
    // key could double-send. If the provider accepted it, the delivery webhook resolves the claim;
    // otherwise the admin can retire it and start a new attempt after the 24h window.
    return { ok: false, state: 'uncertain', sent: false, deliveryId: claim.deliveryId, authUserId: userId ?? user?.id ?? null,
      message: 'Delivery status is pending — do not resend. It resolves automatically, or can be retried after 24 hours.' }
  }
  // DEFINITE failure: the provider never took the message, so the plaintext token reached nobody.
  // Revoking it removes an unusable capability from the live set rather than leaving an orphan that
  // nothing can ever present. (Uncertain outcomes are handled above and deliberately keep it.)
  if (resume?.tokenId && deps.revokeResumeToken) {
    try { await deps.revokeResumeToken(resume.tokenId) } catch { /* best effort; it is unreachable anyway */ }
  }
  await deps.markFailed(claim.deliveryId, send.errorClass ?? 'provider_error')
  return { ok: false, state: 'error', sent: false, deliveryId: claim.deliveryId, authUserId: userId ?? user?.id ?? null,
    errorClass: send.errorClass ?? 'provider_error', message: 'The secure email could not be sent. It is safe to retry.' }
}
