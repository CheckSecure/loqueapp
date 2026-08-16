/**
 * thursdaySchedule — THE single source of truth for the weekly Thursday introduction batch
 * schedule and its member-facing countdown.
 *
 * Pure & dependency-free (only the built-in Intl API) so it runs identically on the server, in the
 * browser, and under vitest. NOTHING here reads a database, sends anything, or mutates state — it
 * only computes instants from a caller-supplied `now`.
 *
 * HOBBY-PLAN REALITY (honest timing — do NOT claim an exact minute):
 *   The Vercel project is on the Hobby plan, where a cron expression may run at most once per day
 *   and MAY be invoked anywhere within its scheduled hour. The weekly batch is therefore a single
 *   invocation: `0 14 * * 4` (Thursday, the 14:00 UTC hour). In New York that hour is:
 *     • 09:00–09:59 during EST (winter)
 *     • 10:00–10:59 during EDT (summer)
 *   Because the schedule is a fixed UTC hour, the countdown TARGET is the real UTC window start
 *   (Thursday 14:00 UTC) — never an imaginary fixed 9:00 AM New York wall-clock. We keep the target
 *   pinned to this Thursday throughout the whole [14:00, 15:00) UTC invocation window (so we never
 *   claim the batch already ran while Vercel might still be about to invoke it), then roll forward
 *   to the following Thursday once that window has fully passed.
 *
 * There is exactly ONE weekly invocation, so no NY-hour execution guard exists and no exactly-once
 * claim is made — the route relies on this single invocation plus the existing idempotent generation
 * protections. See app/api/cron/weekly-refresh/route.ts.
 */

export const NY_TZ = 'America/New_York'
/** The batch cron fires in the 14:00 UTC hour on Thursday (`0 14 * * 4`). */
export const CRON_HOUR_UTC = 14
/** Thursday. Date.getUTCDay(): Sun=0 … Thu=4 … Sat=6. */
export const THURSDAY = 4
const MS_PER_DAY = 24 * 60 * 60 * 1000
/** Vercel Hobby may invoke anywhere within the scheduled hour → the window is [14:00, 15:00) UTC. */
export const INVOCATION_WINDOW_MS = 60 * 60 * 1000

/** NY calendar/clock parts for an absolute instant (DST-correct via Intl) — used only to DESCRIBE
 *  the honest local timing (EST 09:xx / EDT 10:xx); the schedule itself is pure UTC. */
export interface NyParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number // Sun=0 … Sat=6
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

export function nyParts(date: Date): NyParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  })
  const m: Record<string, string> = {}
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value
  let hour = parseInt(m.hour, 10)
  if (hour === 24) hour = 0 // Intl can emit "24" for midnight under hour12:false
  return {
    year: parseInt(m.year, 10),
    month: parseInt(m.month, 10),
    day: parseInt(m.day, 10),
    hour,
    minute: parseInt(m.minute, 10),
    second: parseInt(m.second, 10),
    weekday: WEEKDAY_INDEX[m.weekday] ?? date.getUTCDay(),
  }
}

/** Offset of America/New_York at `date`, in minutes (EDT = -240, EST = -300). Descriptive only. */
export function nyOffsetMinutes(date: Date): number {
  const p = nyParts(date)
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asUTC - date.getTime()) / 60000)
}

/**
 * The next Thursday 14:00 UTC batch window relevant to `now`. Stays pinned to THIS Thursday for the
 * whole [14:00, 15:00) UTC invocation window (Hobby imprecision), then rolls to next Thursday. The
 * result is an absolute UTC instant, safe to serialize/compare regardless of viewer timezone.
 */
export function nextBatch(now: Date): Date {
  const base = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), CRON_HOUR_UTC, 0, 0,
  ))
  const daysUntilThu = (THURSDAY - base.getUTCDay() + 7) % 7
  let thu = new Date(base.getTime() + daysUntilThu * MS_PER_DAY)
  // Roll forward only AFTER the invocation window ends, so the countdown never jumps to next week
  // while Vercel might still invoke this Thursday's run.
  if (now.getTime() >= thu.getTime() + INVOCATION_WINDOW_MS) {
    thu = new Date(thu.getTime() + 7 * MS_PER_DAY)
  }
  return thu
}

/**
 * The most recent Thursday 14:00 UTC batch window START at or before `now` (the current cycle's
 * anchor). Used for the "arrived this cycle" evidence window and the log label. NOTE this is computed
 * directly (Thursday 14:00 on-or-before now), NOT as nextBatch − 7d, so that DURING the live
 * [14:00,15:00) invocation window it correctly points at TODAY's window rather than last week's.
 */
export function currentCycleBatch(now: Date): Date {
  const base = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), CRON_HOUR_UTC, 0, 0,
  ))
  const daysSinceThu = (base.getUTCDay() - THURSDAY + 7) % 7
  let thu = new Date(base.getTime() - daysSinceThu * MS_PER_DAY)
  if (thu.getTime() > now.getTime()) thu = new Date(thu.getTime() - 7 * MS_PER_DAY)
  return thu
}

export interface CountdownState {
  /** Milliseconds until the next batch window, clamped to ≥ 0 (never negative). */
  totalMs: number
  days: number
  hours: number
  minutes: number
  seconds: number
  /** True while there is still time on the clock (totalMs > 0). */
  pending: boolean
  /** Absolute target instant (ISO) — safe to hand to the client for live recompute. */
  targetIso: string
}

/** Countdown from `now` to the next Thursday batch window. Clamped so it can never go negative. */
export function countdownState(now: Date, target?: Date): CountdownState {
  const t = target ?? nextBatch(now)
  const raw = t.getTime() - now.getTime()
  const totalMs = raw > 0 ? raw : 0
  let rem = Math.floor(totalMs / 1000)
  const days = Math.floor(rem / 86400); rem -= days * 86400
  const hours = Math.floor(rem / 3600); rem -= hours * 3600
  const minutes = Math.floor(rem / 60); rem -= minutes * 60
  const seconds = rem
  return { totalMs, days, hours, minutes, seconds, pending: totalMs > 0, targetIso: t.toISOString() }
}

/**
 * Human countdown copy, e.g. "2 days, 14 hours remaining" / "3 hours, 5 minutes remaining" /
 * "Less than a minute remaining". Shows the two most-significant non-trivial units. At/after the
 * target it returns the arrival phrase (never a negative or empty string).
 */
export function formatCountdown(state: CountdownState): string {
  if (state.totalMs <= 0) return 'Arriving shortly'
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  const { days, hours, minutes } = state
  let parts: string[]
  if (days > 0) parts = [unit(days, 'day'), unit(hours, 'hour')]
  else if (hours > 0) parts = [unit(hours, 'hour'), unit(minutes, 'minute')]
  else if (minutes > 0) parts = [unit(minutes, 'minute')]
  else return 'Less than a minute remaining'
  return `${parts.join(', ')} remaining`
}

/**
 * Non-authoritative per-week LOG LABEL: `thu-YYYY-MM-DD` (UTC) of the cycle's Thursday. Handy for
 * correlating a run's logs; it is NOT a durable claim/lease and does NOT guarantee exactly-once
 * execution. Stable within a cycle, distinct week to week.
 */
export function weeklyRunKey(now: Date): string {
  const batch = currentCycleBatch(now)
  const y = batch.getUTCFullYear()
  const mm = String(batch.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(batch.getUTCDate()).padStart(2, '0')
  return `thu-${y}-${mm}-${dd}`
}
