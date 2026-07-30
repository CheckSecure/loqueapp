import { describe, it, expect } from 'vitest'
import { membersWithUnresolvedIntros } from '@/lib/introductions/queue'

const row = (requester_id: string, target_user_id: string, status: string) => ({ requester_id, target_user_id, status })

describe('membersWithUnresolvedIntros (availability-tier input)', () => {
  it('a suggested row with no expressed interest → member is unresolved', () => {
    expect(membersWithUnresolvedIntros([row('a', 'x', 'suggested')]).has('a')).toBe(true)
  })

  it('a suggestion resolved by expressed interest → NOT unresolved (all express statuses)', () => {
    for (const st of ['pending', 'accepted', 'accepted_pending_payment', 'admin_pending', 'approved']) {
      const s = membersWithUnresolvedIntros([row('a', 'x', 'suggested'), row('a', 'x', st)])
      expect(s.has('a')).toBe(false)
    }
  })

  it('partially resolved (one suggestion still open) → still unresolved', () => {
    const s = membersWithUnresolvedIntros([
      row('a', 'x', 'suggested'), row('a', 'x', 'approved'), // x resolved
      row('a', 'y', 'suggested'),                            // y still open
    ])
    expect(s.has('a')).toBe(true)
  })

  it('non-suggested statuses alone never make a member unresolved', () => {
    for (const st of ['queued', 'passed', 'archived', 'accepted', 'declined']) {
      expect(membersWithUnresolvedIntros([row('a', 'x', st)]).has('a')).toBe(false)
    }
  })

  it('tracks members independently', () => {
    const s = membersWithUnresolvedIntros([
      row('a', 'x', 'suggested'),                          // a open
      row('b', 'y', 'suggested'), row('b', 'y', 'approved'), // b resolved
    ])
    expect(s.has('a')).toBe(true)
    expect(s.has('b')).toBe(false)
  })

  it('empty / null input → empty set', () => {
    expect(membersWithUnresolvedIntros([]).size).toBe(0)
    expect(membersWithUnresolvedIntros(null).size).toBe(0)
  })
})
