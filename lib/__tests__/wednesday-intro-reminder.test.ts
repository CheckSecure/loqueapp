import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  isWednesdayInNewYork, newYorkIsoWeekKey, newYorkParts, openCardsFor, reminderIneligibility,
  wednesdayReminderCopy, INTRODUCTIONS_URL, REMINDER_PURPOSE, RESPONDED_STATUSES,
  type OpenCard, type ReminderProfile,
} from '@/lib/reminders/wednesdayIntroReminder'
import { buildWednesdayReminderEmail } from '@/lib/email/wednesdayReminder'
import { isSettled, EXPIRY_AGE_DAYS } from '@/lib/introductions/expiry'
import { CLAIM_LEASE_MS } from '@/lib/reminders/deliveryLedger'
import { ACTING_CONSENT_STATUSES, COUNTERPART_INTEREST_STATUSES } from '@/lib/introRequests/classify'

/**
 * The Wednesday reminder exists because the previous one could not reach the members who most
 * needed it: it keyed on a recommendation_batches envelope, and reciprocal cards have none.
 * These tests are behavioural wherever behaviour exists; the SQL-only guarantees (advisory locks,
 * atomic pair expiry, grants) are pinned by text here and proven by the PostgreSQL harness.
 */

const CRON = readFileSync('app/api/cron/engagement-reminders/route.ts', 'utf8')
const EXPIRE = readFileSync('app/api/cron/expire-pending-intros/route.ts', 'utf8')
const M065 = readFileSync('supabase/migrations/065_reminder_deliveries.sql', 'utf8')
const M066 = readFileSync('supabase/migrations/066_expire_intro_pair.sql', 'utf8')

const prof = (over: Partial<ReminderProfile> = {}): ReminderProfile => ({
  id: 'm1', email: 'a@example.test', firstName: 'Alex', accountStatus: 'active',
  profileComplete: true, isTestAccount: false, isAdmin: false, matchingPaused: false, ...over,
})
const card = (requesterId: string, targetUserId: string, status = 'suggested', pairId: string | null = null): OpenCard =>
  ({ requesterId, targetUserId, status, pairId })

/** Code with comments removed — prose legitimately names things the code must not contain. */
const codeOf = (src: string) =>
  src.split('\n').filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
/** Just the Wednesday section of the cron route. */
const WED = () => CRON.slice(CRON.indexOf('PART 5: WEDNESDAY'), CRON.indexOf('PART 6: bounded DAILY'))
const WORKER = readFileSync('lib/introductions/expiryWorker.ts', 'utf8')

describe('Wednesday in America/New_York, across DST', () => {
  // 2026-03-08 is the US DST spring-forward; 2026-11-01 is fall-back.
  it('is true on a Wednesday in EST (winter)', () => {
    expect(isWednesdayInNewYork(new Date('2026-01-14T17:00:00Z'))).toBe(true)   // 12:00 EST Wed
  })
  it('is true on a Wednesday in EDT (summer)', () => {
    expect(isWednesdayInNewYork(new Date('2026-07-15T17:00:00Z'))).toBe(true)   // 13:00 EDT Wed
  })
  it('is false on Tuesday and Thursday', () => {
    expect(isWednesdayInNewYork(new Date('2026-01-13T17:00:00Z'))).toBe(false)
    expect(isWednesdayInNewYork(new Date('2026-01-15T17:00:00Z'))).toBe(false)
  })
  it('uses NEW YORK, not UTC — the two disagree near midnight', () => {
    // 2026-01-15T02:00Z is Thursday in UTC but still WEDNESDAY 21:00 in New York.
    const d = new Date('2026-01-15T02:00:00Z')
    expect(d.getUTCDay()).toBe(4)                    // Thursday in UTC
    expect(isWednesdayInNewYork(d)).toBe(true)       // Wednesday in New York
  })
  it('and the reverse: Wednesday 02:00 UTC is still Tuesday in New York', () => {
    const d = new Date('2026-01-14T02:00:00Z')
    expect(d.getUTCDay()).toBe(3)                    // Wednesday in UTC
    expect(isWednesdayInNewYork(d)).toBe(false)      // Tuesday 21:00 in New York
  })
  it('reports the New York calendar date, not the UTC one', () => {
    expect(newYorkParts(new Date('2026-01-15T02:00:00Z'))).toMatchObject({ year: 2026, month: 1, day: 14 })
  })
})

describe('one consolidated reminder per member per week', () => {
  it('the ISO week key comes from the NEW YORK date', () => {
    // Same instant, different UTC/NY dates — the key must follow New York.
    expect(newYorkIsoWeekKey(new Date('2026-01-15T02:00:00Z')))
      .toBe(newYorkIsoWeekKey(new Date('2026-01-14T17:00:00Z')))
  })
  it('is stable across the whole New York Wednesday', () => {
    const a = newYorkIsoWeekKey(new Date('2026-07-15T12:00:00Z'))
    const b = newYorkIsoWeekKey(new Date('2026-07-16T03:00:00Z'))  // still Wed 23:00 EDT
    expect(a).toBe(b)
  })
  it('changes the following week', () => {
    expect(newYorkIsoWeekKey(new Date('2026-01-14T17:00:00Z')))
      .not.toBe(newYorkIsoWeekKey(new Date('2026-01-21T17:00:00Z')))
  })
  it('the dedupe identity is member + purpose + week, never a batch id', () => {
    expect(REMINDER_PURPOSE).toBe('wednesday_intro_reminder')
    expect(M065).toMatch(/reminder_deliveries_active_claim_uniq/)
    expect(M065).toMatch(/\(member_id, purpose, cycle_key\)/)
    // PART 3 legitimately still uses introreminder:<batch_id>; PART 5 must not.
    expect(WED()).not.toContain('introreminder')
  })
})

