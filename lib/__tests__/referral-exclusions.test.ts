import { describe, it, expect } from 'vitest'
import { toReferralArray } from '@/lib/referrals/exclusions'

// Regression tests for the getReferralExclusionsForUser input normalization.
// The embedded PostgREST referrals relationship can be an array, a single object,
// or null — all must normalize to an array so downstream .filter never crashes.
describe('toReferralArray — referral input normalization', () => {
  const ref = (id: string, status: string) => ({ referrer_user_id: id, status })

  it('multiple inbound referrals (array) → used as-is', () => {
    const rows = [ref('a', 'pending'), ref('b', 'activated')]
    const out = toReferralArray(rows)
    expect(out).toBe(rows)
    expect(out).toHaveLength(2)
    // downstream .filter must work
    expect(out.filter((r) => r.status === 'activated')).toHaveLength(1)
  })

  it('one inbound referral (single object) → wrapped in an array', () => {
    const single = ref('a', 'invited')
    const out = toReferralArray(single)
    expect(Array.isArray(out)).toBe(true)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(single)
    // this is exactly the case that used to crash (.filter on an object)
    expect(() => out.filter((r) => r.status === 'invited')).not.toThrow()
    expect(out.filter((r) => r.status === 'invited')).toHaveLength(1)
  })

  it('no referrals (null) → empty array', () => {
    expect(toReferralArray(null)).toEqual([])
    expect(toReferralArray(undefined)).toEqual([])
    expect(() => toReferralArray(null).filter(Boolean)).not.toThrow()
  })
})
