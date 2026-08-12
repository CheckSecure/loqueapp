import { normalizeEmail } from '@/lib/auth/normalizeEmail'
import { buildRecoverLink } from '@/lib/invitations/secureInvite'

/**
 * Admin-only email replacement + secure re-invite for an INVITED, never-activated waitlist person.
 *
 * WHY A COMPENSATED SAGA: Supabase Auth (the auth user's email) and Postgres (the waitlist row) can
 * NOT be mutated in one transaction. This orchestrates an explicit, ordered, compensated operation
 * that can NEVER leave Auth and the waitlist silently divergent:
 *
 *   1. CLAIM an `access_resend` delivery row — this doubles as a CONCURRENCY MUTEX (the
 *      (waitlist_id, purpose) partial-unique index serialises simultaneous requests) AND the durable,
 *      privacy-safe delivery record. Fails CLOSED: no claim ⇒ nothing is mutated or sent.
 *   2. Revalidate every precondition immediately before mutating.
 *   3. Update the EXISTING Auth user's email (same user id).
 *   4. Update the waitlist row with an ATOMIC guard on (id, old normalized email, status='invited').
 *   5. If the waitlist update touches zero rows (and did not converge to the new email), RESTORE the
 *      Auth email. If restore fails → CRITICAL (manual repair), send nothing.
 *   6. Re-read Auth + waitlist and PROVE both hold the new email before sending anything.
 *   7. Only then send ONE secure access link (recovery type — passwordless) to the new address, keyed
 *      to the claim id. A delivery failure keeps the updated identity and returns a retryable outcome
 *      (never rolls identity back merely because the email didn't send).
 *
 * NEVER creates a new auth user / profile / waitlist row; NEVER emails a password; NEVER rewrites the
 * historical delivery for the old address (that record has a different `purpose`). Preserves the auth
 * user id and waitlist id. All identity values (emails/ids/tokens/links) stay internal — the result
 * carries only a coarse state + a safe admin message.
 */

export type ChangeEmailState =
  | 'changed_and_sent'        // identity updated + secure link accepted by the provider
  | 'already_current'         // already at the new email; a secure link was (re)sent per claim rules
  | 'changed_send_failed'     // identity updated, delivery NOT sent → retryable (retry the link only)
  | 'changed_send_uncertain'  // identity updated, provider outcome unknown → await webhook, do not resend
  | 'conflict'                // a precondition/replacement conflict; nothing was changed
  | 'already_activated'       // signed in or has a profile / not 'invited' → refuse
  | 'ambiguous'               // missing or duplicate auth identity → refuse (manual review)
  | 'pending'                 // an in-flight secure send already exists → do not retry yet
  | 'needs_review'            // a prior send is unresolved past 24h → review before a new attempt
  | 'unavailable'             // delivery tracking could not be persisted → fail closed, nothing changed
  | 'critical'                // Auth/waitlist divergence or failed compensation → manual repair
  | 'error'                   // invalid input / unexpected

export interface ChangeEmailResult {
  ok: boolean
  state: ChangeEmailState
  /** an identity email was actually mutated (true even when the later send failed) */
  changed: boolean
  /** the secure access link was accepted by the provider */
  sent: boolean
  /** durable delivery record id (internal; the route must NOT expose it) */
  deliveryId?: string | null
  /** SAFE admin-facing message — never an email/id/token/link/raw provider error */
  message?: string
}

export interface ChangeEmailInput {
  waitlistId: string
  newEmail: string
}

