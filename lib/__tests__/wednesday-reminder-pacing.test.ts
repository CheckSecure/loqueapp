import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  emailSendsPerSecond, createPacer, backoffMs, runPacedSends, estimatedSendSeconds,
  DEFAULT_SENDS_PER_SECOND, MAX_SENDS_PER_SECOND, EMAIL_SEND_CONCURRENCY, MAX_SEND_ATTEMPTS,
} from '@/lib/email/sendPacing'
import { classifyResendError, EmailSendError } from '@/lib/email/sendErrors'
import {
  ROUTE_MAX_DURATION_S, ROUTE_SAFETY_MARGIN_MS, REMINDER_MAX_PER_RUN, REMINDER_DEADLINE_MS,
  SEND_OVERHEAD_FACTOR, STAGE_BUDGETS_MS, routeBudgetMs, nonWednesdayBudgetMs,
  tailBudgetAfterWednesdayMs, wednesdaySendDeadlineAt, reachableAtRate, budgetCoherence,
  WAITING_BUDGET_MS, INTRO_REMINDER_BUDGET_MS,
  ONBOARDING_REMINDER_BUDGET_MS, CAPACITY_RELEASE_BUDGET_MS,
} from '@/lib/cron/engagementBudget'

/**
 * WEDNESDAY REMINDER PACING — the 2026-09-09 outage.
 *
 * 102 members were claimed, their Resend calls were issued 25 at a time via Promise.all, 20 were
 * accepted inside the first second and 81 failed over the next two. The burst was the defect. The
 * error was then discarded and every outcome persisted as the literal 'provider_error', which is why
 * the ledger could not say whether it was a rate limit.
 *
 * These tests pin both halves: the send rate, and the ability to tell what happened.
 */

const ROUTE = readFileSync('app/api/cron/engagement-reminders/route.ts', 'utf8')
const EMAIL = readFileSync('lib/email.ts', 'utf8')
const TARGETED = readFileSync('app/api/admin/reminders/wednesday-targeted/route.ts', 'utf8')
const CATCHUP = readFileSync('app/api/admin/reminders/unanswered-intros-catchup/route.ts', 'utf8')
const APPROVE = readFileSync('app/api/admin/approve-batch/route.ts', 'utf8')
const SEND_ERRORS = readFileSync('lib/email/sendErrors.ts', 'utf8')
const BUDGET = readFileSync('lib/cron/engagementBudget.ts', 'utf8')

