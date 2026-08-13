import { describe, it, expect } from 'vitest'
import {
  nextCreditRefillOn, monthlyIncludedCredits, decideRefill, describeMonthlyCredit,
  effectiveCreditTier, type ClaimedMember,
} from '@/lib/credits/monthlyRefill'
import { getEffectiveTier } from '@/lib/tier-override'

const D = (iso: string) => new Date(iso)

describe('monthlyIncludedCredits — tier allowances, fail closed', () => {
  it('Free 3 / Professional 10 / Executive 20 / Founding 15 (30 → 15)', () => {
    expect(monthlyIncludedCredits('free')).toBe(3)
    expect(monthlyIncludedCredits('professional')).toBe(10)
    expect(monthlyIncludedCredits('executive')).toBe(20)
    expect(monthlyIncludedCredits('founding')).toBe(15)
  })
  it('unknown/blank tier → null (fail closed, never a default grant)', () => {
    expect(monthlyIncludedCredits('enterprise')).toBeNull()
    expect(monthlyIncludedCredits('')).toBeNull()
    expect(monthlyIncludedCredits('FREE')).toBeNull() // case-exact allow-list
  })
})

describe('nextCreditRefillOn — anniversary, clamp-safe, UTC, boundary', () => {
  it('same-month anniversary still ahead → this month', () => {
    expect(nextCreditRefillOn(15, D('2026-08-12T00:00:00Z'))).toBe('2026-08-15')
  })
  it('exact anniversary boundary → STRICTLY after → next month', () => {
    expect(nextCreditRefillOn(15, D('2026-08-15T12:00:00Z'))).toBe('2026-09-15')
  })
  it('past this month → next month', () => {
    expect(nextCreditRefillOn(15, D('2026-08-20T00:00:00Z'))).toBe('2026-09-15')
  })
  it('day-31 anchor clamps to a short month (Jan 31 → Feb 28)', () => {
    expect(nextCreditRefillOn(31, D('2026-01-31T00:00:00Z'))).toBe('2026-02-28')
  })
  it('day-31 anchor mid-Feb → Feb 28', () => {
    expect(nextCreditRefillOn(31, D('2026-02-10T00:00:00Z'))).toBe('2026-02-28')
  })
  it('day-29 anchor in a LEAP February → Feb 29', () => {
    expect(nextCreditRefillOn(29, D('2024-02-01T00:00:00Z'))).toBe('2024-02-29')
  })
  it('day-29 anchor in a NON-leap February → Feb 28', () => {
    expect(nextCreditRefillOn(29, D('2023-02-01T00:00:00Z'))).toBe('2023-02-28')
  })
  it('year rollover (Dec 20, anchor 15 → Jan 15 next year)', () => {
    expect(nextCreditRefillOn(15, D('2026-12-20T00:00:00Z'))).toBe('2027-01-15')
  })
  it('is UTC date-only: any time-of-day on the same UTC day yields the same result', () => {
    expect(nextCreditRefillOn(15, D('2026-08-12T00:00:00Z')))
      .toBe(nextCreditRefillOn(15, D('2026-08-12T23:59:59Z')))
  })
  it('clamps out-of-range anchors (0 → 1, 99 → 31)', () => {
    expect(nextCreditRefillOn(0, D('2026-08-05T00:00:00Z'))).toBe('2026-09-01')
    expect(nextCreditRefillOn(99, D('2026-08-05T00:00:00Z'))).toBe('2026-08-31')
  })
})

const member = (o: Partial<ClaimedMember> = {}): ClaimedMember => ({
  user_id: 'u1', cycle_on: '2026-08-15', lease_token: 'lt-1', claimed_tier: 'free', ...o,
})

describe('decideRefill — refill vs park from the DB-resolved claimed_tier (worker supplies no tier)', () => {
  it('a known claimed_tier → refill (no tier/amount echoed back)', () => {
    for (const t of ['free', 'professional', 'executive', 'founding']) {
      expect(decideRefill(member({ claimed_tier: t }))).toEqual({ action: 'refill' })
    }
  })
  it('an unknown claimed_tier → skip (park)', () => {
    expect(decideRefill(member({ claimed_tier: 'legacy_gold' }))).toEqual({ action: 'skip', reason: 'unknown_tier' })
  })
  it('a null claimed_tier (unresolved) → skip (park)', () => {
    expect(decideRefill(member({ claimed_tier: null }))).toEqual({ action: 'skip', reason: 'unknown_tier' })
  })
})

describe('effectiveCreditTier mirrors the app getEffectiveTier exactly', () => {
  const now = D('2026-08-20T00:00:00Z')
  const cases: any[] = [
    { is_founding_member: true },                                                                 // → founding
    { is_founding_member: true, founding_member_expires_at: '2099-01-01T00:00:00Z', subscription_tier: 'professional' }, // future → founding
    { is_founding_member: true, founding_member_expires_at: '2020-01-01T00:00:00Z', subscription_tier: 'professional' }, // expired → professional
    { is_founding_member: true, founding_member_expires_at: '2020-01-01T00:00:00Z' },              // expired, no sub → free
    { subscription_tier: 'executive' }, { subscription_tier: 'professional' },
    { subscription_tier: 'free' }, { subscription_tier: '' }, {}, { subscription_tier: 'legacy_gold' },
  ]
  for (const p of cases) {
    it(`matches getEffectiveTier for ${JSON.stringify(p)}`, () => {
      expect(effectiveCreditTier(p, now)).toBe(getEffectiveTier(p))
    })
  }
  it('active founding → 15, expired founding → its sub allowance', () => {
    expect(monthlyIncludedCredits(effectiveCreditTier({ is_founding_member: true }, now))).toBe(15)
    expect(monthlyIncludedCredits(effectiveCreditTier({ is_founding_member: true, founding_member_expires_at: '2020-01-01T00:00:00Z', subscription_tier: 'professional' }, now))).toBe(10)
  })
})

describe('describeMonthlyCredit — read-only admin status', () => {
  it('surfaces tier + allowance + next/last refill only', () => {
    const out = describeMonthlyCredit(
      { is_founding_member: true, founding_member_expires_at: null },
      { next_refill_on: '2026-09-15', last_refill_on: '2026-08-15' },
    )
    expect(out).toEqual({ effectiveTier: 'founding', includedAllowance: 15, nextRefillOn: '2026-09-15', lastRefillOn: '2026-08-15' })
  })
})
