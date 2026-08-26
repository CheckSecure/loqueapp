import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The Pass-rate query must reconcile. A review reported 6 cards placed but
 * 2 interested + 2 passed + 1 expired + 2 still open = 7.
 *
 * ROOT CAUSE: a card answered by a CORRELATED expression stays 'suggested' (migration 080), so it
 * was counted as interested AND as still-awaiting. The fix classifies current state ONCE per card,
 * by the first rule it matches.
 *
 * These tests run the classifier the SQL implements against fixtures — including the exact 6-card
 * shape from the report — and would fail on the old overlapping logic.
 */
const SQL = readFileSync('supabase/audits/introduction_pass_rate.sql', 'utf8')

const INTEREST = ['pending', 'approved', 'accepted', 'accepted_pending_payment', 'admin_pending']

interface Card { id: string; status: string; correlatedAnswer?: boolean }

/** The exact CASE ladder in the SQL: first match wins, so the buckets are mutually exclusive. */
function classify(c: Card): 'interested' | 'passed' | 'expired_without_an_answer' | 'still_awaiting' | 'unclassified' {
  if (INTEREST.includes(c.status) || c.correlatedAnswer) return 'interested'
  if (c.status === 'passed' || c.status === 'hidden_permanent') return 'passed'
  if (c.status === 'expired') return 'expired_without_an_answer'
  if (c.status === 'suggested' || c.status === 'queued') return 'still_awaiting'
  return 'unclassified'
}

/** The OLD overlapping logic, kept only so a test can prove it was broken. */
function classifyOld(c: Card) {
  return {
    interested: INTEREST.includes(c.status) || !!c.correlatedAnswer,
    passed: c.status === 'passed' || c.status === 'hidden_permanent',
    expired: c.status === 'expired',
    stillOpen: c.status === 'suggested' || c.status === 'queued',
  }
}

function tally(cards: Card[]) {
  const t = { interested: 0, passed: 0, expired_without_an_answer: 0, still_awaiting: 0, unclassified: 0 }
  for (const c of cards) t[classify(c)]++
  const sum = t.interested + t.passed + t.expired_without_an_answer + t.still_awaiting + t.unclassified
  return { ...t, cards_placed: cards.length, sum, reconciles: sum === cards.length }
}

// The EXACT shape from the review, including the correlated card that caused the 6-vs-7.
const REPORTED: Card[] = [
  { id: '1', status: 'approved' },                            // interested, in place
  { id: '2', status: 'passed' },                              // passed
  { id: '3', status: 'hidden_permanent' },                    // passed
  { id: '4', status: 'expired' },                             // expired, unanswered
  { id: '5', status: 'suggested' },                           // still awaiting
  { id: '6', status: 'suggested', correlatedAnswer: true },   // interested via a correlated row
]

describe('the reported 6-versus-7 inconsistency', () => {
  it('NEGATIVE CONTROL: the old logic really did total 7 from 6 cards', () => {
    const old = REPORTED.map(classifyOld)
    const total = old.filter((o) => o.interested).length + old.filter((o) => o.passed).length
                + old.filter((o) => o.expired).length + old.filter((o) => o.stillOpen).length
    expect(REPORTED).toHaveLength(6)
    expect(total).toBe(7)                       // the defect, reproduced
    expect(total).not.toBe(REPORTED.length)
  })

  it('the double-counted card is exactly the correlated one', () => {
    const c = REPORTED.find((x) => x.correlatedAnswer)!
    const o = classifyOld(c)
    expect(o.interested && o.stillOpen).toBe(true)      // counted twice
    expect(classify(c)).toBe('interested')              // now counted once
  })

  it('POSITIVE: the corrected classification reconciles exactly', () => {
    const t = tally(REPORTED)
    expect(t.cards_placed).toBe(6)
    expect(t.interested).toBe(2)
    expect(t.passed).toBe(2)
    expect(t.expired_without_an_answer).toBe(1)
    expect(t.still_awaiting).toBe(1)     // was 2 — the correlated card is answered, not awaiting
    expect(t.unclassified).toBe(0)
    expect(t.sum).toBe(6)
    expect(t.reconciles).toBe(true)
  })
})