// ═══ 1. THE BURST IS GONE ═════════════════════════════════════════════════════════════════════
describe('1. the 25-wide burst no longer exists', () => {
  it('the route no longer declares or uses a concurrency of 25', () => {
    expect(ROUTE).not.toMatch(/REMINDER_SEND_CONCURRENCY\s*=\s*25/)
    // and no Promise.all over a chunk of recipients
    expect(ROUTE).not.toMatch(/Promise\.all\(chunk\.map/)
  })

  it('sends go through the paced runner at a small fixed concurrency', () => {
    expect(ROUTE).toMatch(/await runPacedSends\(recipients, \{/)
    expect(ROUTE).toMatch(/concurrency: EMAIL_SEND_CONCURRENCY/)
    expect(EMAIL_SEND_CONCURRENCY).toBeLessThanOrEqual(5)
  })

  it('runPacedSends never exceeds its configured concurrency', async () => {
    let inFlight = 0
    let peak = 0
    await runPacedSends(Array.from({ length: 40 }, (_, i) => i), {
      perSecond: 1000, concurrency: 3, deadlineAt: Date.now() + 10_000,
      handle: async () => {
        inFlight++; peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 1))
        inFlight--
      },
    })
    expect(peak).toBeLessThanOrEqual(3)
  })
})

// ═══ 2. PACING IS RESPECTED ═══════════════════════════════════════════════════════════════════
describe('2. the configured provider rate is respected', () => {
  it('the pacer spaces calls evenly regardless of how many workers wait on it', async () => {
    const pace = createPacer(100)   // 10 ms apart
    const t0 = Date.now()
    await Promise.all(Array.from({ length: 5 }, () => pace()))
    // 5 slots at 10 ms each: the last cannot resolve before ~40 ms.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35)
  })

  it('the rate is environment-controlled with a conservative default and a hard ceiling', () => {
    const prev = process.env.EMAIL_SENDS_PER_SECOND
    try {
      delete process.env.EMAIL_SENDS_PER_SECOND
      expect(emailSendsPerSecond()).toBe(DEFAULT_SENDS_PER_SECOND)
      process.env.EMAIL_SENDS_PER_SECOND = 'not-a-number'
      expect(emailSendsPerSecond()).toBe(DEFAULT_SENDS_PER_SECOND)
      process.env.EMAIL_SENDS_PER_SECOND = '0'
      expect(emailSendsPerSecond()).toBe(DEFAULT_SENDS_PER_SECOND)
      process.env.EMAIL_SENDS_PER_SECOND = '5'
      expect(emailSendsPerSecond()).toBe(5)
      // A typo cannot restore the burst.
      process.env.EMAIL_SENDS_PER_SECOND = '9999'
      expect(emailSendsPerSecond()).toBe(MAX_SENDS_PER_SECOND)
      expect(MAX_SENDS_PER_SECOND).toBeLessThan(25)
    } finally {
      if (prev === undefined) delete process.env.EMAIL_SENDS_PER_SECOND
      else process.env.EMAIL_SENDS_PER_SECOND = prev
    }
  })

  it('the default is well below the ~50/second that failed in production', () => {
    expect(DEFAULT_SENDS_PER_SECOND).toBeLessThanOrEqual(2)
  })
})

// ═══ 3. ELIGIBILITY IS UNCHANGED ══════════════════════════════════════════════════════════════
describe('3. who receives a reminder did not change', () => {
  it('the eligibility predicate and its inputs are untouched', () => {
    expect(ROUTE).toMatch(/const reason = reminderIneligibility\(p, openCount\)/)
    expect(ROUTE).toMatch(/REMINDER_PURPOSE/)
    expect(ROUTE).toMatch(/newYorkIsoWeekKey\(new Date\(now\)\)/)
    expect(ROUTE).toMatch(/isWednesdayInNewYork\(new Date\(now\)\)/)
    // Same cap, same page size — the recipient SET is built exactly as before.
    expect(BUDGET).toMatch(/REMINDER_MAX_PER_RUN = 300/)
    expect(ROUTE).toMatch(/candidates\.slice\(0, REMINDER_MAX_PER_RUN\)/)
  })

  it('the pacing change touches sending only, never selection', () => {
    const stage = ROUTE.slice(ROUTE.indexOf('PACED SENDING'), ROUTE.indexOf('if (paced.truncated)'))
    expect(stage).not.toMatch(/reminderIneligibility|openCardsFor|candidates\s*=/)
  })
})

// ═══ 4-5. CLASSIFICATION ══════════════════════════════════════════════════════════════════════
describe('4-5. provider failures are classified, not collapsed', () => {
  it('a 429 is rate_limited, by status or by wording', () => {
    expect(classifyResendError({ statusCode: 429, message: 'Too many requests' })).toBe('rate_limited')
    expect(classifyResendError({ statusCode: 429, message: '' })).toBe('rate_limited')
    expect(classifyResendError({ name: 'rate_limit_exceeded', message: 'slow down' })).toBe('rate_limited')
    expect(classifyResendError({ message: 'Rate limit exceeded' })).toBe('rate_limited')
  })

  it('a permanent rejection is provider_error', () => {
    expect(classifyResendError({ statusCode: 422, message: 'Invalid `to` field' })).toBe('provider_error')
    expect(classifyResendError({ statusCode: 403, message: 'domain not verified' })).toBe('provider_error')
    expect(classifyResendError({})).toBe('provider_error')
  })

  it('the sender no longer throws a bare provider_error after discarding the error', () => {
    expect(EMAIL).not.toMatch(/if \(\(res as any\)\?\.error\) throw new Error\('provider_error'\)/)
    const wed = EMAIL.slice(EMAIL.indexOf('export async function sendWednesdayIntroReminderEmail'))
    expect(wed).toMatch(/classifyResendError\(res\.error\)/)
    expect(wed).toMatch(/throw new EmailSendError\(errorClass\)/)
    expect(new EmailSendError('rate_limited').errorClass).toBe('rate_limited')
  })

  it('only a rate limit is retried; a permanent failure is not', () => {
    const stage = ROUTE.slice(ROUTE.indexOf('PACED SENDING'), ROUTE.indexOf('if (paced.truncated)'))
    expect(stage).toMatch(/errorClass === 'rate_limited'/)
    expect(stage).toMatch(/attempt < MAX_SEND_ATTEMPTS/)
    expect(MAX_SEND_ATTEMPTS).toBeGreaterThanOrEqual(2)
    expect(MAX_SEND_ATTEMPTS).toBeLessThanOrEqual(5)
  })
})

// ═══ 6. BACKOFF ═══════════════════════════════════════════════════════════════════════════════
describe('6. retry backs off exponentially with jitter', () => {
  it('grows with the attempt number', () => {
    const a1 = Array.from({ length: 30 }, () => backoffMs(1))
    const a3 = Array.from({ length: 30 }, () => backoffMs(3))
    expect(Math.min(...a3)).toBeGreaterThan(Math.max(...a1))
  })

  it('is jittered, so rate-limited workers do not retry in lockstep', () => {
    const s = new Set(Array.from({ length: 40 }, () => backoffMs(2)))
    expect(s.size).toBeGreaterThan(1)
  })

  it('the retry waits before continuing, inside the stage budget', () => {
    const stage = ROUTE.slice(ROUTE.indexOf('PACED SENDING'), ROUTE.indexOf('if (paced.truncated)'))
    expect(stage).toMatch(/const delay = backoffMs\(attempt\)/)
    expect(stage).toMatch(/Date\.now\(\) \+ delay < sendDeadlineAt/)
    expect(stage).toMatch(/await sleep\(delay\); continue/)
  })
})

// ═══ 7-9. IDEMPOTENCY ═════════════════════════════════════════════════════════════════════════
describe('7-9. the durable model is unchanged', () => {
  it('an in-run retry reuses the SAME claim and never re-claims', () => {
    const stage = ROUTE.slice(ROUTE.indexOf('PACED SENDING'), ROUTE.indexOf('if (paced.truncated)'))
    // exactly one claim per handler…
    expect(stage.match(/claimReminder\(/g) ?? []).toHaveLength(1)
    // …and the retry loop is INSIDE the claim, not around it.
    expect(stage.indexOf('claimReminder(')).toBeLessThan(stage.indexOf('for (let attempt = 1'))
    expect(stage).toMatch(/markAccepted\(admin, claim\.deliveryId/)
    expect(stage).toMatch(/markFailed\(admin, claim\.deliveryId, errorClass\)/)
  })

  it('an accepted reminder is still blocked by the active-claim index', () => {
    const ledger = readFileSync('lib/reminders/deliveryLedger.ts', 'utf8')
    expect(ledger).toMatch(/\.eq\('status', 'claimed'\)\s*\/\/ never steals 'accepted'/)
    expect(ledger).toMatch(/\.lt\('claimed_at', staleBefore\)/)
  })

  it('a failed row stays retryable — the class written is the real one', () => {
    expect(ROUTE).not.toMatch(/markFailed\(admin, claim\.deliveryId, 'provider_error'\)/)
    expect(ROUTE).toMatch(/markFailed\(admin, claim\.deliveryId, errorClass\)/)
  })
})

// ═══ 10. UNCERTAIN OUTCOMES ═══════════════════════════════════════════════════════════════════
describe('10. an uncertain send is never recorded as failed', () => {
  it('a thrown request classifies uncertain and leaves the claim standing', () => {
    const wed = EMAIL.slice(EMAIL.indexOf('export async function sendWednesdayIntroReminderEmail'))
    expect(wed).toMatch(/catch \(e: any\) \{[\s\S]{0,200}new EmailSendError\('uncertain'\)/)
    const stage = ROUTE.slice(ROUTE.indexOf('PACED SENDING'), ROUTE.indexOf('if (paced.truncated)'))
    expect(stage).toMatch(/if \(errorClass === 'uncertain'\) \{ wedUncertain\+\+; return \}/)
    // and that branch returns BEFORE markFailed can run
    expect(stage.indexOf("errorClass === 'uncertain'"))
      .toBeLessThan(stage.indexOf('markFailed(admin, claim.deliveryId, errorClass)'))
  })
})

// ═══ 11. BUDGET EXHAUSTION ════════════════════════════════════════════════════════════════════
describe('11. budget exhaustion is safe and loud', () => {
  it('stops before the handler, so no claim is made for an unattempted member', async () => {
    const handled: number[] = []
    const res = await runPacedSends([1, 2, 3, 4, 5], {
      perSecond: 1000, concurrency: 1, deadlineAt: Date.now() - 1,   // already past
      handle: async (n) => { handled.push(n) },
    })
    expect(handled).toEqual([])          // ← nothing claimed, nothing attempted
    expect(res.processed).toBe(0)
    expect(res.truncated).toBe(true)
  })

  it('reports truncation rather than swallowing it', async () => {
    const res = await runPacedSends([1, 2, 3], {
      perSecond: 1000, concurrency: 1, deadlineAt: Date.now() + 10_000,
      handle: async () => {},
    })
    expect(res).toEqual({ processed: 3, truncated: false })
  })

  it('a shortfall at the configured rate is computed BEFORE sending and logged as an error', () => {
    expect(ROUTE).toMatch(/const capacityAtRate = reachableAtRate\(sendsPerSecond, windowMs\)/)
    expect(ROUTE).toMatch(/console\.error\('\[engagement-reminders\] wednesday capacity shortfall'/)
    // The remedy named depends on WHICH way the invariant was broken — a rate tuned below the
    // default the budget is sized for, or an earlier stage overrunning into the clamped window.
    expect(ROUTE).toMatch(/EMAIL_SENDS_PER_SECOND is below the default the budget is sized for/)
    expect(ROUTE).toMatch(/an earlier stage overran/)
    // and it is surfaced in the response too, not only in a log
    expect(ROUTE).toMatch(/shortfall: wedShortfall/)
  })

  it('estimatedSendSeconds is the arithmetic the warning uses', () => {
    expect(estimatedSendSeconds(102, 2)).toBe(51)
    expect(estimatedSendSeconds(102, 10)).toBeCloseTo(10.2, 5)
  })
})

// ═══ 12-13. THE TWO ADMIN CALLERS ═════════════════════════════════════════════════════════════
describe('12-13. both admin reminder callers persist the real class', () => {
  it.each([
    ['wednesday-targeted', TARGETED],
    ['unanswered-intros-catchup', CATCHUP],
  ])('%s no longer hardcodes provider_error', (_name, src) => {
    expect(src).not.toMatch(/markFailed\(admin, claim\.deliveryId, 'provider_error'\)/)
    expect(src).toMatch(/const errorClass: string = e\?\.errorClass \?\? 'provider_error'/)
    expect(src).toMatch(/markFailed\(admin, claim\.deliveryId, errorClass\)/)
    expect(src).toMatch(/errorClass === 'uncertain'/)
  })
})

// ═══ 14. sendNewIntroductionsEmail ════════════════════════════════════════════════════════════
describe('14. the same helper-level defect in sendNewIntroductionsEmail is fixed', () => {
  it('classifies and logs instead of discarding the provider error', () => {
    const fn = EMAIL.slice(EMAIL.indexOf('export async function sendNewIntroductionsEmail'))
    expect(fn).toMatch(/classifyResendError\(\(res as any\)\.error\)/)
    expect(fn).toMatch(/logSendFailure\('sendNewIntroductionsEmail'/)
    expect(fn).toMatch(/throw new EmailSendError\(errorClass\)/)
  })

  it('recipients, preference gate and copy are untouched', () => {
    const fn = EMAIL.slice(EMAIL.indexOf('export async function sendNewIntroductionsEmail'))
    expect(fn).toMatch(/isPrefEnabled\(toEmail, 'email_new_introductions'\)/)
    expect(fn).toMatch(/buildNewIntroductionsEmail\(firstName\)/)
  })
})

// ═══ 15. APPROVE-BATCH ════════════════════════════════════════════════════════════════════════
describe('15. approve-batch stays sequential and idempotent', () => {
  it('still a sequential for-loop with no concurrency added', () => {
    expect(APPROVE).toMatch(/for \(const p of placed\) \{/)
    expect(APPROVE).not.toMatch(/Promise\.all\(placed/)
    expect(APPROVE).not.toMatch(/runPacedSends/)
    expect(APPROVE).toMatch(/await notifyAdminBatchReady\(/)
  })

  it('gains only an explicit runtime ceiling', () => {
    expect(APPROVE).toMatch(/export const maxDuration = 60/)
  })

  it('the dedupe that makes a re-run safe is untouched', () => {
    const eng = readFileSync('lib/notifications/engagement.ts', 'utf8')
    expect(eng).toMatch(/dedupeKey: `batch:\$\{batchId\}`/)
    expect(eng).toMatch(/dedupeKey: `queuedwaiting:\$\{queuedBatchId\}`/)
  })
})

// ═══ LOGGING HYGIENE ══════════════════════════════════════════════════════════════════════════
describe('failure logging is diagnostic without being sensitive', () => {
  it('logs class, status, name and a truncated message — and nothing else', () => {
    const fn = SEND_ERRORS.slice(SEND_ERRORS.indexOf('export function logSendFailure'))
    expect(fn).toMatch(/class: errorClass/)
    expect(fn).toMatch(/status: error\?\.statusCode \?\? error\?\.status \?\? null/)
    expect(fn).toMatch(/name: error\?\.name \?\? null/)
    expect(fn).toMatch(/message.*slice\(0, 200\)/)
    // never the recipient, the body, or the key
    expect(fn).not.toMatch(/toEmail|built\.html|built\.text|RESEND_API_KEY|payload/)
  })

  it('the route no longer swallows the error with a bare catch', () => {
    const stage = ROUTE.slice(ROUTE.indexOf('PACED SENDING'), ROUTE.indexOf('if (paced.truncated)'))
    expect(stage).not.toMatch(/\} catch \{/)
    expect(stage).toMatch(/\} catch \(e: any\) \{/)
  })
})

// ═══ RUNTIME ══════════════════════════════════════════════════════════════════════════════════
describe('the route declares a runtime ceiling it previously lacked', () => {
  it('engagement-reminders sets maxDuration from the shared budget table', () => {
    expect(ROUTE).toMatch(/export const maxDuration = ROUTE_MAX_DURATION_S/)
    expect(ROUTE_MAX_DURATION_S).toBe(300)
  })

  it('the Wednesday stage budget still bounds the stage', () => {
    expect(ROUTE).toMatch(/deadlineAt: sendDeadlineAt/)
    expect(ROUTE).toMatch(/const sendDeadlineAt = wednesdaySendDeadlineAt\(startedAt, wedStartedAt\)/)
  })
})

// ═══ THE CAPACITY INVARIANT ═══════════════════════════════════════════════════════════════════
//
// The pacing fix traded burst for wall clock, and the first version of that trade left the route
// admitting 300 recipients into a 25-second window that could pace 50 — correct in every mechanism
// and wrong in the only number that decides whether a member gets their email. These tests pin the
// arithmetic, not the mechanism.
describe('the DEFAULT configuration can service every recipient the route admits', () => {
  it('the send window is DERIVED from the admitted maximum and the default rate', () => {
    // Not a chosen constant. If either input changes, the window changes with it.
    expect(BUDGET).toMatch(
      /REMINDER_DEADLINE_MS = Math\.ceil\(\s*\(REMINDER_MAX_PER_RUN \/ DEFAULT_SENDS_PER_SECOND\) \* 1000 \* SEND_OVERHEAD_FACTOR,?\s*\)/,
    )
    expect(REMINDER_DEADLINE_MS).toBe(
      Math.ceil((REMINDER_MAX_PER_RUN / DEFAULT_SENDS_PER_SECOND) * 1000 * SEND_OVERHEAD_FACTOR),
    )
  })

  it('THE INVARIANT: the window covers the admitted maximum at the default rate', () => {
    expect(reachableAtRate(DEFAULT_SENDS_PER_SECOND)).toBeGreaterThanOrEqual(REMINDER_MAX_PER_RUN)
    expect(budgetCoherence().coherent).toBe(true)
  })

  it.each([
    ['last Wednesday', 102],
    ['double that', 200],
    ['the admitted maximum', REMINDER_MAX_PER_RUN],
  ])('%s (%i recipients) fits the default window', (_label, n) => {
    // Pure pacing time, before any overhead allowance.
    expect(estimatedSendSeconds(n as number, DEFAULT_SENDS_PER_SECOND) * 1000).toBeLessThanOrEqual(REMINDER_DEADLINE_MS)
    expect(n as number).toBeLessThanOrEqual(reachableAtRate(DEFAULT_SENDS_PER_SECOND))
  })

  it('102 recipients — the population that actually failed — needs 51s and has 180s', () => {
    expect(estimatedSendSeconds(102, DEFAULT_SENDS_PER_SECOND)).toBeCloseTo(51, 5)
    expect(REMINDER_DEADLINE_MS / 1000).toBe(180)
  })

  it('the admitted maximum is a real cap, and the route still enforces it', () => {
    expect(ROUTE).toMatch(/candidates\.slice\(0, REMINDER_MAX_PER_RUN\)/)
    expect(ROUTE).toMatch(/if \(candidates\.length > REMINDER_MAX_PER_RUN\) wedTruncated = true/)
  })

  it('a rate ABOVE the default only ever finishes sooner', () => {
    expect(reachableAtRate(5)).toBeGreaterThan(reachableAtRate(DEFAULT_SENDS_PER_SECOND))
    // ...so no environment variable is needed to make the default correct.
    expect(reachableAtRate(DEFAULT_SENDS_PER_SECOND)).toBeGreaterThanOrEqual(REMINDER_MAX_PER_RUN)
  })

  it('a rate BELOW the default reduces capacity — and that is reported, not absorbed', () => {
    expect(reachableAtRate(0.5)).toBeLessThan(REMINDER_MAX_PER_RUN)
    expect(ROUTE).toMatch(/wedShortfall = recipients\.length - capacityAtRate/)
    expect(ROUTE).toMatch(/shortfall: wedShortfall/)
  })

  it('no admitted recipient is skipped by the pacing deadline under the default config', async () => {
    // Behavioural: the runner processes the whole admitted set when the window is the real one.
    const seen: number[] = []
    const res = await runPacedSends(Array.from({ length: REMINDER_MAX_PER_RUN }, (_, i) => i), {
      perSecond: 1000, concurrency: EMAIL_SEND_CONCURRENCY,
      deadlineAt: Date.now() + REMINDER_DEADLINE_MS,
      handle: async (i) => { seen.push(i) },
    })
    expect(res).toEqual({ processed: REMINDER_MAX_PER_RUN, truncated: false })
    expect(seen).toHaveLength(REMINDER_MAX_PER_RUN)
  })
})

describe('the WHOLE route fits its ceiling, not just the Wednesday stage', () => {
  it('every stage budget is accounted for in one table', () => {
    const names = STAGE_BUDGETS_MS.map(([n]) => n)
    expect(names).toEqual([
      'waiting_response', 'intro_reminder', 'referral_nudge', 'wednesday_reminder',
      'credit_retry', 'suggested_expiry', 'intro_outbox',
      'onboarding_reminders', 'capacity_release', 'ledger_retention',
    ])
    // One entry per PART the route actually runs.
    for (const part of ['PART 4', 'PART 3', 'PART 5:', 'PART 5b', 'PART 6', 'PART 7', 'PART 8', 'PART 9', 'PART 10']) {
      expect(ROUTE).toContain(part)
    }
  })

  it('the worst-case Wednesday invocation fits maxDuration with the margin intact', () => {
    const c = budgetCoherence()
    expect(c.totalMs + ROUTE_SAFETY_MARGIN_MS).toBeLessThanOrEqual(c.ceilingMs)
    expect(c.headroomMs).toBeGreaterThan(0)
    expect(routeBudgetMs()).toBe(263_000)
  })

  it('the other six days reserve far less', () => {
    expect(nonWednesdayBudgetMs()).toBe(routeBudgetMs() - REMINDER_DEADLINE_MS)
    expect(nonWednesdayBudgetMs()).toBeLessThan(ROUTE_MAX_DURATION_S * 1000)
  })

  it('the two stages that had NO bound at all are now bounded in time', () => {
    // Neither query carries a limit, and each row costs multiple round trips plus a provider call.
    expect(ROUTE).toMatch(/if \(Date\.now\(\) - waitingStartedAt > WAITING_BUDGET_MS\) \{ waitingTruncated = true; break \}/)
    expect(ROUTE).toMatch(/if \(Date\.now\(\) - introReminderStartedAt > INTRO_REMINDER_BUDGET_MS\) \{ reminderTruncated = true; break \}/)
    // ...and a cut is reported rather than inferred from a count.
    expect(ROUTE).toMatch(/waitingTruncated,/)
    expect(ROUTE).toMatch(/reminderTruncated \}\)/)
    expect(WAITING_BUDGET_MS).toBeGreaterThan(0)
    expect(INTRO_REMINDER_BUDGET_MS).toBeGreaterThan(0)
  })

  it('the Wednesday window is clamped so it can never strand the stages after it', () => {
    const routeStart = 1_000_000
    // Normal case: earlier stages behave, the clamp is inert and the full window is granted.
    const onTime = wednesdaySendDeadlineAt(routeStart, routeStart + 20_000)
    expect(onTime).toBe(routeStart + 20_000 + REMINDER_DEADLINE_MS)
    // Pathological case: earlier stages overran badly. The window shortens instead of the tail
    // stages being cut off entirely.
    const late = wednesdaySendDeadlineAt(routeStart, routeStart + 120_000)
    expect(late).toBeLessThan(routeStart + 120_000 + REMINDER_DEADLINE_MS)
    expect(late).toBe(
      routeStart + ROUTE_MAX_DURATION_S * 1000 - ROUTE_SAFETY_MARGIN_MS - tailBudgetAfterWednesdayMs(),
    )
  })

  it('the mirrored worker budgets have not drifted from the modules that own them', () => {
    const onboarding = readFileSync('lib/onboarding/reminderWorker.ts', 'utf8')
    const release = readFileSync('lib/introductions/capacityRelease.ts', 'utf8')
    const num = (src: string, name: string) =>
      Number(src.match(new RegExp(`${name} = ([\\d_]+)`))![1].replace(/_/g, ''))
    expect(num(onboarding, 'REMINDER_STAGE_BUDGET_MS')).toBe(ONBOARDING_REMINDER_BUDGET_MS)
    expect(num(release, 'RELEASE_STAGE_BUDGET_MS')).toBe(CAPACITY_RELEASE_BUDGET_MS)
  })

  it('300 is not assumed — the repo already deploys a cron at that ceiling', () => {
    expect(readFileSync('app/api/cron/enrich-companies/route.ts', 'utf8'))
      .toMatch(/export const maxDuration = 300/)
    expect(BUDGET).toMatch(/rejected at\s*\n?\s*\*?\s*deploy time/)
  })
})
