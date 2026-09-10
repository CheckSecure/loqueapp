/**
 * lib/cron/engagementBudget.ts — the runtime budget of /api/cron/engagement-reminders, in one place.
 *
 * ─── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────────
 * The route runs ten stages. Each stage owned its own budget constant, declared next to its own
 * code, and nothing ever added them up. The result was an invocation that reserved roughly 78
 * seconds of stage budget against a 60-second ceiling — every stage individually "bounded", the
 * whole route not bounded at all — and separately a Wednesday stage that admitted 300 recipients
 * into a 25-second window that could pace at most 50 of them. Both defects are the same defect:
 * a per-stage number chosen in isolation.
 *
 * So the numbers live here, together, and two things are DERIVED rather than chosen:
 *
 *   1. REMINDER_DEADLINE_MS comes from the admitted recipient maximum and the DEFAULT send rate.
 *      The window cannot silently stop fitting the population it admits.
 *   2. routeBudgetMs() adds every stage up. A test asserts the total fits maxDuration.
 *
 * ─── THE CAPACITY INVARIANT ───────────────────────────────────────────────────────────────────
 * At R sends/second a window of D milliseconds attempts at most R·D/1000 recipients. The Wednesday
 * stage runs ONE day a week, so a recipient it cannot reach waits seven days, not until tomorrow.
 * The invariant is therefore stated on the DEFAULT configuration, not on a tuned one:
 *
 *     REMINDER_DEADLINE_MS  >=  (REMINDER_MAX_PER_RUN / DEFAULT_SENDS_PER_SECOND) * 1000
 *
 * EMAIL_SENDS_PER_SECOND stays available for tuning — raising it makes the stage finish sooner,
 * never later. Lowering it below the default trades capacity for caution, and the route logs the
 * resulting shortfall rather than absorbing it. Correctness never depends on setting it.
 */

import { DEFAULT_SENDS_PER_SECOND } from '@/lib/email/sendPacing'

/**
 * The route's wall-clock ceiling, in seconds.
 *
 * 300 is not a guess about the plan: this repository already ships four routes at 300, one of them
 * a cron on the same invocation path (app/api/cron/enrich-companies, plus the two company-enrichment
 * admin routes and companies/repair-registry). A maxDuration above the plan's limit is rejected at
 * deploy time, so main deploying with those routes is the evidence that 300 is available here.
 *
 * This is a CEILING, not a target. The stage budgets below are what actually bound each stage, and
 * a non-Wednesday invocation reserves only routeBudgetMs() - REMINDER_DEADLINE_MS of it.
 */
export const ROUTE_MAX_DURATION_S = 300

/**
 * Reserved for what no stage budget covers: cold start, admin client construction, the unbudgeted
 * reads between stages, and response serialization. Kept out of the stage budgets so a stage cannot
 * quietly spend it.
 */
export const ROUTE_SAFETY_MARGIN_MS = 20_000

// ── Stage budgets, in the order the route runs them ─────────────────────────────────────────────

/**
 * PART 4, "someone is waiting on your response". ENFORCED.
 *
 * This loop had no bound of any kind — not on rows (the query carries no limit), not on time — and
 * it makes two to three database round trips plus a provider call PER ROW, ahead of the Wednesday
 * stage. A backlog here used to be able to consume the whole invocation and leave the weekly
 * reminder unsent. It is a DAILY stage, so a run cut at this budget resumes tomorrow.
 */
export const WAITING_BUDGET_MS = 10_000

/** PART 3, per-batch introduction reminder. ENFORCED, and unbounded for the same reason as PART 4. */
export const INTRO_REMINDER_BUDGET_MS = 10_000

/**
 * The post-batch referral nudge. ACCOUNTED, not enforced: it is bounded by row count inside
 * (`limit` defaults to 200 candidates) and writes notifications rather than calling a provider.
 * It still consumes wall clock, so it is counted here instead of being treated as free.
 */
export const REFERRAL_NUDGE_ALLOWANCE_MS = 5_000

/**
 * PART 5, the Wednesday reminder — how many recipients ONE invocation admits.
 *
 * This is the number the invariant is stated against. Today's eligible population is 102, so 300
 * carries roughly 3x growth headroom; when the population approaches it, the honest move is to
 * raise this AND the ceiling together, which the coherence test forces.
 */
export const REMINDER_MAX_PER_RUN = 300

/**
 * Slack over the pure pacing time, for what pacing does not cover: the claim write and the
 * accept/fail write around each send, and the bounded rate-limit retries (MAX_SEND_ATTEMPTS, with a
 * jittered backoff). Those overlap the pacer across EMAIL_SEND_CONCURRENCY workers and so are
 * normally hidden by it, but a slow database or a burst of 429s must not turn into a truncation.
 */
export const SEND_OVERHEAD_FACTOR = 1.2

/**
 * PART 5's window — DERIVED, never chosen. 300 recipients at the 2/second default is 150 seconds of
 * pacing; the overhead factor makes it 180.
 */
export const REMINDER_DEADLINE_MS = Math.ceil(
  (REMINDER_MAX_PER_RUN / DEFAULT_SENDS_PER_SECOND) * 1000 * SEND_OVERHEAD_FACTOR,
)

/** PART 5b, mutual matches blocked on credits. Unchanged. */
export const CREDIT_RETRY_BUDGET_MS = 8_000

