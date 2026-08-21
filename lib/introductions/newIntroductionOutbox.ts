/**
 * The worker that drains public.introduction_email_outbox (migration 070).
 *
 * ── WHY THE EVENT IS NOT CREATED HERE ──────────────────────────────────────────────────────────
 *
 * An earlier version of this module announced new introductions from application code immediately
 * after the writing transaction committed. That is not durable, and no amount of care in this file
 * could make it so: if the process dies between the card's COMMIT and this code creating any
 * record, nothing anywhere knows an email is owed, and unless some later caller happens to revisit
 * that member it is lost permanently.
 *
 * The event is therefore written by a database trigger, inside the writer's own transaction. Card
 * and event commit together or not at all. This module only DRAINS what already exists durably, so
 * a crash here delays an email instead of losing one — the scheduled stage picks it up next run.
 *
 * ── CONSOLIDATION ──────────────────────────────────────────────────────────────────────────────
 *
 * Events are grouped by member, so a member whose operation committed two cards receives ONE email.
 * The reminder_deliveries claim is keyed on a fingerprint of the exact committed artifacts being
 * announced, which is what stops two workers, or a worker and an eager drain, from both sending.
 *
 * ── IDEMPOTENCE UNDER CONCURRENCY ──────────────────────────────────────────────────────────────
 *
 * Claiming is a conditional UPDATE (`... WHERE status='pending'`) that returns only the rows this
 * worker actually won, so two workers partition the events rather than duplicating them. The
 * event-keyed unique index on reminder_deliveries is the second, independent backstop.
 */

import { createHash, randomUUID } from 'crypto'
import { newYorkIsoWeekKey, reminderIneligibility, type ReminderProfile } from '@/lib/reminders/wednesdayIntroReminder'
import { claimEventDelivery, markAccepted, markFailed, CLAIM_LEASE_MS } from '@/lib/reminders/deliveryLedger'
import { NEW_INTRODUCTIONS } from '@/lib/reminders/purposes'
import { VISIBLE_STATUS } from '@/lib/introductions/capacity'

export const OUTBOX_MAX_EVENTS = 200
export const OUTBOX_MAX_MEMBERS = 100
export const OUTBOX_BUDGET_MS = 15_000
/** A 'claimed' event older than this was abandoned by a dead worker and may be retaken. */
export const OUTBOX_CLAIM_LEASE_MS = CLAIM_LEASE_MS

export interface OutboxStats {
  scanned: number
  claimed: number
  sent: number
  skipped: number
  failed: number
  released: number
  /** Events finished by observing an already-accepted delivery, after a crash mid-settlement. */
  recovered: number
  truncated: boolean
  readFailed: boolean
}

interface OutboxEvent { id: string; intro_request_id: string; member_id: string; attempt_count: number }

const OUTBOX = 'introduction_email_outbox'

/** Stable fingerprint of the committed artifacts being announced. Order-independent. */
export function eventKeyForCards(cardIds: string[]): string {
  return createHash('sha256').update([...cardIds].sort().join('|')).digest('hex').slice(0, 40)
}

const nowIso = () => new Date().toISOString()

/**
 * Settle events THIS worker still owns.
 *
 * Every write is conditioned on the event id, status='claimed', AND the exact token this worker was
 * issued. That last condition is the whole point: a worker that stalled past its lease, and whose
 * events another worker has since legitimately reclaimed, matches ZERO rows here. It cannot mark a
 * live delivery 'sent', and it cannot release an event someone else is actively sending.
 */
async function settleOwned(admin: any, ids: string[], token: string, patch: Record<string, unknown>): Promise<number> {
  if (!ids.length) return 0
  const { data } = await admin
    .from(OUTBOX)
    .update({ ...patch, updated_at: nowIso() })
    .in('id', ids)
    .eq('status', 'claimed')
    .eq('claim_token', token)       // ownership, not just state
    .select('id')
  return (data ?? []).length
}

/** Hand events back for a later run. Clears the lease, so the claim-shape CHECK stays satisfied. */
const releasePatch = (errorClass?: string) => ({
  status: 'pending', claim_token: null, claimed_at: null, claim_expires_at: null,
  ...(errorClass ? { last_error_class: errorClass } : {}),
})

/**
 * Drain the outbox. Bounded by event count, member count and wall clock; safe to run concurrently
 * with itself. `memberId` narrows it to one member for the optional eager drain after a writer
 * succeeds — correctness never depends on that call happening.
 */
