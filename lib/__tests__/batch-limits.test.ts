import { describe, it, expect } from 'vitest'
import { perRecipientIntroLimit, suggestionCountsTowardLimit, enforceRecipientLimits } from '@/lib/matching/batch-limits'
import { BATCH_CONFIG, effectiveTierDistribution } from '@/lib/matching/batch-scoring'

describe('perRecipientIntroLimit (launch-cap aware)', () => {
  it('equals the tier total after the launch cap, for every tier', () => {
    for (const tier of ['free', 'professional', 'executive', undefined, 'nonsense']) {
      expect(perRecipientIntroLimit(tier)).toBe(effectiveTierDistribution(tier).total)
    }
  })
  it('honors the launch cap: no tier exceeds introductionsPerMemberCap when set', () => {
    const cap = BATCH_CONFIG.introductionsPerMemberCap
    if (cap != null) {
      for (const tier of ['free', 'professional', 'executive']) {
        expect(perRecipientIntroLimit(tier)).toBeLessThanOrEqual(cap)
      }
    }
  })
  it('launch phase: default is 2 introductions per member (all tiers)', () => {
    expect(BATCH_CONFIG.introductionsPerMemberCap).toBe(2)
    expect(perRecipientIntroLimit('free')).toBe(2)
    expect(perRecipientIntroLimit('executive')).toBe(2)
  })
})

describe('suggestionCountsTowardLimit', () => {
  it('dropped / hidden_permanent free a slot; every other status counts', () => {
    expect(suggestionCountsTowardLimit('dropped')).toBe(false)
    expect(suggestionCountsTowardLimit('hidden_permanent')).toBe(false)
    for (const s of ['generated', 'shown', 'active', 'accepted', 'passed']) {
      expect(suggestionCountsTowardLimit(s)).toBe(true)
    }
  })
})

describe('enforceRecipientLimits — final invariant', () => {
  const rows = (rid: string, n: number) => Array.from({ length: n }, (_, i) => ({ recipient_id: rid, i }))

  it('a fresh batch never exceeds the limit (trims excess, keeps first/best)', () => {
    const input = rows('free-1', 5) // 5 offered, limit 3
    const { kept, dropped } = enforceRecipientLimits(input, () => 3)
    expect(kept).toHaveLength(3)
    expect(kept.map((r: any) => r.i)).toEqual([0, 1, 2]) // priority order preserved
    expect(dropped['free-1']).toBe(2)
  })

  it('accounts for EXISTING live suggestions (the replacements bug scenario)', () => {
    // Recipient already has 2 live suggestions; limit 3 → only 1 new may be added.
    const input = rows('r', 4)
    const { kept, dropped } = enforceRecipientLimits(input, () => 3, () => 2)
    expect(kept).toHaveLength(1)
    expect(dropped['r']).toBe(3)
  })

  it('never adds when the recipient is already at/over the limit', () => {
    const { kept, dropped } = enforceRecipientLimits(rows('r', 3), () => 3, () => 3)
    expect(kept).toHaveLength(0)
    expect(dropped['r']).toBe(3)
  })

  it('is per-recipient and independent; different tiers get different limits', () => {
    const input = [...rows('free', 4), ...rows('exec', 10)]
    const { kept } = enforceRecipientLimits(input, (rid) => (rid === 'exec' ? 8 : 3))
    expect(kept.filter((r: any) => r.recipient_id === 'free')).toHaveLength(3)
    expect(kept.filter((r: any) => r.recipient_id === 'exec')).toHaveLength(8)
  })

  it('no trimming when everything fits', () => {
    const { kept, dropped } = enforceRecipientLimits(rows('r', 2), () => 3)
    expect(kept).toHaveLength(2)
    expect(dropped).toEqual({})
  })
})
