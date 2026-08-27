/**
 * Durable weekly-release evidence (migration 074).
 *
 * ── VISIBLE CARDS ARE NOT PROOF OF COMPLETION ──────────────────────────────────────────────────
 *
 * An earlier version of this module tried to repair a missing release marker by re-reading
 * committed cards. That was unsound, and the reason is worth stating precisely: after the
 * originating process ends, these two states are IDENTICAL in the database —
 *
 *     A. the loop finished normally, cards committed, the release insert failed
 *     B. the loop CRASHED halfway, some cards committed, the insert was never attempted
 *
 * Both show visible cards and no release row. A later job cannot tell them apart, so it must never
 * try. Only the writer knows it reached its end, and the only moment that knowledge exists is the
 * call it makes immediately after the loop. There is therefore NO reconciliation in this module and
 * no card-based inference anywhere.
 *
 * ── HOW COMPLETION IS RECORDED ─────────────────────────────────────────────────────────────────
 *
 * public.finalize_weekly_release does everything in one transaction: derives the Thursday window
 * and key from now(), takes an advisory lock, returns an existing fact if one is present, verifies
 * at least one committed visible introduction, and inserts the immutable row. The caller supplies
 * no key, no window and no count, so none can be fabricated.
 *
 * ── RECOVERY IS RE-RUNNING THE WRITER ──────────────────────────────────────────────────────────
 *
 * Both writers are already idempotent — materialize_admin_pair and create_reciprocal_suggestion
 * both refuse duplicates — so the repair for a failed finalization is simply to run the writer
 * again: it re-reaches its end and calls finalize again. A lost response is safe because a replay
 * returns the existing fact. That is why no second "run" table is needed.
 */

import { weeklyRunKey, currentCycleBatch } from '@/lib/introductions/thursdaySchedule'

export type ReleaseSource = 'admin_approval' | 'weekly_cron'

export interface ReleaseRecord {
  releaseKey: string
  releasedAt: string
}

/**
 * Every explicit refusal the RPC can raise, kept DISTINCT from a generic failure.
 *
 * Collapsing these into one value would hide the difference between "this needs an operator to look
 * at it" and "the database is unreachable", which are not the same problem.
 */
export type FinalizeRefusal =
  /** Nothing this run made visible in this window. Not an error; not a release either. */
  | 'no_visible_introductions'
  /** The batch's work all happened in an EARLIER window. Never re-date it — operator review. */
  | 'batch_belongs_to_earlier_window'
  /** The batch id does not exist. A caller cannot buy a release with an unrelated uuid. */
  | 'batch_not_found'
  /** Contract violations — a caller bug, surfaced rather than swallowed. */
  | 'admin_requires_batch_id'
  | 'weekly_forbids_batch_id'
  | 'invalid_source'
  /** Anything else. The caller MUST report this and must not claim completion. */
  | 'finalize_failed'

export type FinalizeResult =
  /** The fact exists. `wasExisting` distinguishes a fresh write from an idempotent replay. */
  | { finalized: true; releaseKey: string; releasedAt: string; cardsReleased: number; wasExisting: boolean }
  | { finalized: false; reason: FinalizeRefusal }

/**
 * Finalize the weekly release. Call ONLY when the writer's loop reached its normal end with ZERO
 * transient/system errors — a partially-failed run is not a release and must be retried instead.
 *
 * Never throws, but never disguises failure either: `finalized: false` is a real outcome the caller
 * is required to surface.
 */
export async function finalizeWeeklyRelease(
  admin: any,
  args: { source: ReleaseSource; batchId?: string | null },
): Promise<FinalizeResult> {
  try {
    const { data, error } = await admin.rpc('finalize_weekly_release', {
      p_source: args.source,
      p_batch_id: args.batchId ?? null,
    })

    if (error) {
      // The RPC refuses EXPLICITLY rather than letting a caller report a release that did not
      // happen. Each refusal is surfaced by name so the route can say what actually went wrong —
      // `batch_belongs_to_earlier_window` in particular needs an operator, not a retry.
      const msg = typeof (error as any).message === 'string' ? (error as any).message : ''
      const refusals: FinalizeRefusal[] = [
        'no_visible_introductions', 'batch_belongs_to_earlier_window', 'batch_not_found',
        'admin_requires_batch_id', 'weekly_forbids_batch_id', 'invalid_source',
      ]
      const matched = refusals.find((r) => msg.includes(r))
      if (matched) return { finalized: false, reason: matched }
      console.error('[batch-release] finalize failed (class):', (error as any).code ?? 'unknown')
      return { finalized: false, reason: 'finalize_failed' }
    }

    const row = Array.isArray(data) ? data[0] : data
    if (!row?.release_key) return { finalized: false, reason: 'finalize_failed' }

    return {
      finalized: true,
      releaseKey: row.release_key,
      releasedAt: row.released_at,
      cardsReleased: row.cards_released ?? 0,
      wasExisting: row.was_existing === true,
    }
  } catch (e: any) {
    console.error('[batch-release] finalize threw (class):', e?.message ? 'exception' : 'unknown')
    return { finalized: false, reason: 'finalize_failed' }
  }
}

/**
 * Has THIS cycle's batch been released? Reads the immutable fact and nothing else — never cards,
 * never batch status, never a timestamp heuristic.
 *
 * Returns null when the read did not answer; the caller must treat null as "not proven" and show
 * the neutral state. The key advances on its own at each Thursday window, so a new week starts with
 * no fact and the banner returns to "being prepared" without anything having to reset state.
 */
export async function getCurrentCycleRelease(admin: any, now: Date = new Date()): Promise<ReleaseRecord | null> {
  const releaseKey = weeklyRunKey(now)
  try {
    const { data, error } = await admin
      .from('weekly_batch_releases')
      .select('release_key, released_at')
      .eq('release_key', releaseKey)
      .eq('source', 'admin_approval')
      .maybeSingle()
    if (error) {
      console.error('[batch-release] read failed (class):', (error as any).code ?? 'unknown')
      return null
    }
    if (!data) return null
    return { releaseKey: data.release_key, releasedAt: data.released_at }
  } catch {
    return null
  }
}

/** The Thursday window key the current cycle is anchored on. */
export function currentCycleKey(now: Date = new Date()): string {
  return weeklyRunKey(now)
}

/** The instant this cycle's window opened. Scopes "arrived this cycle" card evidence. */
export function currentCycleStart(now: Date = new Date()): Date {
  return currentCycleBatch(now)
}
