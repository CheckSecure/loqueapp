import { expireIntroPair, EXPIRY_AGE_DAYS } from '@/lib/introductions/expiry'
import { createNotificationSafe } from '@/lib/notifications'
import { promoteIfResolved } from '@/lib/introductions/queue'
import { notifyNewVisibleBatch } from '@/lib/notifications/engagement'

/**
 * BACKLOG CUTOFF for the promotion sweep — the instant the sweep shipped.
 *
 * A queued batch created BEFORE this is backlog: it has been hidden for weeks because nothing
 * ever called promotion for a member with an empty screen. Revealing it is right; announcing it
 * is not. A batch created AFTER is a normal new arrival and is announced.
 *
 * WHY A TIMESTAMP AND NOT A RUN COUNTER. "Silent on the first run, loud afterwards" is the
 * intent, but a run counter implements it wrongly: the sweep is budget-bounded, so a large
 * backlog spills into run 2 and those members would be announced simply because they sorted
 * later. The cutoff makes silence a property of the CARD, not of which pass happened to reach it.
 */
const SWEEP_BACKLOG_CUTOFF = new Date('2026-08-28T00:00:00Z')

/**
 * The bounded suggested-card expiry stage.
 *
 * WHY IT LIVES HERE AND NOT IN A CRON ROUTE. /api/cron/expire-pending-intros is CONFIGURED in
 * vercel.json but was not observed registered in production, and this project is on Vercel Hobby,
 * where only two cron jobs run. Making capacity recovery depend on a route that may never fire
 * would reproduce the stale-capacity bug by a different mechanism. /api/cron/engagement-reminders
 * IS observed running, so it owns this stage; expire-pending-intros keeps its original 30-day
 * 'pending' sweep and calls this too, but nothing depends on that route being scheduled.
 *
 * Bounded and deadline-aware: the caller passes the wall-clock budget this stage may consume, so it
 * can never starve the Wednesday reminder or the pre-existing engagement work.
 */
export interface ExpiryStageResult {
  pairsProcessed: number
  legacyExpired: number
  /** Queued-batch promotion sweep. Aggregate counts only. */
  promotion: { swept: number; promoted: number; announced: number; silentBacklog: number; failed: number; truncated: boolean } | null
  /** Non-pair 'approved' rows closed because the counterpart can no longer answer. */
  orphanExpired: number
  truncated: boolean
  outcomes: Record<string, number>
  /** Unavailable-pair sweep (migration 085). Aggregate counts only — never member data. */
  unavailable: { processed: number; released: number; skipped: number; failed: number; truncated: boolean } | null
}

/**
 * Notify the member whose one-sided interest was closed by a PAIR expiry.
 *
 * Reuses the existing 'interest_expired' type and its copy, overriding both only to name the
 * counterpart. Naming them leaks nothing: this member SAW that card and chose to express interest
 * in that specific person, so the name is already theirs. It is read from base `profiles` rather
 * than `public_profiles` because this runs in a cron with no session — the discovery view is
 * security_invoker and returns nothing to a service-role caller.
 *
 * THE COPY ASSIGNS NO FAULT. "No response within 14 days" alongside a name would point at the
 * counterpart for a decision that was never theirs to make visibly — under the two-sided model they
 * were never told anyone was interested. The wording says what happened and, usefully, that the
 * interest stayed private, which is the thing a member in this position actually wonders about.
 *
 * dedupeKey is the expresser's row id, so a re-run of the stage cannot notify twice for the same
 * card, and two cards closing on the same day each notify once rather than being collapsed by the
 * default 24h digest window.
 */
async function notifyExpiredExpresser(
  admin: any,
  expresserRow: { id: string; requester_id: string; target_user_id: string },
): Promise<void> {
  let counterpartFirst = ''
  const { data: other } = await admin
    .from('profiles')
    .select('full_name')
    .eq('id', expresserRow.target_user_id)
    .maybeSingle()
  counterpartFirst = ((other?.full_name ?? '').trim().split(/\s+/)[0]) || ''

  await createNotificationSafe({
    userId: expresserRow.requester_id,
    type: 'interest_expired',
    data: { dedupeKey: expresserRow.id, introRequestId: expresserRow.id },
    dedupeKey: expresserRow.id,
    // No name resolved → the static copy stands, so the member still learns the card closed.
    ...(counterpartFirst
      ? {
          title: `Your introduction to ${counterpartFirst} has closed`,
          body: `Introductions close after 14 days without a mutual response. Your interest stayed private and was never shared.`,
        }
      : {}),
  })
}

