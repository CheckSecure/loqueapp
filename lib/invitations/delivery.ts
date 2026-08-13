import { shouldApplyStatus, type DeliveryStatus } from '@/lib/webhooks/resendVerify'
import { isMissingColumnError } from '@/lib/db/isMissingColumn'
import { INVITE_RETRY_WINDOW_MS } from '@/lib/waitlist/inviteStatus'

// Durable invitation-delivery records + webhook event log (service-role only). Stores NO
// token/link/password/body. The PRE-SEND CLAIM FAILS CLOSED: if it cannot be persisted (migration
// 049 missing, permission error, or any DB failure) the caller must send nothing.

const isUniqueViolation = (e: any) => e?.code === '23505'

/**
 * PRE-SEND ATOMIC CLAIM. Inserts a 'claimed' attempt BEFORE any link generation/send. A
 * concurrent second click hits the (waitlist_id, purpose) partial-unique index → 23505 → we
 * resolve onto the EXISTING active claim and return isNew=false, so exactly one caller sends.
 *
 * FAIL CLOSED: if the claim cannot be written or the existing claim cannot be read (missing
 * table, permission error, transient DB error), returns `{ claimFailed: true }` and the
 * orchestrator refuses to generate a token, mutate Auth, call Resend, or write invited_at.
 * `stale` marks an unresolved `claimed` attempt PAST the 24h idempotency window (eligible for an
 * explicit admin-reviewed new attempt); within the window the attempt is neither resent nor
 * replaced (a same-key re-send with a regenerated token would be a 409 invalid_idempotent_request).
 */
export async function claimInviteDelivery(admin: any, args: {
  waitlistId: string | null
  authUserId: string | null
  email: string
  purpose: 'first_invite' | 'access_resend' | 'reminder'
  /** True when the send has additional recipients (CC/BCC) on the same provider message. When set, the
   *  webhook applier fails safe (state frozen at provider-accepted). NO address is stored — only the fact. */
  hasAdditionalRecipients?: boolean
}): Promise<{ deliveryId: string | null; isNew: boolean; claimFailed?: boolean; existingStatus?: string | null; stale?: boolean; existingRecipient?: string | null }> {
  const now = new Date().toISOString()
  const baseRow: Record<string, unknown> = {
    waitlist_id: args.waitlistId, auth_user_id: args.authUserId, recipient_email: args.email,
    purpose: args.purpose, provider: 'resend', status: 'claimed',
    attempted_at: now, created_at: now, updated_at: now,
  }
  const row = args.hasAdditionalRecipients ? { ...baseRow, has_additional_recipients: true } : baseRow
  let { data, error } = await admin.from('invitation_deliveries').insert(row).select('id').single()
  // Fail OPEN on a missing has_additional_recipients column (migration 054 not yet applied): retry
  // without it so the claim still succeeds (webhook then treats it as single-recipient until applied).
  if (error && args.hasAdditionalRecipients && isMissingColumnError(error)) {
    ;({ data, error } = await admin.from('invitation_deliveries').insert(baseRow).select('id').single())
  }
  if (!error) {
    if (!data?.id) { console.error('[invitation_deliveries] claim insert returned no id — failing closed'); return { deliveryId: null, isNew: false, claimFailed: true } }
    return { deliveryId: data.id, isNew: true }
  }

  if (isUniqueViolation(error) && args.waitlistId) {
    // An active claim already exists for (waitlist_id, purpose) — resolve onto it (no-op insert).
    // If we cannot READ it, fail closed rather than send blind.
    const { data: existing, error: selErr } = await admin
      .from('invitation_deliveries')
      .select('id, status, attempted_at, recipient_email')
      .eq('waitlist_id', args.waitlistId).eq('purpose', args.purpose).in('status', ['claimed', 'accepted', 'deferred'])
      .order('attempted_at', { ascending: false }).limit(1).maybeSingle()
    if (selErr || !existing?.id) {
      console.error('[invitation_deliveries] active-claim resolve failed — failing closed:', selErr?.message)
      return { deliveryId: null, isNew: false, claimFailed: true }
    }
    // In-flight statuses (claimed/accepted/deferred) block a blind send. Past the review window an
    // unresolved in-flight attempt is `stale` — eligible only for an explicit admin-reviewed new
    // attempt (a lost webhook must not leave it stuck forever). The existing claim's STORED recipient
    // is returned so a caller changing the address can prove the in-flight send is (or is not) bound
    // to the same recipient — it is NEVER rewritten here.
    const attempted = existing.attempted_at ? Date.parse(existing.attempted_at) : NaN
    const inFlight = existing.status === 'claimed' || existing.status === 'accepted' || existing.status === 'deferred'
    const stale = inFlight && Number.isFinite(attempted) && (Date.now() - attempted) >= INVITE_RETRY_WINDOW_MS
    return { deliveryId: existing.id, isNew: false, existingStatus: existing.status ?? null, stale, existingRecipient: existing.recipient_email ?? null }
  }
  // ANY other error — missing table (42P01, 049 pending), permission (42501), or transient —
  // FAILS CLOSED. Never fall back to an untracked send.
  console.error('[invitation_deliveries] claim failed (fail-closed):', error?.message)
  return { deliveryId: null, isNew: false, claimFailed: true }
}

export async function markDeliveryAccepted(admin: any, deliveryId: string | null, providerMessageId: string | null, authUserId: string | null = null): Promise<void> {
  if (!deliveryId) return
  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { status: 'accepted', provider_message_id: providerMessageId, accepted_at: now, updated_at: now }
  if (authUserId) patch.auth_user_id = authUserId
  const { error } = await admin.from('invitation_deliveries').update(patch).eq('id', deliveryId)
  if (error && !isMissingColumnError(error)) console.error('[invitation_deliveries] mark accepted failed:', error.message)
}