describe('eligibility', () => {
  it('an unanswered suggested card qualifies', () => {
    const rows = [card('m1', 't1')]
    expect(openCardsFor('m1', rows)).toHaveLength(1)
    expect(reminderIneligibility(prof(), 1)).toBeNull()
  })

  it('RECIPROCAL cards qualify with no envelope and no batch id', () => {
    const rows = [card('m1', 't1', 'suggested', 'pair-1')]
    expect(openCardsFor('m1', rows)).toHaveLength(1)
    // and the worker never consults a batch table
    expect(CRON).not.toMatch(/from\('recommendation_batches'\)[\s\S]{0,400}wednesdayReminder/)
  })

  it('LEGACY/admin one-sided cards qualify', () => {
    expect(openCardsFor('m1', [card('m1', 't1', 'suggested', null)])).toHaveLength(1)
  })

  it('a member whose only state is their own pending interest is NOT reminded', () => {
    const rows = [card('m1', 't1', 'suggested'), card('m1', 't1', 'pending')]
    expect(openCardsFor('m1', rows)).toHaveLength(0)
    expect(reminderIneligibility(prof(), 0)).toBe('no_open_cards')
  })

  it('every responded status closes the card', () => {
    for (const st of Array.from(RESPONDED_STATUSES)) {
      const rows = [card('m1', 't1', 'suggested'), card('m1', 't1', st)]
      expect(openCardsFor('m1', rows), `${st} should close the card`).toHaveLength(0)
    }
  })

  it('counts only the member\'s OWN cards', () => {
    expect(openCardsFor('m1', [card('m2', 'm1', 'suggested')])).toHaveLength(0)
  })

  it('rejects inactive / incomplete / test / admin / paused / emailless members', () => {
    expect(reminderIneligibility(prof({ accountStatus: 'suspended' }), 1)).toBe('inactive')
    expect(reminderIneligibility(prof({ profileComplete: false }), 1)).toBe('incomplete_profile')
    expect(reminderIneligibility(prof({ isTestAccount: true }), 1)).toBe('test_account')
    expect(reminderIneligibility(prof({ isAdmin: true }), 1)).toBe('admin_account')
    expect(reminderIneligibility(prof({ matchingPaused: true }), 1)).toBe('matching_paused')
    expect(reminderIneligibility(prof({ email: null }), 1)).toBe('no_email')
    expect(reminderIneligibility(prof({ email: 'not-an-email' }), 1)).toBe('no_email')
  })
})

describe('email copy', () => {
  it('is singular for one card and plural for more', () => {
    expect(wednesdayReminderCopy('Alex', 1).countLine)
      .toBe('You currently have one introduction awaiting your response in Andrel.')
    expect(wednesdayReminderCopy('Alex', 2).countLine)
      .toBe('You currently have 2 introductions awaiting your response in Andrel.')
  })

  it('uses the required subject and closing', () => {
    const c = wednesdayReminderCopy('Alex', 1)
    expect(c.subject).toBe('Please review your Andrel introductions before Thursday')
    expect(c.closing).toEqual(['Best,', 'Daniel', 'Founder, Andrel'])
    expect(c.cta).toBe('Review introductions')
  })

  it('links to the canonical www Introductions page', () => {
    expect(INTRODUCTIONS_URL).toBe('https://www.andrel.app/dashboard/introductions')
    const built = buildWednesdayReminderEmail('Alex', 1)
    expect(built.html).toContain(INTRODUCTIONS_URL)
    expect(built.text).toContain(INTRODUCTIONS_URL)
  })

  it('NEVER promises a Thursday introduction', () => {
    const built = buildWednesdayReminderEmail('Alex', 2)
    const blob = (built.html + built.text).toLowerCase()
    expect(blob).toContain('prepared thursday')
    for (const claim of ['you will receive', 'guaranteed', 'every member receives',
                         'a new introduction thursday', 'your next match']) {
      expect(blob, `must not claim: ${claim}`).not.toContain(claim)
    }
  })

  it('states that unanswered cards occupy slots', () => {
    const built = buildWednesdayReminderEmail('Alex', 1)
    expect(built.text).toContain('occupy your available introduction slots')
    expect(built.text).toContain('may limit your eligibility for future batches')
  })

  it('leaks no connection identity, response state, or internal id', () => {
    const built = buildWednesdayReminderEmail('Alex', 2)
    const blob = built.html + built.text
    for (const leak of ['pair', 'request_id', 'uuid', 'interested', 'responded', 'declined',
                        'expressed', 'they ', 'their ']) {
      expect(blob.toLowerCase(), `leaked: ${leak}`).not.toContain(leak)
    }
    // the builder's signature makes a leak structurally impossible
    expect(buildWednesdayReminderEmail.length).toBe(2)
  })

  it('has a plain-text alternative and escapes the name', () => {
    const built = buildWednesdayReminderEmail('<script>x</script>', 1)
    expect(built.text.length).toBeGreaterThan(50)
    expect(built.html).not.toContain('<script>')
  })

  it('falls back gracefully when no first name is known', () => {
    expect(wednesdayReminderCopy(null, 1).greeting).toBe('Hi there,')
    expect(wednesdayReminderCopy('   ', 1).greeting).toBe('Hi there,')
  })
})