/** PART 6, daily suggested-card expiry. Unchanged. */
export const EXPIRY_BUDGET_MS = 15_000

/** PART 7, durable new-introduction outbox drain. Unchanged. */
export const OUTBOX_STAGE_BUDGET_MS = 12_000

/**
 * PART 8. Owned by lib/onboarding/reminderWorker (REMINDER_STAGE_BUDGET_MS) and mirrored here so the
 * total can be computed without importing that module — it pulls in the Resend client at import
 * time. A test asserts the two numbers have not drifted apart.
 */
export const ONBOARDING_REMINDER_BUDGET_MS = 10_000

/** PART 9. Mirrors RELEASE_STAGE_BUDGET_MS in lib/introductions/capacityRelease; same drift test. */
export const CAPACITY_RELEASE_BUDGET_MS = 8_000

/**
 * PART 10, the seven-year retention purge. ACCOUNTED, not enforced: it is a single bounded DELETE
 * behind one RPC with no loop to cut.
 */
export const LEDGER_PURGE_ALLOWANCE_MS = 5_000

// ── The whole-route view ────────────────────────────────────────────────────────────────────────

/** Every stage budget and allowance, in run order. The sum is what must fit the ceiling. */
export const STAGE_BUDGETS_MS: ReadonlyArray<readonly [string, number]> = [
  ['waiting_response', WAITING_BUDGET_MS],
  ['intro_reminder', INTRO_REMINDER_BUDGET_MS],
  ['referral_nudge', REFERRAL_NUDGE_ALLOWANCE_MS],
  ['wednesday_reminder', REMINDER_DEADLINE_MS],
  ['credit_retry', CREDIT_RETRY_BUDGET_MS],
  ['suggested_expiry', EXPIRY_BUDGET_MS],
  ['intro_outbox', OUTBOX_STAGE_BUDGET_MS],
  ['onboarding_reminders', ONBOARDING_REMINDER_BUDGET_MS],
  ['capacity_release', CAPACITY_RELEASE_BUDGET_MS],
  ['ledger_retention', LEDGER_PURGE_ALLOWANCE_MS],
]

/** Worst case for a WEDNESDAY invocation: every stage spends its whole budget. */
export function routeBudgetMs(): number {
  return STAGE_BUDGETS_MS.reduce((sum, [, ms]) => sum + ms, 0)
}

/** The other six days, when PART 5 does not run at all. */
export function nonWednesdayBudgetMs(): number {
  return routeBudgetMs() - REMINDER_DEADLINE_MS
}

/**
 * Everything reserved for the stages that run AFTER the Wednesday reminder.
 *
 * The Wednesday window is measured from its own start, which keeps an earlier backlog from eating
 * it — but on its own that also means an earlier overrun pushes the whole invocation past the
 * ceiling. The route therefore clamps the window to whatever is left once this tail is set aside,
 * so PART 5 can never strand the expiry, outbox, onboarding, capacity-release or retention stages.
 */
export function tailBudgetAfterWednesdayMs(): number {
  return CREDIT_RETRY_BUDGET_MS + EXPIRY_BUDGET_MS + OUTBOX_STAGE_BUDGET_MS
    + ONBOARDING_REMINDER_BUDGET_MS + CAPACITY_RELEASE_BUDGET_MS + LEDGER_PURGE_ALLOWANCE_MS
}

/**
 * The latest instant the Wednesday stage may still be sending, given when the ROUTE started.
 * `routeStartedAt` is the route's own start, not the stage's.
 */
export function wednesdaySendDeadlineAt(routeStartedAt: number, stageStartedAt: number): number {
  const routeCeiling = routeStartedAt
    + ROUTE_MAX_DURATION_S * 1000 - ROUTE_SAFETY_MARGIN_MS - tailBudgetAfterWednesdayMs()
  return Math.min(stageStartedAt + REMINDER_DEADLINE_MS, routeCeiling)
}

/**
 * How many recipients the Wednesday window can attempt at a given rate. The route computes its
 * shortfall from the REMAINING window rather than the nominal one, so an earlier stage that
 * overruns shows up here as reduced capacity instead of as a silent truncation.
 */
export function reachableAtRate(perSecond: number, windowMs: number = REMINDER_DEADLINE_MS): number {
  return Math.max(0, Math.floor((windowMs / 1000) * perSecond))
}

/**
 * Does the whole route fit its ceiling, with the margin intact? Asserted by the test suite rather
 * than thrown at import: a build that fails to boot is a worse outcome than a red test, and the
 * numbers only ever change by someone editing this file.
 */
export function budgetCoherence(): {
  coherent: boolean
  totalMs: number
  ceilingMs: number
  headroomMs: number
  admitted: number
  reachableAtDefaultRate: number
} {
  const totalMs = routeBudgetMs()
  const ceilingMs = ROUTE_MAX_DURATION_S * 1000
  const reachable = reachableAtRate(DEFAULT_SENDS_PER_SECOND)
  return {
    coherent: totalMs + ROUTE_SAFETY_MARGIN_MS <= ceilingMs && reachable >= REMINDER_MAX_PER_RUN,
    totalMs,
    ceilingMs,
    headroomMs: ceilingMs - ROUTE_SAFETY_MARGIN_MS - totalMs,
    admitted: REMINDER_MAX_PER_RUN,
    reachableAtDefaultRate: reachable,
  }
}