export async function runExpiryStage(
  admin: any,
  opts: { maxPairs?: number; maxLegacy?: number; maxUnavailable?: number; budgetMs: number },
): Promise<ExpiryStageResult> {
  const started = Date.now()
  const maxPairs = opts.maxPairs ?? 150
  const maxLegacy = opts.maxLegacy ?? 150
  const outcomes: Record<string, number> = {}
  let pairsProcessed = 0, legacyExpired = 0, orphanExpired = 0, truncated = false
  let promotion: ExpiryStageResult['promotion'] = null
  const outOfTime = () => Date.now() - started > opts.budgetMs
  const cutoff = new Date(Date.now() - EXPIRY_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // RECIPROCAL — delegated wholly to public.expire_intro_pair. Oldest first, deterministic.
  const { data: pairRows, error: pairErr } = await admin
    .from('intro_requests')
    .select('pair_id, created_at')
    .in('status', ['suggested', 'approved', 'accepted', 'pending'])
    .not('pair_id', 'is', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(maxPairs * 2)
  if (pairErr) {
    // Coarse class only, and the stage stops rather than guessing.
    console.error('[intro-expiry] pair read failed (class):', (pairErr as any).code ?? 'unknown')
    outcomes['read_failed'] = 1
  } else {
    const seen = new Set<string>()
    for (const r of pairRows ?? []) {
      if (!r?.pair_id || seen.has(r.pair_id)) continue
      if (seen.size >= maxPairs || outOfTime()) { truncated = true; break }
      seen.add(r.pair_id)

      // READ BEFORE EXPIRING, because afterwards it is unrecoverable. expire_intro_pair moves every
      // live row of the pair to 'expired' in a single statement, so once it returns nothing
      // distinguishes the side that expressed interest from the side that never answered. The
      // notification below needs exactly that distinction.
      //
      // Cheap and bounded: one small read per pair, inside a stage that is already budget-limited
      // and capped at maxPairs.
      const { data: preRows } = await admin
        .from('intro_requests')
        .select('id, requester_id, target_user_id, status')
        .eq('pair_id', r.pair_id)
      const expresserRow = (preRows ?? []).find((row: any) =>
        ['approved', 'accepted', 'pending'].includes(row?.status))

      const res = await expireIntroPair(admin, r.pair_id, EXPIRY_AGE_DAYS)
      outcomes[res.outcome] = (outcomes[res.outcome] ?? 0) + 1
      pairsProcessed++

      // TELL THE EXPRESSER — the gap this closes.
      //
      // The legacy/orphan stage below already notifies a member whose one-sided interest is closed,
      // for a reason that applies identically here: their card vanishes from "Interest expressed"
      // the moment the row leaves 'approved', and there is no expired surface. But that stage
      // filters `.is('pair_id', null)`, so a PAIR-based expresser reached neither it nor any other
      // notification. Their interest was closed in silence.
      //
      // Gated on the RPC's own verdict, not on the pre-read: only 'expired' + 'one_sided_interest'
      // means exactly one side had expressed and the pair actually closed. If the counterpart acted
      // in between, the RPC returns 'protected'/'mutual_pending' and nothing is sent.
      if (res.outcome === 'expired' && res.pairCase === 'one_sided_interest' && expresserRow) {
        await notifyExpiredExpresser(admin, expresserRow).catch((e) => {
          // Non-fatal, exactly as in the orphan stage: the pair IS closed, and a missed
          // notification must never re-open it or halt the run.
          console.error('[intro-expiry] pair notify failed (non-fatal):', (e as any)?.message ?? 'unknown')
          outcomes['pair_notify_failed'] = (outcomes['pair_notify_failed'] ?? 0) + 1
        })
      }
    }
  }

  // LEGACY / ADMIN one-sided rows: no counterpart exists, so none is manufactured. Only rows still
  // 'suggested' and old enough move; no closed or historical row is touched.
  if (!truncated && !outOfTime()) {
    const { data: legacyRows, error: legacyErr } = await admin
      .from('intro_requests')
      .select('id')
      .eq('status', 'suggested')
      .is('pair_id', null)
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(maxLegacy)
    if (legacyErr) {
      console.error('[intro-expiry] legacy read failed (class):', (legacyErr as any).code ?? 'unknown')
      outcomes['legacy_read_failed'] = 1
    } else {
      for (const row of legacyRows ?? []) {
        if (outOfTime()) { truncated = true; break }
        const { error: updErr } = await admin
          .from('intro_requests')
          .update({ status: 'expired', expired_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', row.id)
          .eq('status', 'suggested')   // re-check: never move a row that changed underneath us
        if (updErr) { outcomes['legacy_update_failed'] = (outcomes['legacy_update_failed'] ?? 0) + 1; continue }
        legacyExpired++
      }
    }
  }

  // ── ORPHANED ONE-SIDED INTEREST ───────────────────────────────────────────────────────────
  //
  // THE GAP THIS CLOSES. Only expire_intro_pair can move an 'approved' row, and it requires a
  // pair_id. The legacy branch above and sweep_unavailable_introductions (085) both filter
  // status='suggested'; expire-pending-intros filters 'pending'. So a NON-PAIR row that the
  // expresser approved was unreachable by every expiry path — it sat 'approved' forever and the
  // Introductions page rendered it as "Awaiting their response" indefinitely. Production held 34
  // such rows across 21 members, the oldest six weeks old, on cards that could never resolve.
  //
  // Migration 066 already wrote the rule for pairs and stated the reason: its Case B closes the
  // interested side alongside the unanswered one "so both directions stop consuming visible and
  // pending capacity together and neither member is left holding a row the other cannot see."
  // That reasoning was never applied to the one-sided path. This is the same close, with the same
  // guards, for rows that have no pair to delegate to.
  //
  // GUARDS, mirroring expire_intro_pair exactly:
  //   • never when a match exists                 (066: 'protected'/'match_exists')
  //   • never when BOTH sides are interested      (066: 'protected'/'mutual_pending')
  //     Finalization owns that pair — including the credit-blocked case, where both rows are
  //     'approved' and a top-up may still complete it. Expiry must not pre-empt that.
  //   • only rows old enough
  //
  // CLOCK. Measured from updated_at, not created_at: updated_at is when the expresser acted and
  // therefore when the counterpart's response window actually began. created_at would close a
  // card approved yesterday merely because it was recommended weeks ago.
  if (!truncated && !outOfTime()) {
    const { data: orphanRows, error: orphanErr } = await admin
      .from('intro_requests')
      .select('id, requester_id, target_user_id, updated_at')
      .eq('status', 'approved')
      .eq('is_admin_initiated', false)
      .is('pair_id', null)
      .lt('updated_at', cutoff)
      .order('updated_at', { ascending: true })
      .limit(maxLegacy)
    if (orphanErr) {
      console.error('[intro-expiry] orphan read failed (class):', (orphanErr as any).code ?? 'unknown')
      outcomes['orphan_read_failed'] = 1
    } else {
      for (const row of orphanRows ?? []) {
        if (outOfTime()) { truncated = true; break }

        // A match makes this row history, not a pending question. Never touch it.
        const { data: matchRow } = await admin
          .from('matches')
          .select('id')
          .or(`and(user_a_id.eq.${row.requester_id},user_b_id.eq.${row.target_user_id}),` +
              `and(user_a_id.eq.${row.target_user_id},user_b_id.eq.${row.requester_id})`)
          .limit(1)
          .maybeSingle()
        if (matchRow) { outcomes['orphan_skipped_matched'] = (outcomes['orphan_skipped_matched'] ?? 0) + 1; continue }

        // The counterpart's own row, if it exists at all.
        const { data: counterpart } = await admin
          .from('intro_requests')
          .select('status')
          .eq('requester_id', row.target_user_id)
          .eq('target_user_id', row.requester_id)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        // BOTH interested → finalization owns it. Identical to 066's mutual_pending guard.
        if (counterpart && ['approved', 'accepted', 'pending'].includes(counterpart.status)) {
          outcomes['orphan_skipped_mutual'] = (outcomes['orphan_skipped_mutual'] ?? 0) + 1
          continue
        }
        // Still live and answerable → the counterpart can act; leave it alone.
        if (counterpart && counterpart.status === 'suggested') {
          outcomes['orphan_skipped_counterpart_live'] = (outcomes['orphan_skipped_counterpart_live'] ?? 0) + 1
          continue
        }

        // NEVER SHOWN — 'queued' is the RESERVED tier. The card exists but has never been rendered
        // to the counterpart, so this is not "they did not answer", it is "they were never asked".
        //
        // Closing it would expire an introduction the other member never saw AND tell the expresser
        // "no response within 14 days", which is false about a card nobody was shown. The whole
        // point of that copy was to assign no fault; auto-closing a queued counterpart would make
        // it an untrue statement instead of an unfair one.
        //
        // These are HELD, not closed, and counted so the backlog is visible rather than silently
        // absorbed. A queued row becomes visible only via public.promote_queued_rows, which is
        // called ONLY from the counterpart's own actions (express-interest, accept-incoming,
        // createIntroRequest, app/actions.ts) — there is no cron. A counterpart with nothing
        // visible to act on therefore has no way to reach it, and this counter is how that backlog
        // is noticed. Triage with supabase/repairs/backfill_orphaned_interest.sql section A.
        if (counterpart && counterpart.status === 'queued') {
          outcomes['orphan_held_counterpart_queued'] = (outcomes['orphan_held_counterpart_queued'] ?? 0) + 1
          continue
        }

        // Reachable states now: no counterpart row at all (never accepted), or a terminal one
        // (expired / passed / declined / rejected / archived / hidden). Both mean the question
        // can no longer be answered.
        //
        // This list was previously wrong: it omitted 'queued', so a never-shown card fell through
        // to CLOSE. Seven production rows sat in exactly that state. If a new status is added to
        // intro_requests, decide explicitly which branch it belongs in rather than letting it
        // reach here by default.

        const { error: updErr } = await admin
          .from('intro_requests')
          .update({ status: 'expired', expired_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', row.id)
          .eq('status', 'approved')   // re-check: never move a row that changed underneath us
        if (updErr) { outcomes['orphan_update_failed'] = (outcomes['orphan_update_failed'] ?? 0) + 1; continue }
        orphanExpired++

        // TELL THE EXPRESSER. Their card disappears from "Interest expressed" the moment this row
        // leaves 'approved' — page.tsx selects status IN ('pending','approved') and there is no
        // expired surface — so without this the card vanishes with no explanation.
        //
        // ── THE BACKFILL IS SILENT, DELIBERATELY. DO NOT "FIX" THIS. ───────────────────────────
        // The rows that were already stuck when this stage shipped are closed by
        // supabase/repairs/backfill_orphaned_interest.sql, which writes intro_requests DIRECTLY and
        // never reaches this code path. That is the point: firing 34 notifications at once, for
        // cards up to six weeks old, is a worse first impression of the feature than the silence it
        // replaces. Notifications are for cards that expire from HERE FORWARD. If you are tempted
        // to make the backfill notify, that decision was already taken the other way — reopen it
        // deliberately, do not quietly change it.
        //
        // dedupeKey is the row id, so a retry of this stage cannot notify twice for the same card,
        // and two cards closing on the same day each notify once (the default 24h digest window
        // would otherwise collapse them into one).
        await createNotificationSafe({
          userId: row.requester_id,
          type: 'interest_expired',
          data: { dedupeKey: row.id },
          dedupeKey: row.id,
        }).catch((e) => {
          // Non-fatal: the row IS closed. A missed notification must never re-open it or halt the
          // stage; the counter stays honest either way.
          console.error('[intro-expiry] orphan notify failed (non-fatal):', (e as any)?.message ?? 'unknown')
          outcomes['orphan_notify_failed'] = (outcomes['orphan_notify_failed'] ?? 0) + 1
        })
      }
    }
  }

  // ── QUEUED PROMOTION SWEEP ────────────────────────────────────────────────────────────────
  //
  // THE DEADLOCK THIS BREAKS. A 'queued' row becomes visible only via
  // public.promote_queued_rows, and every caller is one of the member's OWN actions
  // (express-interest, accept-incoming, createIntroRequest, app/actions.ts). There was no cron.
  // So a member holding ZERO visible cards has nothing to act on, nothing calls promotion, and
  // their queued cards stay hidden — permanently. Coverage generation used to break the cycle by
  // filling members with no visible card; WEEKLY_COVERAGE_GENERATION was turned off 2026-08-27,
  // after which nothing did.
  //
  // This is PULL becoming PUSH. It adds no new capacity logic: promote_queued_rows already holds
  // the member advisory lock, re-counts visible slots after completing the active batch, clamps to
  // free slots, and is idempotent — so calling it for a member who is not promotable is a cheap
  // no-op that returns a reason. The sweep only decides WHO to call it for.
  //
  // ── THE FIRST SWEEP IS SILENT, DELIBERATELY. DO NOT "FIX" THIS. ────────────────────────────
  // Batches created before SWEEP_BACKLOG_CUTOFF are backlog — hidden for weeks through no act of
  // the member's. Revealing them is right; announcing them is not: a burst of "new introductions"
  // for cards that have been sitting invisible is a worse first impression than the silence it
  // replaces, exactly as decided for supabase/repairs/backfill_orphaned_interest.sql. Batches
  // created after the cutoff are ordinary new arrivals and ARE announced. If you are tempted to
  // announce the backlog, that decision was already taken the other way — reopen it deliberately.
  if (!truncated && !outOfTime()) {
    let swept = 0, promoted = 0, announced = 0, silentBacklog = 0, failed = 0, sweepTruncated = false
    const { data: queuedBatches, error: qErr } = await admin
      .from('recommendation_batches')
      .select('member_id, batch_id, created_at')
      .eq('state', 'queued')
      .order('created_at', { ascending: true })
      .limit(maxLegacy)
    if (qErr) {
      console.error('[intro-expiry] promotion sweep read failed (class):', (qErr as any).code ?? 'unknown')
      outcomes['promotion_read_failed'] = 1
    } else {
      const seen = new Set<string>()
      for (const b of queuedBatches ?? []) {
        if (outOfTime()) { sweepTruncated = true; truncated = true; break }
        if (!b?.member_id || seen.has(b.member_id)) continue
        seen.add(b.member_id)

        // Eligibility is re-checked here, not assumed from the batch's existence: a member may have
        // deactivated or paused matching since the batch was queued.
        const { data: prof } = await admin
          .from('profiles')
          .select('account_status, profile_complete, is_test_account, is_admin, matching_paused')
          .eq('id', b.member_id)
          .maybeSingle()
        if (!prof || prof.account_status !== 'active' || prof.profile_complete !== true
            || prof.is_test_account === true || prof.is_admin === true || prof.matching_paused === true) {
          outcomes['promotion_skipped_ineligible'] = (outcomes['promotion_skipped_ineligible'] ?? 0) + 1
          continue
        }

        swept++
        const promo = await promoteIfResolved(admin, b.member_id)
        if (!promo.promoted || !promo.newActive) {
          // Not an error: 'incomplete' (active batch unresolved), 'empty_queue', 'no_active' and
          // 'inconsistent_batches' are all normal answers. Counted coarsely by reason.
          outcomes[`promotion_noop_${promo.reason ?? 'unknown'}`] =
            (outcomes[`promotion_noop_${promo.reason ?? 'unknown'}`] ?? 0) + 1
          continue
        }
        promoted++

        // Backlog vs new arrival — see the cutoff note above.
        const queuedAt = b.created_at ? new Date(b.created_at) : null
        if (queuedAt && queuedAt < SWEEP_BACKLOG_CUTOFF) {
          silentBacklog++
          continue
        }
        try {
          await notifyNewVisibleBatch(b.member_id, promo.newActive)
          announced++
        } catch (e) {
          // Non-fatal: the cards ARE visible. A missed announcement must not un-promote them.
          console.error('[intro-expiry] promotion notify failed (non-fatal):', (e as any)?.message ?? 'unknown')
          failed++
        }
      }
    }
    promotion = { swept, promoted, announced, silentBacklog, failed, truncated: sweepTruncated }
  }

  // ── UNAVAILABLE-PAIR SWEEP (migration 085) ────────────────────────────────────────────────
  // Lives HERE, in the existing maintenance stage, rather than in a cron of its own: this stage is
  // already scheduled, already bounded, already budget-aware, and already owns "tidy up stale
  // introduction rows". A second cron for the same job would be a second thing to forget.
  //
  // IT IS NOT THE CORRECTNESS MECHANISM. All four database writers reconcile synchronously inside
  // their advisory locks, so a delayed, truncated, or failed sweep can never reduce a member's
  // weekly allocation. This only shortens the window in which a stale row sits in a slot.
  //
  // Everything else is delegated to public.sweep_unavailable_introductions: it is bounded, it takes
  // the canonical member advisory locks per card, it refuses anything that changed underneath it,
  // and it returns aggregate counts only. Nothing here logs a member id, name, or email.
  let unavailable: ExpiryStageResult['unavailable'] = null
  if (!outOfTime()) {
    const { data, error } = await admin.rpc('sweep_unavailable_introductions', {
      p_limit: opts.maxUnavailable ?? 100,
    })
    if (error) {
      // Coarse class only. A missing function (migration 085 not applied yet) is a no-op, not a
      // failure of the whole stage — the writers already reconcile without it.
      console.error('[intro-expiry] unavailable sweep failed (class):', (error as any).code ?? 'unknown')
      outcomes['unavailable_sweep_failed'] = (outcomes['unavailable_sweep_failed'] ?? 0) + 1
    } else if (data) {
      unavailable = {
        processed: Number(data.processed ?? 0),
        released: Number(data.released ?? 0),
        skipped: Number(data.skipped ?? 0),
        failed: Number(data.failed ?? 0),
        truncated: Boolean(data.truncated),
      }
      console.log('[intro-expiry] unavailable sweep:', JSON.stringify(unavailable))
    }
  }

  return { pairsProcessed, legacyExpired, orphanExpired, promotion, truncated, outcomes, unavailable }
}