export interface ChangeEmailDeps {
  loadWaitlist: (waitlistId: string) => Promise<{ id: string; email: string | null; status: string; fullName: string | null } | null>
  /** normalized email → { count, first user }. count>1 ⇒ ambiguous. */
  lookupAuth: (email: string) => Promise<{ count: number; user: { id: string; last_sign_in_at: string | null } | null }>
  hasProfile: (userId: string) => Promise<boolean>
  /** a profiles row exists at this normalized email (case-insensitive). */
  profileExistsForEmail: (email: string) => Promise<boolean>
  /** a DIFFERENT waitlist row (id ≠ excludeId) already uses this normalized email. */
  waitlistEmailConflict: (email: string, excludeId: string) => Promise<boolean>
  /** PRE-SEND atomic claim / mutex on (waitlist_id, 'access_resend'). Fails CLOSED. When it resolves
   *  onto an EXISTING active claim (isNew=false), `existingRecipient` is that claim's STORED recipient
   *  (so we can prove recipient binding) — it is never rewritten. */
  claimDelivery: (authUserId: string | null, recipientEmail: string) => Promise<{ deliveryId: string | null; isNew: boolean; claimFailed?: boolean; existingStatus?: string | null; stale?: boolean; existingRecipient?: string | null }>
  /** update the EXISTING auth user's email, preserving the id. Returns ok. */
  updateAuthEmail: (userId: string, email: string) => Promise<boolean>
  /** atomic guarded update: WHERE id=waitlistId AND email≈oldEmail AND status='invited'. */
  updateWaitlistEmailGuarded: (args: { waitlistId: string; oldEmail: string; newEmail: string }) => Promise<{ rows: number; uniqueViolation?: boolean; error?: boolean }>
  /** re-read the auth user's current email (verification). */
  readAuthEmail: (userId: string) => Promise<string | null>
  /** re-read the waitlist row's email + status (verification). */
  readWaitlist: (waitlistId: string) => Promise<{ email: string | null; status: string } | null>
  /** recovery link for the existing (not-activated) user; returns ONLY the hashed token. */
  generateLink: (email: string) => Promise<{ hashedToken: string; userId: string | null }>
  sendEmail: (args: { to: string; toName: string; link: string; idempotencyKey?: string }) => Promise<{ success: boolean; messageId?: string | null; errorClass?: string; uncertain?: boolean }>
  markAccepted: (deliveryId: string | null, providerMessageId: string | null, authUserId: string | null) => Promise<void>
  markFailed: (deliveryId: string | null, errorClass: string) => Promise<void>
  siteUrl: string
  /** privacy-safe operational log (event + coarse fields ONLY — never an email/id/token). */
  log: (event: string, fields?: Record<string, unknown>) => void
}

/**
 * Strict single-address format. Rejects whitespace, multiple/zero `@`, and the SQL-LIKE wildcard `%`
 * (so a normalized address is safe to use in the `ilike` conflict/guard filters). Pure.
 */
export function isValidEmailFormat(email: string): boolean {
  if (!email || email.length > 254) return false
  if (/[\s%]/.test(email)) return false
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(email)
}

