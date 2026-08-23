/**
 * Bounded daily capacity-release stage.
 *
 * WHAT IT DOES. Frees a member's own hidden card from their visible capacity 72 hours after they
 * expressed interest in it. Nothing else: the card stays live and answerable, its status is never
 * written, and the counterparty's visible card is never touched.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It sends no email and creates no notification. A release is an
 * internal accounting change — the member already knows they expressed interest, and telling them
 * "you can now receive more introductions" would be noise at best. The replacement cards announce
 * themselves through the existing outbox when they are placed.
 *
 * ─── DEFAULT OFF ──────────────────────────────────────────────────────────────────────────────
 * CAPACITY_RELEASE_MODE gates it, and anything except 'on' means no row is ever written. 'dry_run'
 * reports what WOULD be released and changes nothing, so the first production run can be inspected
 * before a single card moves. This mirrors the invitation rollout gate rather than inventing a new
 * pattern.
 */

import { createAdminClient } from '@/lib/supabase/admin'

export type CapacityReleaseMode = 'off' | 'dry_run' | 'on'

/** Unset / empty / unknown → 'off'. Fail safe, never fail open. */
export function capacityReleaseMode(): CapacityReleaseMode {
  const raw = (process.env.CAPACITY_RELEASE_MODE || '').trim().toLowerCase()
  if (raw === 'on') return 'on'
  if (raw === 'dry_run') return 'dry_run'
  return 'off'
}

/** Hours a hidden card keeps consuming its author's capacity after they expressed interest. */
export const RELEASE_WAIT_HOURS = 72

export const RELEASE_STAGE_BUDGET_MS = 8_000
const MAX_PER_RUN = 200
const SCAN_LIMIT = 500

export interface ReleaseRunResult {
  mode: CapacityReleaseMode
  ran: boolean
  candidates: number
  released: number
  skipped: number
  failed: number
  truncated: boolean
  errorClass?: string
}

/**
 * Scan for correlated, aged, still-hidden rows and release them one at a time.
 *
 * The scan is a hint, not a decision. Every condition is re-derived inside
 * release_intro_capacity() under both members' advisory locks, so a pass, expiry, match or
 * placement landing between the scan and the call simply makes that call return false.
 */
export async function runCapacityReleaseStage(
  admin: any,
  opts: { budgetMs?: number; mode?: CapacityReleaseMode } = {},
): Promise<ReleaseRunResult> {
  const mode = opts.mode ?? capacityReleaseMode()
  const deadline = Date.now() + (opts.budgetMs ?? RELEASE_STAGE_BUDGET_MS)
  const empty: ReleaseRunResult = {
    mode, ran: false, candidates: 0, released: 0, skipped: 0, failed: 0, truncated: false,
  }
  if (mode === 'off') return empty

  const cutoff = new Date(Date.now() - RELEASE_WAIT_HOURS * 3600_000).toISOString()

  // Candidates: a live, paired, unreleased suggested row whose OWN author expressed interest in it
  // — identified through responds_to_id, never through a timestamp — at least 72h ago.
  //
  // The inner select is the correlation. A row with no responds_to_id pointing at it (every pre-080
  // row, and every legacy pairless row) is invisible here, which is exactly the intent: nothing is
  // backfilled and nothing is inferred.
  const { data: expressions, error: exErr } = await admin
    .from('intro_requests')
    .select('responds_to_id')
    .not('responds_to_id', 'is', null)
    .in('status', ['pending', 'approved', 'accepted', 'accepted_pending_payment', 'admin_pending'])
    .lte('created_at', cutoff)
    .limit(SCAN_LIMIT)
  if (exErr) return { ...empty, ran: true, errorClass: 'scan_failed' }

  const ids = Array.from(new Set((expressions ?? []).map((r: any) => r.responds_to_id).filter(Boolean)))
  if (ids.length === 0) return { ...empty, ran: true }

  const { data: cards, error: cardErr } = await admin
    .from('intro_requests')
    .select('id')
    .in('id', ids)
    .eq('status', 'suggested')
    .is('capacity_released_at', null)
    .not('pair_id', 'is', null)
  if (cardErr) return { ...empty, ran: true, errorClass: 'scan_failed' }

  const candidates: string[] = (cards ?? []).map((r: any) => r.id)

  // DRY RUN stops here. It has read only, and reports what a real run would have done.
  if (mode === 'dry_run') {
    return { ...empty, ran: true, candidates: candidates.length }
  }

  let released = 0, skipped = 0, failed = 0, truncated = false
  for (const id of candidates) {
    if (Date.now() > deadline || released >= MAX_PER_RUN) { truncated = true; break }
    const { data, error } = await admin.rpc('release_intro_capacity', {
      p_intro_request_id: id, p_min_wait_hours: RELEASE_WAIT_HOURS,
    })
    if (error) { failed++; continue }
    if (data === true) released++
    else skipped++     // a race resolved it first; not an error
  }

  return { mode, ran: true, candidates: candidates.length, released, skipped, failed, truncated }
}

/** Never log or return a member identifier; the caller reports aggregates only. */
export function summarize(r: ReleaseRunResult): string {
  return `${r.mode} candidates=${r.candidates} released=${r.released} skipped=${r.skipped} failed=${r.failed}`
}
