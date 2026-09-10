/**
 * lib/email/sendPacing.ts — provider-rate pacing for the ONE bulk email path that bursts.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 * On 2026-09-09 the Wednesday reminder stage claimed 102 members and issued their Resend calls 25
 * at a time via Promise.all, with no pacing and no retry. 20 were accepted — all inside the first
 * second — and 81 failed within the next ~2 seconds. Roughly 50 requests/second against a provider
 * that enforces a per-second request limit.
 *
 * ─── SCOPE, DELIBERATELY NARROW ───────────────────────────────────────────────────────────────
 * This is NOT a general email queue and must not become one in this change. Every other bulk path
 * is already sequential (approve-batch, bulk-invite, the onboarding worker, the catch-up route) or
 * already throttled by its own batch-and-pause loop (launch-announcement, referral-campaign,
 * first-matching-reminder). The Wednesday reminder was the only concurrent burst in the codebase,
 * and it is the only caller here.
 *
 * ─── THE RATE IS NOT GUESSED ──────────────────────────────────────────────────────────────────
 * Nothing in this repository recorded a provider rate before this file, so there is no authoritative
 * value to read. Rather than embed one from memory, the rate is an environment variable with a
 * deliberately CONSERVATIVE default: a value that is too low costs wall-clock, while a value that is
 * too high reproduces the outage. It is clamped so a typo cannot restore the burst.
 */

/** Conservative default: safe under the lowest provider tier we might be on. */
export const DEFAULT_SENDS_PER_SECOND = 2

/** A hard ceiling. Even a mistyped env value cannot recreate a 25-wide burst. */
export const MAX_SENDS_PER_SECOND = 20

/** Small and fixed. Concurrency hides per-request latency; the PACER is what bounds the rate. */
export const EMAIL_SEND_CONCURRENCY = 3

/** Retry budget for a single recipient. Bounded so one bad address cannot consume the run. */
export const MAX_SEND_ATTEMPTS = 3

/**
 * Sends per second, from `EMAIL_SENDS_PER_SECOND`.
 *
 * Set this in production to the Resend account's actual documented request rate. Unset, absent or
 * unparseable falls back to the conservative default rather than to "unlimited" — the failure
 * direction matters, and slow is recoverable where a burst is not.
 */
export function emailSendsPerSecond(): number {
  const raw = Number.parseFloat((process.env.EMAIL_SENDS_PER_SECOND ?? '').trim())
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SENDS_PER_SECOND
  return Math.min(MAX_SENDS_PER_SECOND, Math.max(0.5, raw))
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * An evenly-spaced gate shared by every worker.
 *
 * Spacing rather than a bucket-with-burst on purpose: a token bucket would permit its whole
 * allowance instantly, which is exactly the shape that failed. `next` advances by one interval per
 * caller regardless of how many workers are waiting, so N concurrent workers still produce N
 * requests per second in total, not N per worker.
 */
export function createPacer(perSecond: number): () => Promise<void> {
  const intervalMs = 1000 / Math.max(0.5, perSecond)
  let next = 0
  return async () => {
    const now = Date.now()
    const at = Math.max(now, next)
    next = at + intervalMs
    if (at > now) await sleep(at - now)
  }
}

/** Exponential backoff with jitter. Jitter matters: without it, every rate-limited worker retries
 *  in lockstep and re-creates the burst that caused the failure. */
export function backoffMs(attempt: number, baseMs = 500): number {
  return baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * baseMs)
}

export interface PacedRunResult {
  /** Items whose handler actually ran. */
  processed: number
  /** True when the deadline stopped the run before every item was reached. */
  truncated: boolean
}

/**
 * Run `handle` over `items` with bounded concurrency and a shared rate gate, stopping cleanly at
 * `deadlineAt`.
 *
 * THE DEADLINE IS CHECKED BEFORE THE HANDLER, NEVER INSIDE IT. `handle` owns claiming, sending and
 * marking; a run that stops before calling it therefore leaves NO claim behind for a member it never
 * attempted. That is what keeps budget exhaustion from stranding rows.
 */
export async function runPacedSends<T>(
  items: readonly T[],
  opts: {
    perSecond: number
    concurrency: number
    deadlineAt: number
    handle: (item: T) => Promise<void>
    now?: () => number
    pacer?: () => Promise<void>
  },
): Promise<PacedRunResult> {
  const now = opts.now ?? Date.now
  const pace = opts.pacer ?? createPacer(opts.perSecond)
  let cursor = 0
  let processed = 0
  let truncated = false

  const worker = async () => {
    for (;;) {
      if (now() >= opts.deadlineAt) { if (cursor < items.length) truncated = true; return }
      const i = cursor++
      if (i >= items.length) return
      await pace()
      // Re-checked after waiting: the gate may have held this worker past the deadline, and a send
      // started now would run outside the budget the caller sized.
      if (now() >= opts.deadlineAt) { truncated = true; return }
      await opts.handle(items[i])
      processed++
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, opts.concurrency) }, () => worker()),
  )
  return { processed, truncated }
}

/**
 * Seconds needed to send `count` messages at `perSecond`. Used to warn LOUDLY when a run cannot
 * possibly finish inside its budget, so a shortfall is reported rather than discovered next week.
 */
export function estimatedSendSeconds(count: number, perSecond: number): number {
  return count / Math.max(0.5, perSecond)
}