export async function drainIntroductionOutbox(
  admin: any,
  opts?: {
    maxEvents?: number; maxMembers?: number; budgetMs?: number; memberId?: string
    send?: (email: string, firstName: string | null) => Promise<{ sent: boolean; providerMessageId: string | null }>
  },
): Promise<OutboxStats> {
  const startedAt = Date.now()
  const maxEvents = opts?.maxEvents ?? OUTBOX_MAX_EVENTS
  const maxMembers = opts?.maxMembers ?? OUTBOX_MAX_MEMBERS
  const budgetMs = opts?.budgetMs ?? OUTBOX_BUDGET_MS
  const s: OutboxStats = { scanned: 0, claimed: 0, sent: 0, skipped: 0, failed: 0, released: 0, recovered: 0, truncated: false, readFailed: false }

  // 1. Candidates: pending, plus events whose claim lease has EXPIRED (a worker died holding them).
  //    This mirrors the claim predicate exactly — the scan must never surface a row the claim would
  //    refuse, or the two would disagree about what is stealable.
  const nowTs = nowIso()
  let q = admin.from(OUTBOX)
    .select('id, intro_request_id, member_id, attempt_count, status, claim_expires_at')
    .in('status', ['pending', 'claimed'])
    .order('created_at', { ascending: true })
    .limit(maxEvents + 1)
  if (opts?.memberId) q = q.eq('member_id', opts.memberId)
  const { data: rows, error: readErr } = await q
  if (readErr) {
    console.error('[intro-outbox] scan failed (class):', (readErr as any).code ?? 'unknown')
    s.readFailed = true
    return s
  }
  const candidates = (rows ?? []).filter((r: any) =>
    r.status === 'pending' || (r.status === 'claimed' && r.claim_expires_at && r.claim_expires_at < nowTs))
  s.scanned = candidates.length
  if (candidates.length > maxEvents) { s.truncated = true; candidates.length = maxEvents }
  if (!candidates.length) return s

  // 2. CLAIM. Two predicates, never one loose `status IN ('pending','claimed')` — that form has no
  //    lease condition, so worker B could overwrite worker A's FRESH claim while A was mid-delivery
  //    and both would send. A row is claimable only when it is pending, or when its lease has
  //    actually expired. Each claim mints a token that scopes every later write.
  const token = randomUUID()
  const claimedAt = nowIso()
  const expiresAt = new Date(Date.now() + OUTBOX_CLAIM_LEASE_MS).toISOString()
  const lease = { status: 'claimed', claim_token: token, claimed_at: claimedAt, claim_expires_at: expiresAt, updated_at: claimedAt }
  const ids = candidates.map((c: any) => c.id)
  const cols = 'id, intro_request_id, member_id, attempt_count'

  const { data: wonPending, error: e1 } = await admin
    .from(OUTBOX).update(lease).in('id', ids).eq('status', 'pending').select(cols)
  const { data: wonStale, error: e2 } = await admin
    .from(OUTBOX).update(lease).in('id', ids)
    .eq('status', 'claimed')
    .lt('claim_expires_at', claimedAt)   // ONLY an expired lease may be taken over
    .select(cols)
  if (e1 || e2) {
    console.error('[intro-outbox] claim failed (class):', ((e1 ?? e2) as any).code ?? 'unknown')
    s.readFailed = true
    return s
  }
  const events: OutboxEvent[] = [...(wonPending ?? []), ...(wonStale ?? [])] as any
  // 3. One email per member, however many cards their operation committed.
  const byMember = new Map<string, OutboxEvent[]>()
  for (const e of events) {
    if (!byMember.has(e.member_id)) byMember.set(e.member_id, [])
    byMember.get(e.member_id)!.push(e)
  }

  let membersDone = 0
  for (const [memberId, evs] of Array.from(byMember.entries())) {
    if (membersDone >= maxMembers || Date.now() - startedAt > budgetMs) {
      // Hand the rest back rather than holding a claim we will not service this run.
      await settleOwned(admin, evs.map((e) => e.id), token, releasePatch())
      s.released += evs.length
      s.truncated = true
      continue
    }
    membersDone++
    const evIds = evs.map((e) => e.id)

    // 4. RE-READ committed state. The card may have been passed, expired or matched between the
    //    trigger firing and this run, and announcing a card that is no longer there is wrong.
    const { data: cards, error: cardErr } = await admin
      .from('intro_requests')
      .select('id, status')
      .in('id', evs.map((e) => e.intro_request_id))
    if (cardErr) {
      await settleOwned(admin, evIds, token, releasePatch('card_read_failed'))
      s.released += evIds.length
      continue                                  // FAIL CLOSED: never send on an uncertain read
    }
    const live = (cards ?? []).filter((c: any) => c.status === VISIBLE_STATUS).map((c: any) => c.id)
    if (!live.length) {
      await settleOwned(admin, evIds, token, { status: 'skipped', processed_at: nowIso(), last_error_class: 'no_longer_visible', claim_token: null, claimed_at: null, claim_expires_at: null })
      s.skipped += evIds.length
      continue
    }

    // 5. Eligibility. One profile read per member per run — not per card, and not per event.
    const { data: prof, error: profErr } = await admin
      .from('profiles')
      .select('id, email, full_name, account_status, profile_complete, is_test_account, is_admin, matching_paused')
      .eq('id', memberId).maybeSingle()
    if (profErr) {
      await settleOwned(admin, evIds, token, releasePatch('profile_read_failed'))
      s.released += evIds.length
      continue
    }
    const p: ReminderProfile = {
      id: memberId,
      email: prof?.email ?? null,
      firstName: (prof?.full_name ?? '').split(' ')[0] || null,
      accountStatus: prof?.account_status ?? null,
      profileComplete: prof?.profile_complete ?? null,
      isTestAccount: prof?.is_test_account ?? null,
      isAdmin: prof?.is_admin ?? null,
      matchingPaused: prof?.matching_paused ?? null,
    }
    if (reminderIneligibility(p, live.length) !== null) {
      await settleOwned(admin, evIds, token, { status: 'skipped', processed_at: nowIso(), last_error_class: 'ineligible', claim_token: null, claimed_at: null, claim_expires_at: null })
      s.skipped += evIds.length
      continue
    }

    // 6. THE DELIVERY CLAIM, keyed on the exact artifacts being announced.
    const eventKey = eventKeyForCards(live)
    const settled = { status: 'sent', processed_at: nowIso(), claim_token: null, claimed_at: null, claim_expires_at: null }
    const claim = await claimEventDelivery(admin, {
      memberId, purpose: NEW_INTRODUCTIONS, cycleKey: newYorkIsoWeekKey(new Date()),
      eventKey, openCardCount: live.length,
    })

    if (!claim.claimed || !claim.deliveryId) {
      // ── ACCEPTED-BUT-UNSETTLED RECOVERY ────────────────────────────────────────────────────────
      // A delivery for these exact artifacts already exists. Its recorded state distinguishes two
      // very different situations, and conflating them is how you either duplicate an email or
      // strand an event forever:
      //
      //   'accepted'/'delivered' → the provider DEMONSTRABLY took it. A previous worker crashed
      //                            after recording that and before settling these events. Re-sending
      //                            would duplicate a mail that was already delivered, so the correct
      //                            action is to finish the bookkeeping: mark the events sent.
      //   'claimed'              → still in flight, or its owner died before recording an outcome.
      //                            Nothing is known, so hand the events back and let the delivery
      //                            lease decide. This is the genuinely ambiguous case.
      const { data: existing } = await admin
        .from('reminder_deliveries')
        .select('status')
        .eq('member_id', memberId).eq('purpose', NEW_INTRODUCTIONS).eq('event_key', eventKey)
        .maybeSingle()
      if (existing && ['accepted', 'delivered'].includes(existing.status)) {
        s.recovered += await settleOwned(admin, evIds, token, settled)
        s.sent += evIds.length
      } else {
        s.released += await settleOwned(admin, evIds, token, releasePatch())
      }
      continue
    }

    // 7. Provider call. Outside any transaction, by construction — this is a worker, not a trigger.
    const send = opts?.send ?? (async (email: string, firstName: string | null) => {
      const { sendNewIntroductionsEmail } = await import('@/lib/email')
      return sendNewIntroductionsEmail(email, firstName)
    })
    try {
      const res = await send(p.email as string, p.firstName)
      if (res.sent) {
        // ORDER MATTERS. The ledger is written FIRST, so a crash in the gap leaves exactly the
        // recoverable 'accepted but unsettled' state handled above — never a silent double send.
        await markAccepted(admin, claim.deliveryId, res.providerMessageId)
        await settleOwned(admin, evIds, token, settled)
        s.sent += evIds.length
      } else {
        // Opted out of introduction email. A definite non-send, not a failure: settle it so these
        // events are not retried forever.
        await markAccepted(admin, claim.deliveryId, null)
        await settleOwned(admin, evIds, token, {
          status: 'skipped', processed_at: nowIso(), last_error_class: 'opted_out',
          claim_token: null, claimed_at: null, claim_expires_at: null,
        })
        s.skipped += evIds.length
      }
    } catch {
      // AMBIGUOUS, and deliberately NOT treated as the recoverable case: no outcome was recorded, so
      // the provider may or may not hold this message. The delivery row is left 'claimed' — inside
      // the active-claim index — and its lease governs any later attempt. The events go back to
      // pending: once the lease resolves they either find an 'accepted' delivery (recovered above,
      // no second send) or genuinely retry. At-most-once with an honest boundary, exactly as the
      // reminder ledger already documents. A duplicate here is possible and accepted; a silently
      // lost email is not.
      s.failed += evIds.length
      await settleOwned(admin, evIds, token, releasePatch('provider_error'))
      console.error('[intro-outbox] provider call failed (class): provider_error')
    }
  }

  return s
}

/**
 * Best-effort immediate drain for one member, for promptness only. Every guarantee lives in the
 * trigger and the scheduled stage; if this never runs, the email is still sent.
 */
export async function drainForMember(admin: any, memberId: string): Promise<void> {
  try {
    await drainIntroductionOutbox(admin, { memberId, maxMembers: 1, maxEvents: 20, budgetMs: 5_000 })
  } catch (e: any) {
    console.error('[intro-outbox] eager drain failed (non-fatal):', e?.message)
  }
}
