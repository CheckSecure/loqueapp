import { expireIntroPair, EXPIRY_AGE_DAYS } from '@/lib/introductions/expiry'
import { createNotificationSafe } from '@/lib/notifications'

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
  /** Non-pair 'approved' rows closed because the counterpart can no longer answer. */
  orphanExpired: number
  truncated: boolean
  outcomes: Record<string, number>
  /** Unavailable-pair sweep (migration 085). Aggregate counts only — never member data. */
  unavailable: { processed: number; released: number; skipped: number; failed: number; truncated: boolean } | null
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
      const res = await expireIntroPair(admin, r.pair_id, EXPIRY_AGE_DAYS)
      outcomes[res.outcome] = (outcomes[res.outcome] ?? 0) + 1
      pairsProcessed++
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
        // Reachable states now: no counterpart row at all (never accepted), or a terminal one
        // (expired / passed / declined / rejected / archived / hidden). Both mean the question
        // can no longer be answered.

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

  return { pairsProcessed, legacyExpired, orphanExpired, truncated, outcomes, unavailable }
}