describe('the buckets are mutually exclusive for every status', () => {
  const ALL = ['suggested', 'queued', 'pending', 'accepted', 'admin_pending', 'approved', 'passed',
               'hidden', 'hidden_permanent', 'archived', 'declined', 'rejected', 'expired',
               'accepted_pending_payment']

  it('every status lands in exactly one bucket', () => {
    for (const status of ALL) {
      const t = tally([{ id: 'x', status }])
      expect(t.sum, status).toBe(1)
      expect(t.reconciles, status).toBe(true)
    }
  })

  it('unanticipated statuses become unclassified rather than being dropped', () => {
    for (const status of ['hidden', 'archived', 'declined', 'rejected']) {
      expect(classify({ id: 'x', status }), status).toBe('unclassified')
    }
    const t = tally(ALL.map((status, i) => ({ id: String(i), status })))
    expect(t.unclassified).toBe(4)
    expect(t.reconciles).toBe(true)
  })

  it('reconciles on a mixed 40-card population, correlated answers included', () => {
    const many: Card[] = Array.from({ length: 40 }, (_, i) => ({
      id: String(i),
      status: ALL[i % ALL.length],
      correlatedAnswer: i % 5 === 0,
    }))
    const t = tally(many)
    expect(t.cards_placed).toBe(40)
    expect(t.reconciles).toBe(true)
  })

  it('reconciles trivially on an empty population', () => {
    const t = tally([])
    expect(t.reconciles).toBe(true)
    expect(t.sum).toBe(0)
  })
})

describe('the shipped SQL implements exactly that', () => {
  it('classifies current state ONCE, with a first-match CASE', () => {
    expect(SQL).toMatch(/CASE\s*\n\s*WHEN f\.interested_inplace OR f\.interested_correlated THEN 'interested'/)
    expect(SQL).toMatch(/WHEN f\.status IN \('passed','hidden_permanent'\)\s*THEN 'passed'/)
    expect(SQL).toMatch(/WHEN f\.status = 'expired'\s*THEN 'expired_without_an_answer'/)
    expect(SQL).toMatch(/WHEN f\.status IN \('suggested','queued'\)\s*THEN 'still_awaiting'/)
    expect(SQL).toMatch(/ELSE 'unclassified'/)
    expect(SQL).toContain('AS state')
  })

  it('emits every required reconciliation field', () => {
    for (const key of ['cards_placed', 'answered', 'unanswered', 'interested', 'passed',
                       'expired_without_an_answer', 'still_awaiting', 'unclassified',
                       'sum_of_exclusive_states', 'reconciles']) {
      expect(SQL, key).toContain(`'${key}'`)
    }
  })

  it('emits a verdict proving the states reconcile to the denominator', () => {
    expect(SQL).toContain("'reconciles_overall'")
    expect(SQL).toContain('bool_and(')
    expect(SQL).toContain("RECONCILED: every week''s mutually exclusive states sum exactly to cards placed")
    expect(SQL).toContain("DEFECT: a week''s states do not sum to cards placed")
  })

  it('keeps overlapping EVENT metrics separate and out of the denominator', () => {
    expect(SQL).toContain("'events_overlapping'")
    expect(SQL).toContain('event_interest_correlated')
    expect(SQL).toContain('event_interest_in_place')
    expect(SQL).toMatch(/They are reported separately and never enter the denominator/)
  })

  it('a correlated response ROW never enters the placed-card denominator', () => {
    expect(SQL).toContain('is_card')
    expect(SQL).toContain('WHERE is_card')
    expect(SQL).toMatch(/\(to_jsonb\(r\) ->> 'responds_to_id'\) IS NULL\s*AS is_card/)
  })

  it('a system release is reported under EXPIRED, never as a member Pass', () => {
    expect(SQL).toMatch(/state = 'expired_without_an_answer'\s*\n\s*AND resolution_reason = 'system_pair_unavailable'/)
    expect(SQL).toContain('system_released_target_unavailable')
    expect(SQL).toMatch(/It sits under EXPIRED, never under PASSED/)
  })

  it('is read-only and emits no identity', () => {
    expect(SQL).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT)\b/im)
    expect(SQL.replace(/--.*$/gm, ' ')).not.toMatch(/'requester_id'|'target_user_id'|full_name|email/)
  })
})