export async function changeInviteEmail(deps: ChangeEmailDeps, input: ChangeEmailInput): Promise<ChangeEmailResult> {
  const newEmail = normalizeEmail(input.newEmail)
  if (!newEmail || !isValidEmailFormat(newEmail)) {
    return { ok: false, state: 'error', changed: false, sent: false, message: 'Enter a valid replacement email address.' }
  }

  const conflict = (message: string): ChangeEmailResult => ({ ok: false, state: 'conflict', changed: false, sent: false, message })
  const unavailable = (): ChangeEmailResult => ({
    ok: false, state: 'unavailable', changed: false, sent: false,
    message: 'Invitation delivery tracking is unavailable right now. No email was changed and nothing was sent. Please try again once the system is ready.',
  })

  // (A) Load the immutable waitlist row by id.
  const row = await deps.loadWaitlist(input.waitlistId)
  if (!row) return conflict('Waitlist record not found. Refresh and try again.')
  const oldEmail = normalizeEmail(row.email ?? '')
  if (!oldEmail) return conflict('This waitlist record has no email on file.')

  // (B) Status precondition — only an INVITED record is eligible.
  if (row.status !== 'invited') {
    return { ok: false, state: 'conflict', changed: false, sent: false,
      message: 'Only an invited record can have its invitation email changed.' }
  }

  // (C) Exactly one auth user at the current email, never signed in, no profile.
  const cur = await deps.lookupAuth(oldEmail)
  if (cur.count > 1) {
    return { ok: false, state: 'ambiguous', changed: false, sent: false, message: 'Multiple accounts match this record — manual review required before changing the email.' }
  }
  if (cur.count === 0 || !cur.user) {
    return { ok: false, state: 'ambiguous', changed: false, sent: false, message: 'No unique account matches this record — manual review required.' }
  }
  const userId = cur.user.id
  const activated = !!cur.user.last_sign_in_at || (await deps.hasProfile(userId))
  if (activated) {
    return { ok: false, state: 'already_activated', changed: false, sent: false,
      message: 'This person has already started/activated their account — the email can no longer be changed here.' }
  }

  const alreadyCurrent = oldEmail === newEmail

  // (D) Replacement-email must be free of any OTHER identity (auth / profile / waitlist).
  if (!alreadyCurrent) {
    const other = await deps.lookupAuth(newEmail)
    if (other.count > 1) return conflict('The replacement email already has multiple accounts. Resolve those first.')
    if (other.count === 1 && other.user?.id !== userId) return conflict('The replacement email is already in use by another account.')
    if (await deps.profileExistsForEmail(newEmail)) return conflict('The replacement email is already used by an existing member profile.')
    if (await deps.waitlistEmailConflict(newEmail, input.waitlistId)) return conflict('The replacement email is already used by another waitlist record.')
    // other.count === 1 && same id ⇒ a prior partial run already moved Auth; the saga below converges it.
  }

  // (E) CLAIM the delivery mutex (pre-send, fail closed). Serialises concurrent requests; a second
  //     caller resolves onto the existing claim (isNew=false) and mutates NOTHING.
  const claim = await deps.claimDelivery(userId, newEmail)
  if (claim.claimFailed) return unavailable()
  if (!claim.isNew) {
    // The active resend slot for this person is already occupied. The (waitlist_id, purpose) unique
    // index gives us the EXISTING claim — its stored recipient may be a DIFFERENT address. We must
    // NEVER reuse or rewrite it to send to the new address (invariants 1–5). Decide from the STORED
    // recipient, BEFORE changing Auth/waitlist:
    const existingRecipient = normalizeEmail(claim.existingRecipient ?? '')
    const sameRecipient = existingRecipient !== '' && existingRecipient === newEmail
    if (!sameRecipient) {
      // A secure send bound to a DIFFERENT address (or an unknown recipient) is in flight. The current
      // uniqueness model prevents a recipient-correct new claim → require review; change NOTHING.
      return { ok: false, state: 'needs_review', changed: false, sent: false, deliveryId: claim.deliveryId,
        message: 'A secure invitation to a different address is already in progress for this person. Resolve or let it expire (24 hours) before changing the email — nothing was changed.' }
    }
    // Same recipient as the requested new email ⇒ our OWN in-flight change (e.g. a double-click).
    if (claim.stale) {
      return { ok: false, state: 'needs_review', changed: false, sent: false, deliveryId: claim.deliveryId,
        message: 'A previous secure send to this address is unresolved and past the 24-hour window. Review the delivery status before starting a new attempt.' }
    }
    return { ok: false, state: 'pending', changed: false, sent: false, deliveryId: claim.deliveryId,
      message: 'A secure send is already in progress for this person — do not retry yet. It resolves automatically, or can be reviewed after 24 hours.' }
  }
  if (!claim.deliveryId) return unavailable()

  // (F) IDENTITY SAGA (skip entirely when already at the new email).
  let changed = false
  if (!alreadyCurrent) {
    // (F0) Revalidate immediately before mutation — still invited, still the same old email.
    const before = await deps.readWaitlist(input.waitlistId)
    if (!before || before.status !== 'invited' || normalizeEmail(before.email ?? '') !== oldEmail) {
      await deps.markFailed(claim.deliveryId, 'precondition_changed')
      deps.log('email_change_precondition_changed', { state: 'conflict' })
      return conflict('This record changed while you were working on it. Refresh and try again.')
    }

    // (F1) Update the EXISTING Auth user's email (idempotent — a no-op if already moved).
    let authOk = false
    try { authOk = await deps.updateAuthEmail(userId, newEmail) } catch { authOk = false }
    if (!authOk) {
      await deps.markFailed(claim.deliveryId, 'auth_update_failed')
      deps.log('email_change_auth_failed', { state: 'error' })
      return { ok: false, state: 'error', changed: false, sent: false, deliveryId: claim.deliveryId,
        message: 'Could not update the account email. Nothing was changed. It is safe to retry.' }
    }

    // (F2) Guarded waitlist update — atomic on (id, old email, status='invited'). From here on Auth is
    // changed: COMPENSATION is attempted for EVERY failure path (a false result, a unique violation, OR
    // an unexpected throw), so Auth and waitlist can never end silently divergent.
    let needCompensate = false, uniqueViol = false
    try {
      const wl = await deps.updateWaitlistEmailGuarded({ waitlistId: input.waitlistId, oldEmail, newEmail })
      if (wl.rows === 1) {
        changed = true
      } else {
        // Zero rows / error. Did it already converge to the new email (idempotent/concurrent)?
        const after = await deps.readWaitlist(input.waitlistId)
        if (after && normalizeEmail(after.email ?? '') === newEmail && after.status === 'invited') {
          changed = true // both Auth and waitlist ended at the new email — consistent, continue.
        } else {
          needCompensate = true
          uniqueViol = !!wl.uniqueViolation
        }
      }
    } catch {
      needCompensate = true // an unexpected throw AFTER the Auth change → must still roll Auth back.
    }
    if (needCompensate) {
      // COMPENSATE: restore the Auth email. Even the restore is guarded — a thrown restore is a failure.
      let restored = false
      try { restored = await deps.updateAuthEmail(userId, oldEmail) } catch { restored = false }
      if (!restored) {
        await deps.markFailed(claim.deliveryId, 'compensation_failed')
        deps.log('email_change_critical', { state: 'critical', stage: 'compensation_failed' })
        return { ok: false, state: 'critical', changed: true, sent: false, deliveryId: claim.deliveryId,
          message: 'The account email was changed but the record update failed AND could not be rolled back. Manual review is required — do not retry blindly.' }
      }
      await deps.markFailed(claim.deliveryId, uniqueViol ? 'waitlist_email_conflict' : 'waitlist_guard_failed')
      deps.log('email_change_rolled_back', { state: 'conflict', unique: uniqueViol })
      return conflict(uniqueViol
        ? 'The replacement email is already used by another record. The account email was restored; nothing changed.'
        : 'Could not update the record email; the account email was restored. Nothing changed.')
    }
  }

  // (G) POST-UPDATE VERIFICATION — prove BOTH sides hold the new email before sending anything. A read
  //     that throws is treated as an UNPROVEN state → critical, never a send.
  const critical = (msg: string, stage = 'verify_mismatch'): ChangeEmailResult => {
    deps.log('email_change_critical', { state: 'critical', stage })
    return { ok: false, state: 'critical', changed, sent: false, deliveryId: claim.deliveryId, message: msg }
  }
  let vAuth: string, vRowEmail: string, vRowStatus: string | undefined
  try {
    vAuth = normalizeEmail((await deps.readAuthEmail(userId)) ?? '')
    const vRow = await deps.readWaitlist(input.waitlistId)
    vRowEmail = normalizeEmail(vRow?.email ?? '')
    vRowStatus = vRow?.status
  } catch {
    await deps.markFailed(claim.deliveryId, 'verify_mismatch')
    return critical('Could not verify the account and record emails after the update. Manual review is required before any invite is sent.')
  }
  if (vAuth !== newEmail || vRowEmail !== newEmail || vRowStatus !== 'invited') {
    await deps.markFailed(claim.deliveryId, 'verify_mismatch')
    return critical('The account and record emails do not match after the update. Manual review is required before any invite is sent.')
  }

  // (H) SEND one secure access link (recovery, passwordless) to the new address, keyed to the claim.
  let hashedToken: string, linkUserId: string | null
  try {
    ;({ hashedToken, userId: linkUserId } = await deps.generateLink(newEmail))
  } catch {
    await deps.markFailed(claim.deliveryId, 'link_generation_failed')
    deps.log('email_change_send_failed', { state: 'changed_send_failed', reason: 'link_generation_failed' })
    return { ok: false, state: 'changed_send_failed', changed, sent: false, deliveryId: claim.deliveryId,
      message: 'The email was updated, but the secure access link could not be generated. Use “Retry secure link”.' }
  }
  // The recovery link MUST belong to the SAME preserved Auth user. A resolved-user mismatch (email
  // collided with a different account) is a hard stop — critical, never sent.
  if (linkUserId && linkUserId !== userId) {
    await deps.markFailed(claim.deliveryId, 'link_user_mismatch')
    return critical('The secure link did not resolve to the expected account. Manual review is required before any invite is sent.', 'link_user_mismatch')
  }
  const link = buildRecoverLink({ siteUrl: deps.siteUrl, hashedToken, type: 'recovery' }) // token flows ONLY to sendEmail
  const idempotencyKey = `invite:${claim.deliveryId}`
  let send: { success: boolean; messageId?: string | null; errorClass?: string; uncertain?: boolean }
  try {
    send = await deps.sendEmail({ to: newEmail, toName: row.fullName || 'there', link, idempotencyKey })
  } catch {
    // A thrown send is an UNCERTAIN outcome — identity stays changed; the webhook / a 24h retry resolves it.
    send = { success: false, uncertain: true }
  }

  if (send.success) {
    await deps.markAccepted(claim.deliveryId, send.messageId ?? null, userId)
    deps.log('email_change_sent', { state: alreadyCurrent ? 'already_current' : 'changed_and_sent' })
    return { ok: true, state: alreadyCurrent ? 'already_current' : 'changed_and_sent', changed, sent: true, deliveryId: claim.deliveryId,
      message: alreadyCurrent ? 'Already on the new email — a fresh secure access link was sent.' : 'Email changed and a secure access link was sent.' }
  }
  if (send.uncertain) {
    // Outcome unknown — leave the claim in-flight; the webhook resolves it. Do NOT resend or roll back.
    deps.log('email_change_send_uncertain', { state: 'changed_send_uncertain' })
    return { ok: false, state: 'changed_send_uncertain', changed, sent: false, deliveryId: claim.deliveryId,
      message: 'The email was updated. Delivery status is pending — do not resend; it resolves automatically or can be retried after 24 hours.' }
  }
  await deps.markFailed(claim.deliveryId, send.errorClass ?? 'provider_error')
  deps.log('email_change_send_failed', { state: 'changed_send_failed', reason: send.errorClass ?? 'provider_error' })
  return { ok: false, state: 'changed_send_failed', changed, sent: false, deliveryId: claim.deliveryId,
    message: 'The email was updated, but the secure access link could not be sent. It is safe to retry the link.' }
}
