import { expireIntroPair, EXPIRY_AGE_DAYS } from '@/lib/introductions/expiry'

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
  truncated: boolean
  outcomes: Record<string, number>
}

export async function runExpiryStage(
  admin: any,
  opts: { maxPairs?: number; maxLegacy?: number; budgetMs: number },
): Promise<ExpiryStageResult> {
  const started = Date.now()
  const maxPairs = opts.maxPairs ?? 150
  const maxLegacy = opts.maxLegacy ?? 150
  const outcomes: Record<string, number> = {}
  let pairsProcessed = 0, legacyExpired = 0, truncated = false
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

  return { pairsProcessed, legacyExpired, truncated, outcomes }
}