export async function markDeliveryFailed(admin: any, deliveryId: string | null, errorClass: string): Promise<void> {
  if (!deliveryId) return
  const now = new Date().toISOString()
  const { error } = await admin.from('invitation_deliveries')
    .update({ status: 'failed', error_class: errorClass, failed_at: now, updated_at: now })
    .eq('id', deliveryId)
  if (error && !isMissingColumnError(error)) console.error('[invitation_deliveries] mark failed failed:', error.message)
}

/**
 * Apply ONE verified webhook event, replay- + ordering-safe AND recoverable after a partial
 * failure:
 *   0. REQUIRE a valid provider timestamp (event_created_at). Ordering depends on it; we NEVER
 *      substitute local receipt time. An invalid/missing timestamp → 'invalid' (no state change).
 *   1. claim svix_id (unique insert). On a duplicate svix_id, only a TERMINAL prior result
 *      ('applied'/'ignored') is a completed duplicate; a RETRYABLE prior result ('received'/
 *      'error'/'not_found' — a crash mid-apply, or a not-yet-persisted message id) RE-APPLIES.
 *   2. find the delivery by provider_message_id; a miss is 'not_found' → RETRYABLE (the message id
 *      may not be persisted yet), so the caller returns 500 and the webhook is redelivered.
 *   3. skip if OLDER than the last applied event (event_created_at) OR the status would regress;
 *   4. otherwise apply + advance last_event_at; record the terminal event result.
 */
export async function applyDeliveryEvent(admin: any, e: {
  svixId: string
  providerMessageId: string
  eventType: string
  eventCreatedAt: string | null
  status: DeliveryStatus
}): Promise<'applied' | 'ignored' | 'duplicate' | 'not_found' | 'error' | 'invalid'> {
  // 0) Ordering integrity: without a valid provider timestamp the event cannot be ordered and
  //    must NEVER overwrite delivery state. Fail safe (no row written, no state change).
  const createdMs = e.eventCreatedAt ? Date.parse(e.eventCreatedAt) : NaN
  if (!Number.isFinite(createdMs)) return 'invalid'

  // 1) Claim the svix_id, OR pick up a retryable prior attempt so a mid-apply crash recovers.
  const { error: claimErr } = await admin.from('invitation_delivery_events').insert({
    svix_id: e.svixId, provider_message_id: e.providerMessageId, event_type: e.eventType,
    event_created_at: e.eventCreatedAt, received_at: new Date().toISOString(), result: 'received',
  })
  if (claimErr) {
    if (isUniqueViolation(claimErr)) {
      // Event row already exists. A completed duplicate is ONLY a terminal prior result; a
      // 'received'/'error'/'not_found' prior attempt did not finish → re-apply (fall through).
      const { data: prior } = await admin.from('invitation_delivery_events')
        .select('result').eq('svix_id', e.svixId).maybeSingle()
      const priorResult = prior?.result ?? null
      if (priorResult === 'applied' || priorResult === 'ignored') return 'duplicate'
      // else: retryable prior state → continue and re-apply against the (existing) event row.
    } else {
      if (!isMissingColumnError(claimErr)) console.error('[delivery_events] claim failed:', claimErr.message)
      return 'error'
    }
  }

  const finalize = async (result: string) => {
    await admin.from('invitation_delivery_events').update({ result }).eq('svix_id', e.svixId)
  }

  const { data: row, error } = await admin.from('invitation_deliveries')
    .select('id, status, last_event_at, has_additional_recipients').eq('provider_message_id', e.providerMessageId).maybeSingle()
  if (error) { await finalize('error'); return 'error' }
  // Unknown message id: RETRYABLE, not terminal. The message id may not be persisted yet (webhook
  // raced ahead of markDeliveryAccepted). Leave result 'not_found' so a redelivery re-applies once
  // the delivery row appears; the caller returns a retryable 500.
  if (!row) { await finalize('not_found'); return 'not_found' }

  // MULTI-RECIPIENT FAIL-SAFE: this delivery shares ONE Resend message with additional recipients
  // (CC/BCC). Resend does NOT reliably attribute a bounce/complaint/delivery to a specific mailbox on a
  // multi-recipient message, so we NEVER let an ambiguous event change the primary recipient's state:
  // keep the provider-'accepted' state set at send time (never mark delivered on another mailbox, never
  // mark bounced/failed on another mailbox's bounce) and NEVER trigger a resend. Column absent
  // (pre-migration) → treated as single-recipient (legacy apply).
  if (row.has_additional_recipients) { await finalize('ignored'); return 'ignored' }

  // Ordering guard: an older event never overwrites a newer applied state. Uses PROVIDER time only.
  const older = row.last_event_at && new Date(e.eventCreatedAt as string) < new Date(row.last_event_at)
  if (older || !shouldApplyStatus(row.status, e.status)) { await finalize('ignored'); return 'ignored' }

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { status: e.status, updated_at: now, last_event_at: e.eventCreatedAt }
  if (e.status === 'delivered') patch.delivered_at = now
  else if (e.status === 'bounced' || e.status === 'complained' || e.status === 'blocked' || e.status === 'failed') patch.failed_at = now
  else if (e.status === 'accepted') patch.accepted_at = now
  else if (e.status === 'deferred') patch.updated_at = now // deferred stays in-flight; no terminal stamp

  const { error: upErr } = await admin.from('invitation_deliveries').update(patch).eq('id', row.id)
  if (upErr) { await finalize('error'); return 'error' }
  await finalize('applied')
  return 'applied'
}