describe('delivery ledger, claim and retry', () => {
  it('the claim is a partial unique index over the ACTIVE states', () => {
    expect(M065).toMatch(/CREATE UNIQUE INDEX[\s\S]*reminder_deliveries_active_claim_uniq/)
    expect(M065).toMatch(/WHERE status IN \('claimed', 'accepted', 'delivered', 'deferred'\)/)
  })
  it("'failed' sits OUTSIDE the claim so a provider failure is retryable", () => {
    const idx = M065.slice(M065.indexOf('reminder_deliveries_active_claim_uniq'))
    expect(idx.slice(0, 300)).not.toContain("'failed'")
  })
  it('distinguishes claimed / accepted / failed and terminal provider states', () => {
    expect(M065).toMatch(/CHECK \(status IN \('claimed','accepted','delivered','deferred',/)
    expect(M065).toMatch(/'bounced','blocked','complained','failed'\)\)/)
  })
  it('stores no body, identity, payload or secret', () => {
    // The prose explicitly lists what is NOT stored, so assert against the DDL only.
    const ddl = M065.slice(M065.indexOf('CREATE TABLE'), M065.indexOf('COMMENT ON TABLE'))
    expect(ddl).not.toMatch(/\bbody\b|html|payload|token|password|subject/i)
    expect(M065).toMatch(/Stores NO email body/i)
  })
  it('is service-role only with RLS enabled', () => {
    expect(M065).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(M065).toMatch(/REVOKE ALL ON TABLE public\.reminder_deliveries FROM PUBLIC, anon, authenticated/)
    expect(M065).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE public\.reminder_deliveries TO service_role/)
  })
  it('a possibly-sent message is left claimed, never marked failed', () => {
    const client = readFileSync('lib/reminders/deliveryLedger.ts', 'utf8')
    expect(client).toMatch(/A missed reminder is recoverable; a duplicate one is not/)
  })
})

describe('atomic pair expiry (migration 066)', () => {
  it('takes BOTH advisory locks in canonical order', () => {
    const lo = M066.indexOf('hashtextextended(lo::text')
    const hi = M066.indexOf('hashtextextended(hi::text')
    expect(lo).toBeGreaterThan(-1)
    expect(hi).toBeGreaterThan(lo)
    expect(M066.indexOf('lo := LEAST(')).toBeLessThan(lo)
  })
  it('refuses only when BOTH sides expressed interest — finalization owns that pair', () => {
    expect(M066).toMatch(/'mutual_pending'/)
    expect(M066).toMatch(/IF v_int_lo > 0 AND v_int_hi > 0 THEN/)
  })

  it('CLOSES a one-sided pair instead of blocking capacity forever', () => {
    // The earlier draft refused on ANY interest, so A's private interest made B's card unexpirable
    // and B's slot was occupied indefinitely by a decision B could not see.
    expect(M066).toMatch(/one_sided_interest/)
    expect(M066).not.toMatch(/'interest_expressed'/)
    expect(M066).toMatch(/must not block capacity forever/i)
  })

  it('closes BOTH directions, including the interested side', () => {
    const writes = M066.slice(M066.indexOf('FIRST WRITE'))
    expect(writes).toMatch(/status IN \('suggested','approved','accepted','pending'\)/)
    expect(writes).toMatch(/WHERE pair_id = p_pair_id/)
  })

  it("uses 'expired', a status the CHECK already allows and the UI renders neutrally", () => {
    expect(M066).toMatch(/SET status = 'expired'/)
    // no new status invented; resolution_reason (constrained by 062) is explained in prose but
    // never written, so assert against the executable body only
    expect(codeOf(M066)).not.toMatch(/resolution_reason/)
  })

  it('documents how the two rows represent every state', () => {
    for (const state of ['neither has responded', 'A ONLY', 'B ONLY', 'MUTUAL', 'finalized']) {
      expect(M066, `state not documented: ${state}`).toContain(state)
    }
  })

  it('scopes itself to the pair — a standalone pending workflow is untouched', () => {
    const body = M066.slice(M066.indexOf('BEGIN'))
    // every row-touching statement is keyed on pair_id
    for (const m of body.match(/FROM public\.intro_requests[\s\S]{0,240}/g) ?? []) {
      expect(m).toMatch(/pair_id/)
    }
  })

  it('relies on the EXISTING consent revalidation to prevent resurrection', () => {
    // finalizeMutualMatch requires both rows in consent statuses; 'expired' is in neither set, so a
    // finalization that arrives after expiry returns 409 rather than reviving the pair.
    expect([...ACTING_CONSENT_STATUSES]).not.toContain('expired')
    expect([...COUNTERPART_INTEREST_STATUSES]).not.toContain('expired')
    expect(readFileSync('lib/introductions/finalizeMutualMatch.ts', 'utf8'))
      .toMatch(/bothMembersConsented/)
    expect(M066).toMatch(/CANNOT resurrect/)
  })
  it('never expires a finalized match or a terminal pair', () => {
    expect(M066).toMatch(/'match_exists'/)
    expect(M066).toMatch(/'pair_terminal'/)
    expect(M066).toMatch(/v_pair\.status IN \('matched','blocked'\)/)
  })
  it('moves BOTH rows or neither, and only when both are old enough', () => {
    expect(M066).toMatch(/IF v_n_open <> 2 THEN/)
    expect(M066).toMatch(/IF v_n_old <> 2 THEN/)
    expect(M066).toMatch(/WHERE pair_id = p_pair_id\s*\n\s*AND status IN \('suggested','approved','accepted','pending'\)/)
  })
  it('every refusal precedes the first write', () => {
    const firstWrite = M066.indexOf('FIRST WRITE')
    for (const o of ["'pair_terminal'", "'match_exists'", "'interest_expressed'",
                     "'not_two_open_rows'", "'not_old_enough'", "'pair_not_found'"]) {
      expect(M066.indexOf(o), `${o} must precede the write`).toBeLessThan(firstWrite)
    }
  })
  it('PRESERVES history and cooldown', () => {
    const writes = M066.slice(M066.indexOf('FIRST WRITE'))
    expect(writes).not.toMatch(/last_recommended_at\s*=/)
    expect(writes).not.toMatch(/recommend_count\s*=/)
    expect(writes).toMatch(/SET status = 'expired'/)
  })
  it('sends no notification and logs no identity', () => {
    expect(M066).not.toMatch(/pg_notify|RAISE (NOTICE|LOG)/i)
    expect(M066).not.toMatch(/SQLERRM/)
  })
  it('is SECURITY DEFINER, empty search_path, service_role only', () => {
    expect(M066).toMatch(/SECURITY DEFINER/)
    expect(M066).toMatch(/SET search_path = ''/)
    expect(M066).toMatch(/REVOKE ALL ON FUNCTION public\.expire_intro_pair\(uuid, integer\) FROM PUBLIC, anon, authenticated/)
    expect(M066).toMatch(/GRANT EXECUTE ON FUNCTION public\.expire_intro_pair\(uuid, integer\) TO service_role/)
  })
  it('classifies settled outcomes correctly', () => {
    expect(isSettled('expired')).toBe(true)
    expect(isSettled('protected')).toBe(true)
    expect(isSettled('invalid')).toBe(true)
    expect(isSettled('skipped')).toBe(false)
    expect(isSettled('error')).toBe(false)
  })
  it('expires at 14 days', () => { expect(EXPIRY_AGE_DAYS).toBe(14) })
})

