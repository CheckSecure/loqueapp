import { describe, it, expect } from 'vitest'
import { excludeTestAccounts, isMemberFacingEligible } from '@/lib/testAccounts'

/** Fake query builder that records the .not() filters applied. */
function makeFakeQuery() {
  const nots: Array<[string, string, unknown]> = []
  const q: any = { not(col: string, op: string, val: unknown) { nots.push([col, op, val]); return q } }
  return { q, nots }
}

describe('excludeTestAccounts — query filter', () => {
  it('applies exactly `is_test_account IS NOT TRUE`', () => {
    const { q, nots } = makeFakeQuery()
    const returned = excludeTestAccounts(q)
    expect(returned).toBe(q) // chainable — returns the same builder
    expect(nots).toContainEqual(['is_test_account', 'is', true])
  })
})

describe('isMemberFacingEligible — predicate mirrors the DB filter', () => {
  it('a normal member (flag false / null / undefined) is eligible', () => {
    expect(isMemberFacingEligible({ is_test_account: false })).toBe(true)
    expect(isMemberFacingEligible({ is_test_account: null })).toBe(true)
    expect(isMemberFacingEligible({})).toBe(true)
  })
  it('a test account is NOT eligible', () => {
    expect(isMemberFacingEligible({ is_test_account: true })).toBe(false)
  })
  it('null/undefined profile is not eligible (defensive)', () => {
    expect(isMemberFacingEligible(null)).toBe(false)
    expect(isMemberFacingEligible(undefined)).toBe(false)
  })
})

/**
 * The DB applies `is_test_account IS NOT TRUE` on top of each pool's existing
 * gates. These tests reproduce that composition for every member-facing surface
 * and prove a QA account is dropped even when it is otherwise fully eligible
 * (active + profile_complete + open_to_* + recruiter), while real members are
 * unaffected.
 */
const REAL = { id: 'real', account_status: 'active', profile_complete: true, open_to_roles: true, open_to_business_solutions: true, recruiter: true, is_test_account: false }
const QA = { ...REAL, id: 'qa', is_test_account: true } // identical eligibility EXCEPT the flag

const poolFilter = (rows: any[], gate: (r: any) => boolean) =>
  rows.filter((r) => gate(r) && isMemberFacingEligible(r))

describe('member-facing pools exclude test accounts (even when otherwise eligible)', () => {
  const rows = [REAL, QA]

  it('recommendations candidate pool (active + complete)', () => {
    const ids = poolFilter(rows, (r) => r.account_status === 'active' && r.profile_complete).map((r) => r.id)
    expect(ids).toEqual(['real'])
  })
  it('opportunities — hiring (open_to_roles)', () => {
    const ids = poolFilter(rows, (r) => r.open_to_roles && r.account_status === 'active' && r.profile_complete).map((r) => r.id)
    expect(ids).toEqual(['real'])
  })
  it('opportunities — business (open_to_business_solutions)', () => {
    const ids = poolFilter(rows, (r) => r.open_to_business_solutions && r.account_status === 'active' && r.profile_complete).map((r) => r.id)
    expect(ids).toEqual(['real'])
  })
  it('opportunities — recruiter', () => {
    const ids = poolFilter(rows, (r) => r.recruiter && r.account_status === 'active' && r.profile_complete).map((r) => r.id)
    expect(ids).toEqual(['real'])
  })
  it('introduction batches / cron recipients (active + complete)', () => {
    const ids = poolFilter(rows, (r) => r.account_status === 'active' && r.profile_complete).map((r) => r.id)
    expect(ids).toEqual(['real'])
  })
  it('daily digest (any profile with an email)', () => {
    const ids = poolFilter([{ ...REAL, email: 'a@x.com' }, { ...QA, email: 'qa@x.com' }], () => true).map((r) => r.id)
    expect(ids).toEqual(['real'])
  })

  it('real-member behavior is unchanged — a real active+complete member is always kept', () => {
    for (const gate of [
      (r: any) => r.account_status === 'active' && r.profile_complete,
      (r: any) => r.open_to_roles && r.account_status === 'active' && r.profile_complete,
      (r: any) => r.recruiter && r.account_status === 'active' && r.profile_complete,
    ]) {
      expect(poolFilter([REAL], gate)).toEqual([REAL])
    }
  })
})
