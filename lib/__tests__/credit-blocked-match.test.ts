import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { blockedDedupeKey } from '../introductions/creditBlockedMatch'
import { EXPIRY_AGE_DAYS } from '../introductions/expiry'
// creditBlockedSweep is NOT imported: it pulls in finalizeMutualMatch → lib/email, which constructs
// the Resend client at module load and needs an API key. Its constants are asserted from source.

const NOTIFY = readFileSync('lib/introductions/creditBlockedMatch.ts', 'utf8')
const SWEEP = readFileSync('lib/introductions/creditBlockedSweep.ts', 'utf8')
const FINAL = readFileSync('lib/introductions/finalizeMutualMatch.ts', 'utf8')
const CRON = readFileSync('app/api/cron/engagement-reminders/route.ts', 'utf8')

describe('both sides are told when a match is blocked on credits', () => {
  it('fires on BOTH insufficient-credit branches, with the right side marked short', () => {
    // insufficient_credits_a → the ACTING member is short. insufficient_credits_b → the OTHER one.
    expect(FINAL).toContain('shortUserId: actingUserId, otherUserId,')
    expect(FINAL).toContain('shortUserId: otherUserId, otherUserId: actingUserId,')
  })

  it('does not disclose whose balance is short to the other member', () => {
    const waiting = NOTIFY.slice(NOTIFY.indexOf("role: 'waiting'"))
    for (const leak of ['credit to connect', 'they need', 'out of credits', 'their balance']) {
      expect(waiting.toLowerCase()).not.toContain(leak.toLowerCase())
    }
    expect(waiting).toContain('as soon as a credit is available on both sides')
  })

  it('sends the short member somewhere they can act', () => {
    expect(NOTIFY).toContain("link: '/dashboard/billing'")
  })

  it('dedupes per PAIR, order-independently', () => {
    expect(blockedDedupeKey('b', 'a')).toBe(blockedDedupeKey('a', 'b'))
    expect(blockedDedupeKey('a', 'b')).toBe('match_blocked:a:b')
  })

  it('never throws — a missed notification must not fail the request', () => {
    expect(NOTIFY).toContain('notify failed (non-fatal)')
  })
})

describe('the sweep retries rather than instrumenting the credit writers', () => {
  it('requires BOTH directions to carry an interest row', () => {
    // One-sided interest belongs to the expiry worker, not here.
    expect(SWEEP).toContain('if (requesters.size < 2) continue')
  })

  it('skips pairs that already matched', () => {
    expect(SWEEP).toContain('buildBidirectionalMatchFilter(a, b)')
  })

  it('ages from the LATER of the two decisions', () => {
    expect(SWEEP).toContain('pairRows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m)')
  })

  it('anchors staleness to the expiry window rather than inventing a number', () => {
    expect(SWEEP).toContain('export const CONSENT_FRESH_DAYS = EXPIRY_AGE_DAYS')
    expect(EXPIRY_AGE_DAYS).toBe(14)
  })

  it('does NOT spend a stale yes — it notifies and leaves the pair intact', () => {
    const stale = SWEEP.slice(SWEEP.indexOf('if (ageDays > CONSENT_FRESH_DAYS)'),
                              SWEEP.indexOf('// FRESH'))
    expect(stale).toContain("dedupeKey: `match_stale:${pairId}`")
    expect(stale).not.toContain('finalizeMutualMatch')
    expect(stale).toContain('continue')
  })

  it('runs BEFORE expiry in the cron', () => {
    const sweep = CRON.indexOf('runCreditBlockedSweep(admin')
    const expiry = CRON.indexOf('runExpiryStage(admin')
    expect(sweep).toBeGreaterThan(-1)
    expect(sweep).toBeLessThan(expiry)
  })

  it('is budgeted and cannot break the rest of the cron', () => {
    expect(CRON).toMatch(/const CREDIT_RETRY_BUDGET_MS = [\d_]+/)
    expect(CRON).toContain('credit-blocked sweep failed (class)')
  })
})