describe('legacy one-sided expiry is isolated', () => {
  it('only touches still-suggested, pair-less, old-enough rows', () => {
    const seg = WORKER.slice(WORKER.indexOf('LEGACY / ADMIN one-sided'))
    expect(seg).toMatch(/\.is\('pair_id', null\)/)
    expect(seg).toMatch(/\.eq\('status', 'suggested'\)/)
    expect(seg).toMatch(/\.lt\('created_at', cutoff\)/)
    expect(seg).toMatch(/re-check: never move a row that changed underneath us/)
  })
  it('manufactures no counterpart and touches no closed row', () => {
    const seg = WORKER.slice(WORKER.indexOf('LEGACY / ADMIN one-sided'))
    expect(seg).not.toMatch(/insert\(/i)
    expect(seg).not.toMatch(/'matched'|'archived'/)
  })
  it('the 30-day pending sweep is unchanged', () => {
    expect(EXPIRE).toMatch(/\.eq\('status', 'pending'\)/)
    expect(EXPIRE).toMatch(/thirtyDaysAgo/)
  })
})

describe('bounded processing and privacy of the worker', () => {
  it('the Wednesday read is paged and fails closed', () => {
    expect(CRON).toMatch(/\.range\(from, from \+ REMINDER_PAGE - 1\)/)
    expect(CRON).toMatch(/if \(!data \|\| data\.length < REMINDER_PAGE\) break/)
    expect(CRON).toMatch(/readFailed = true/)
    expect(CRON).toMatch(/read_failed_no_sends/)
  })
  it('is capped and deadline-aware', () => {
    expect(CRON).toMatch(/REMINDER_MAX_PER_RUN = \d+/)
    expect(CRON).toMatch(/REMINDER_DEADLINE_MS/)
    expect(CRON).toMatch(/wedTruncated = true/)
    expect(WORKER).toMatch(/maxPairs = opts\.maxPairs \?\? \d+/)
    expect(WORKER).toMatch(/opts\.budgetMs/)
  })
  it('processes deterministically, oldest first', () => {
    expect(WORKER).toMatch(/\.order\('created_at', \{ ascending: true \}\)/)
    expect(CRON).toMatch(/sort\(\(a, b\) => a\[0\]\.localeCompare\(b\[0\]\)\)/)
  })
  it('reports aggregate counts only, no identities', () => {
    expect(CRON).toMatch(/considered: wedConsidered, claimed: wedClaimed, sent: wedSent, failed: wedFailed/)
    expect(EXPIRE).toMatch(/suggestedExpiry: exp/)
    // migration 085 added the unavailable-pair sweep to this same stage; its result is aggregate
    // counts only, and is returned alongside the existing ones
    expect(WORKER).toMatch(/return \{ pairsProcessed, legacyExpired, orphanExpired, promotion, truncated, outcomes, unavailable \}/)
    expect(WORKER).toMatch(/unavailable: \{ processed: number; released: number; skipped: number; failed: number; truncated: boolean \}/)
    // No identity in any log line. Checked per line on code only: a greedy cross-line regex
    // would run from one console.error into unrelated text further down the file.
    for (const line of (codeOf(CRON) + '\n' + codeOf(WORKER)).split('\n')) {
      if (!/console\.(log|error|warn)\(/.test(line)) continue
      expect(line, `log line leaks identity: ${line.trim()}`)
        .not.toMatch(/memberId|batchId|recipientId|introRequestId|\.email|full_name|\$\{[a-zA-Z]*[Ii]d\}/)
    }
  })
  it('keeps CRON_SECRET auth on both routes', () => {
    expect(CRON).toMatch(/Bearer \$\{process\.env\.CRON_SECRET\}/)
    expect(EXPIRE).toMatch(/Bearer \$\{process\.env\.CRON_SECRET\}/)
  })
  it('adds no new Vercel cron entry', () => {
    const v = JSON.parse(readFileSync('vercel.json', 'utf8'))
    const paths = (v.crons ?? []).map((c: any) => c.path)
    expect(paths).toContain('/api/cron/engagement-reminders')
    expect(paths).toContain('/api/cron/expire-pending-intros')
    expect(paths.filter((p: string) => p.includes('wednesday'))).toHaveLength(0)
  })
})

describe('unrelated behaviour preserved', () => {
  it('migration 064 is untouched', () => {
    const crypto = require('node:crypto') as typeof import('node:crypto')
    const buf = readFileSync('supabase/migrations/064_materialize_admin_pair.sql')
    expect(crypto.createHash('sha256').update(buf).digest('hex'))
      .toBe('e00292ffd3961231ba4ca297b3ad78cbef258c4b0e8a6a10d49473f0ac397cc8')
  })
  it('existing engagement reminder parts still run', () => {
    expect(CRON).toMatch(/PART 4/)
    expect(CRON).toMatch(/PART 3/)
    expect(CRON).toMatch(/introreminder:/)   // the legacy per-batch reminder is not removed
  })
  it('no migration creates or alters matching, credits, subscriptions or conversations', () => {
    for (const sql of [M065, M066]) {
      expect(sql).not.toMatch(/credits|subscription|stripe|conversations|messages/i)
    }
  })
})

describe('Blocker 3 — claim lease and honest delivery semantics', () => {
  const LEDGER = readFileSync('lib/reminders/deliveryLedger.ts', 'utf8')

  it('a claim is a lease, not a tombstone', () => {
    expect(CLAIM_LEASE_MS).toBe(15 * 60 * 1000)
    expect(M065).toMatch(/THE CLAIM IS A LEASE, NOT A TOMBSTONE/)
    expect(M065).toMatch(/attempts\s+integer NOT NULL DEFAULT 1/)
    expect(M065).toMatch(/reminder_deliveries_stale_idx/)
  })

  it('a crash before the provider call is recoverable after the lease', () => {
    expect(LEDGER).toMatch(/\.eq\('status', 'claimed'\)/)
    expect(LEDGER).toMatch(/\.lt\('claimed_at', staleBefore\)/)
  })

  it('a FRESH claim can never be stolen', () => {
    // the reclaim updates only rows older than the lease
    const seg = LEDGER.slice(LEDGER.indexOf('stale-claim recovery') - 400)
    expect(seg).toMatch(/never steals a FRESH claim/)
  })

  it("an 'accepted' claim is never reclaimed — duplicates are worse than misses", () => {
    expect(LEDGER).toMatch(/never steals 'accepted'/)
    expect(M065).toMatch(/'accepted' is NEVER reclaimable/)
  })

  it('provider failure stays retryable', () => {
    expect(LEDGER).toMatch(/'failed' sits OUTSIDE the active-claim index/)
    const idx = M065.slice(M065.indexOf('reminder_deliveries_active_claim_uniq'))
    expect(idx.slice(0, 300)).not.toContain("'failed'")
  })

  it('records the provider message id without logging identity', () => {
    expect(LEDGER).toMatch(/provider_message_id: providerMessageId/)
    for (const line of LEDGER.split('\n')) {
      if (!/console\.(log|error|warn)\(/.test(line)) continue
      expect(line).not.toMatch(/memberId|\.email|full_name|deliveryId/)
    }
  })

  it('does NOT claim exactly-once delivery', () => {
    expect(M065).toMatch(/AT-MOST-ONCE with an ambiguous boundary, not exactly-once/)
    expect(M065).not.toMatch(/exactly.once delivery is guaranteed/i)
  })
})

describe('Blocker 2 — the expiry stage rides the cron we can see running', () => {
  const WORKER = readFileSync('lib/introductions/expiryWorker.ts', 'utf8')

  it('engagement-reminders runs the expiry stage', () => {
    expect(CRON).toContain('runExpiryStage')
    expect(CRON).toMatch(/PART 6: bounded DAILY suggested-card expiry/)
  })

  it('the reminder stage runs BEFORE expiry, on its own reserved budget', () => {
    expect(CRON.indexOf('PART 5: WEDNESDAY')).toBeLessThan(CRON.indexOf('PART 6: bounded DAILY'))
    expect(CRON).toMatch(/REMINDER_DEADLINE_MS = \d+_?\d*/)
    expect(CRON).toMatch(/EXPIRY_BUDGET_MS = \d+_?\d*/)
    // measured from the stage's own start, so PART 3/4 cannot eat the reminder's slice
    expect(CRON).toMatch(/const wedStartedAt = Date\.now\(\)/)
    expect(CRON).toMatch(/Date\.now\(\) - wedStartedAt > REMINDER_DEADLINE_MS/)
  })

  it('an expiry backlog cannot starve the Wednesday email', () => {
    // the expiry stage is bounded by its own budget, measured from its own start
    expect(WORKER).toMatch(/const outOfTime = \(\) => Date\.now\(\) - started > opts\.budgetMs/)
    // and it runs only after the reminder loop has finished
    expect(CRON.indexOf('runExpiryStage')).toBeGreaterThan(CRON.indexOf('markFailed'))
  })

  it('an expiry failure is reported coarsely and cannot corrupt reminder results', () => {
    expect(CRON).toMatch(/expiry = \{ error: 'expiry_stage_failed' \}/)
    expect(CRON).toMatch(/expiry stage failed \(class\)/)
  })

  it('does NOT depend on expire-pending-intros being scheduled', () => {
    expect(WORKER).toMatch(/nothing depends on that route being scheduled|not observed registered/i)
    expect(EXPIRE).toContain('runExpiryStage')
    // and that route keeps its original 30-day pending sweep
    expect(EXPIRE).toMatch(/\.eq\('status', 'pending'\)/)
    expect(EXPIRE).toMatch(/thirtyDaysAgo/)
  })

  it('adds no Vercel cron entry', () => {
    const v = JSON.parse(readFileSync('vercel.json', 'utf8'))
    expect(v.crons).toHaveLength(10)
    expect((v.crons ?? []).map((c: any) => c.path)).toContain('/api/cron/engagement-reminders')
  })

  it('both routes keep CRON_SECRET', () => {
    expect(CRON).toMatch(/Bearer \$\{process\.env\.CRON_SECRET\}/)
    expect(EXPIRE).toMatch(/Bearer \$\{process\.env\.CRON_SECRET\}/)
  })
})

describe('TOCTOU: finalization is authorized inside the writing transaction', () => {
  const M067 = readFileSync('supabase/migrations/067_finalize_mutual_match_atomic.sql', 'utf8')
  const FIN = readFileSync('lib/introductions/finalizeMutualMatch.ts', 'utf8')
  const ACTIONS = readFileSync('app/actions.ts', 'utf8')

  it('no application caller reaches the unguarded writer any more', () => {
    // The precheck ran in its own round trip, so an expiry could land between it and the write.
    const code = (src: string) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code(FIN)).not.toContain('consume_credits_and_create_match')
    expect(code(ACTIONS)).not.toContain('consume_credits_and_create_match')
    expect(FIN).toContain('finalize_mutual_match_atomic')
    expect(ACTIONS).toContain('finalize_mutual_match_atomic')
  })

  it('067 takes the SAME locks, in the SAME order, as 066', () => {
    for (const sql of [M066, M067]) {
      expect(sql).toMatch(/lo := LEAST\(/)
      expect(sql).toMatch(/hi := GREATEST\(/)
      const l = sql.indexOf('hashtextextended(lo::text')
      const h = sql.indexOf('hashtextextended(hi::text')
      expect(l).toBeGreaterThan(-1)
      expect(h).toBeGreaterThan(l)
      expect(sql.indexOf('lo := LEAST(')).toBeLessThan(l)
    }
  })

  it('consent is re-read AFTER the locks and BEFORE the delegate', () => {
    const lockAt = M067.indexOf('pg_advisory_xact_lock')
    const consentAt = M067.indexOf('(5) CONSENT, re-read in-transaction')
    const delegateAt = M067.indexOf('consume_credits_and_create_match(p_user_a')
    expect(lockAt).toBeLessThan(consentAt)
    expect(consentAt).toBeLessThan(delegateAt)
  })

  it('refuses on an expired or blocked pair before anything is written', () => {
    expect(M067).toMatch(/v_pair\.status IN \('expired','blocked'\)/)
    expect(M067.indexOf("'not_consented'")).toBeLessThan(M067.indexOf('consume_credits_and_create_match(p_user_a'))
  })

  it('delegates rather than reimplementing match/conversation/credits', () => {
    // Scoped to the WRAPPER body: 067 also carries the delegate, whose job IS to write those rows.
    const wrapper = M067.slice(M067.indexOf('PART 2 OF 2'))
    expect(wrapper).toMatch(/SELECT \* INTO v_rpc\s*\n\s*FROM public\.consume_credits_and_create_match/)
    expect(wrapper).not.toMatch(/INSERT INTO public\.matches|INSERT INTO public\.conversations|UPDATE public\.profiles/)
  })

  it('admin action can never manufacture consent', () => {
    expect(M067).toMatch(/ir\.status IN \('approved','accepted'\)/)          // acting member
    expect(M067).toMatch(/ir\.status IN \('approved','accepted','pending'\)/) // counterpart
    // 'admin_pending' is named in the prose explaining its exclusion; assert on the body only.
    expect(codeOf(M067)).not.toMatch(/'admin_pending'/)
  })

  it('notifications follow the committed result, never precede it', () => {
    // The guard's outcome must be checked before any notification/email CALL is reached.
    const finalizedAt = FIN.indexOf("guard.outcome !== 'finalized'")
    expect(finalizedAt).toBeGreaterThan(-1)
    const callIdx: number[] = []
    const re = /\b(sendMatchCreatedEmail|createNotificationSafe|notifyMutualMatch)\s*\(/g
    for (let m = re.exec(FIN); m !== null; m = re.exec(FIN)) callIdx.push(m.index)
    for (const i of callIdx) expect(finalizedAt, 'a notification precedes the committed result').toBeLessThan(i)
  })

  it('is idempotent and leaks no identity', () => {
    const wrapper = M067.slice(M067.indexOf('PART 2 OF 2'))
    expect(wrapper).toMatch(/'already_matched'/)
    // The wrapper must never surface a raw SQL error. (The delegate's one SQLERRM is scoped to its
    // own RAISE and yields the fixed string 'insufficient_credits_b', never a database message.)
    expect(wrapper).not.toMatch(/RAISE (NOTICE|LOG)|SQLERRM|pg_notify/)
    for (const line of FIN.split('\n')) {
      if (!/console\.(log|error|warn)\(/.test(line)) continue
      expect(line, `leaks identity: ${line.trim()}`).not.toMatch(/actingUserId|otherUserId|matchId|userA|userB/)
    }
  })

  it('is service-role only with an empty search_path', () => {
    expect(M067).toMatch(/SECURITY DEFINER/)
    expect(M067).toMatch(/SET search_path = ''/)
    expect(M067).toMatch(/REVOKE ALL ON FUNCTION public\.finalize_mutual_match_atomic\(uuid, uuid, boolean\)\s*\n\s*FROM PUBLIC, anon, authenticated/)
    expect(M067).toMatch(/TO service_role/)
  })

  it('066 is unchanged by this correction — the fix is on the finalization side', () => {
    expect(M066).toMatch(/expire_intro_pair/)
    expect(M066).not.toMatch(/finalize_mutual_match_atomic/)
  })
})

// ── The out-of-band delegate: containment, hardening, and rollout ordering ──────────────────────
//
// public.consume_credits_and_create_match was created directly in the Supabase dashboard, exists in
// no migration, and was found EXECUTABLE BY PUBLIC/anon/authenticated — any browser session could
// charge two members and manufacture a match with no consent check. These assertions exist so that
// containment cannot be silently undone by a later edit.
describe('delegate hardening (migrations 067 / 068)', () => {
  const M067 = readFileSync('supabase/migrations/067_finalize_mutual_match_atomic.sql', 'utf8')
  const M068 = readFileSync('supabase/migrations/068_revoke_raw_delegate_service_role.sql', 'utf8')
  const DELEGATE = /public\.consume_credits_and_create_match\(uuid, uuid, boolean\)/

  /** Just the delegate's function body, between its dollar-quote markers. */
  const DELEGATE_BODY = () => M067.slice(M067.indexOf('AS $function$'), M067.indexOf('$function$;'))

  it('067 brings the audited delegate into the repository with search_path emptied', () => {
    expect(M067).toMatch(/CREATE OR REPLACE FUNCTION public\.consume_credits_and_create_match\(/)
    expect(M067).toMatch(/RETURNS TABLE \(match_id uuid, conversation_id uuid, error_code text\)/)
    expect(M067).toMatch(/LANGUAGE plpgsql\nVOLATILE\nSECURITY DEFINER\nSET search_path = ''/)
    expect(M067).toMatch(/p_admin_facilitated boolean DEFAULT false/)
    expect(M067).toMatch(/pg_get_functiondef/)  // records where the body came from
  })

  it('067 preserves the audited balance expression verbatim', () => {
    // In an UPDATE SET list the right-hand side reads OLD values, so this RECALCULATES balance from
    // the pre-update free_credits. `balance = balance - 1` is NOT equivalent and would drop the
    // self-healing property. Both deductions must use it.
    const recalcs = DELEGATE_BODY().match(/balance = \(free_credits - 1\) \+ COALESCE\(premium_credits, 0\)/g) ?? []
    expect(recalcs).toHaveLength(2)
    expect(DELEGATE_BODY()).not.toMatch(/balance = balance - 1/)
  })

  it('067 preserves both deductions, all three error codes, and the subtransaction rollback', () => {
    const body = DELEGATE_BODY()
    expect(body.match(/UPDATE public\.meeting_credits/g) ?? []).toHaveLength(2)
    expect(body).toMatch(/WHERE user_id = p_user_a AND free_credits >= 1/)
    expect(body).toMatch(/WHERE user_id = p_user_b AND free_credits >= 1/)
    expect(body).toMatch(/'insufficient_credits_a'/)
    expect(body).toMatch(/RAISE EXCEPTION 'insufficient_credits_b'/)
    expect(body).toMatch(/WHEN unique_violation THEN/)
    expect(body).toMatch(/'duplicate_match'/)
    expect(body).toMatch(/INSERT INTO public\.matches \(user_a_id, user_b_id, admin_facilitated\)/)
    expect(body).toMatch(/INSERT INTO public\.conversations \(match_id\)/)
  })

  it('067 leaves no unqualified reference in the delegate body', () => {
    // The entire point of search_path = ''. Strip the qualified forms, then nothing may remain.
    const code = DELEGATE_BODY().split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    const stripped = code.replace(/public\.(meeting_credits|matches|conversations)/g, '')
    expect(stripped).not.toMatch(/\b(meeting_credits|matches|conversations)\b/)
  })

  it('067 does not change the free-credit-only spend policy, and the decision is written down', () => {
    expect(DELEGATE_BODY()).not.toMatch(/balance >= 1/)
    expect(M067).toMatch(/FREE pool only/)
    expect(readFileSync('docs/FOLLOWUP_FREE_CREDIT_ONLY_SPEND.md', 'utf8')).toMatch(/free_credits >= 1/)
  })

  it('067 revokes every browser role explicitly rather than trusting the out-of-band fix', () => {
    const revokes = M067.match(new RegExp(`REVOKE ALL ON FUNCTION ${DELEGATE.source}\\s*\\n\\s*FROM [^;]+;`, 'g')) ?? []
    expect(revokes.join(' ')).toMatch(/FROM PUBLIC;/)
    expect(revokes.join(' ')).toMatch(/FROM anon, authenticated;/)
  })

  it('067 keeps service_role EXECUTE, because the deployed build still calls the delegate directly', () => {
    expect(M067).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${DELEGATE.source}\\s*\\n\\s*TO service_role;`))
    expect(M067).toMatch(/0823612/)  // the SHA whose code path this grant keeps alive
  })

  it('067 runs the delegate hardening in one transaction, so no privilege window opens', () => {
    const part1 = M067.slice(0, M067.indexOf('PART 2 OF 2'))
    expect(part1).toMatch(/\nBEGIN;/)
    expect(part1).toMatch(/\nCOMMIT;/)
    expect(part1.indexOf('BEGIN;')).toBeLessThan(part1.indexOf('REVOKE ALL'))
    expect(part1.indexOf('REVOKE ALL')).toBeLessThan(part1.indexOf('COMMIT;'))
  })

  it('067 permanently records that this was an out-of-band, browser-executable object', () => {
    expect(M067).toMatch(/COMMENT ON FUNCTION public\.consume_credits_and_create_match/)
    expect(M067).toMatch(/OUT OF BAND/)
    expect(M067).toMatch(/EXECUTABLE BY PUBLIC/)
    expect(M067).toMatch(/appear(s|ed) in NO migration/i)
  })

  it('068 severs the direct path and grants nothing back to a browser role', () => {
    expect(M068).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${DELEGATE.source}\\s*\\n\\s*FROM service_role;`))
    // the only GRANT anywhere in 068 is the wrapper, to service_role
    const grants = codeOf(M068).match(/GRANT [^;]+;/g) ?? []
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatch(/finalize_mutual_match_atomic/)
    expect(grants[0]).toMatch(/TO service_role;/)
    expect(codeOf(M068)).not.toMatch(/GRANT[^;]*\b(anon|authenticated|PUBLIC)\b/)
  })

  it('068 is explicitly gated on the new build being live, and documents its rollback', () => {
    expect(M068).toMatch(/DO NOT APPLY THIS UNTIL/)
    expect(M068).toMatch(/ROLLBACK/)
    expect(M068).toMatch(/GRANT EXECUTE ON FUNCTION public\.consume_credits_and_create_match/)
  })

  it('the harness exercises the real 067 body, never a fixture copy of it', () => {
    // A fixture copy would drift from the migration and let the harness "prove" behaviour the
    // function being applied to production does not actually have.
    const F = readFileSync('supabase/tests/066_fixture.sql', 'utf8')
    expect(F).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.consume_credits_and_create_match/)
    expect(F).toMatch(/CREATE TABLE IF NOT EXISTS public\.meeting_credits/)
    expect(F).not.toMatch(/profiles SET credits/)
    // and the bootstrap loads the fixture's tables BEFORE the migration that needs them
    const H = readFileSync('scripts/verify-066-expiry.sh', 'utf8')
    expect(H.indexOf('supabase/tests/066_fixture.sql'))
      .toBeLessThan(H.indexOf('supabase/migrations/067_finalize_mutual_match_atomic.sql'))
  })

  it('applied migrations 063 and 064 are untouched', () => {
    const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
    expect(sha('supabase/migrations/064_materialize_admin_pair.sql'))
      .toBe('e00292ffd3961231ba4ca297b3ad78cbef258c4b0e8a6a10d49473f0ac397cc8')
    expect(sha('supabase/migrations/063_unified_introduction_capacity.sql'))
      .toBe('acde8edd7bd5fb4c57c4cd29f04290a7e9ac191d86babbbf450e2405ffd4d427')
  })

  it('the misuse audit is a single read-only SELECT that emits no identifiers', () => {
    const A = readFileSync('supabase/audits/consume_credits_misuse_audit.sql', 'utf8')
    // exactly one statement — comments are stripped first, they quote SQL for the operator
    expect(codeOf(A).match(/;/g) ?? []).toHaveLength(1)
    for (const kw of ['INSERT ', 'UPDATE ', 'DELETE ', 'CREATE ', 'DROP ', 'ALTER ', 'TRUNCATE', 'GRANT ']) {
      expect(codeOf(A).toUpperCase()).not.toContain(kw)
    }
    expect(A).toMatch(/PROVABLE/)
    expect(A).toMatch(/SUSPICIOUS/)
  })

  it('no member identifier is interpolated into any log line on these paths', () => {
    for (const f of [
      'lib/introductions/finalizeMutualMatch.ts',
      'app/api/cron/engagement-reminders/route.ts',
      'app/api/cron/expire-pending-intros/route.ts',
      'lib/introductions/expiryWorker.ts',
    ]) {
      const src = readFileSync(f, 'utf8')
      for (const line of src.split('\n')) {
        if (!/console\.(log|warn|error)/.test(line)) continue
        // Strip string literals first: the danger is an identifier passed as a VALUE, not the word
        // "email" appearing inside a human-readable message.
        const code = line.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``')
        expect(code, `${f}: ${line.trim()}`).not.toMatch(/\b(userA|userB|memberId|recipientId|actingUserId|otherUserId|introRequestId|batchId|matchId|userEmail|recipientEmail)\b/)
      }
    }
  })
})
