import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isEligibleMember, filterEligible, applyMemberEligibility, ELIGIBILITY_COLUMNS, ADMIN_EMAIL, assertAllEligible, eligibilityExclusionReason } from '@/lib/matching/eligibility'
import { buildScoringContext } from '@/lib/matching/batch-scoring'

const realMember = { account_status: 'active', profile_complete: true, is_test_account: false, is_admin: false, email: 'jane@x.com' }

describe('isEligibleMember — canonical predicate', () => {
  it('accepts a real, active, complete, non-test, non-admin member', () => {
    expect(isEligibleMember(realMember)).toBe(true)
  })
  it('rejects every excluded class', () => {
    expect(isEligibleMember({ ...realMember, is_test_account: true })).toBe(false)   // test/demo/seed/fake
    expect(isEligibleMember({ ...realMember, is_admin: true })).toBe(false)           // internal/admin
    expect(isEligibleMember({ ...realMember, email: ADMIN_EMAIL })).toBe(false)       // admin by email
    expect(isEligibleMember({ ...realMember, account_status: 'suspended' })).toBe(false)
    expect(isEligibleMember({ ...realMember, account_status: 'deactivated' })).toBe(false)
    expect(isEligibleMember({ ...realMember, account_status: 'deleted' })).toBe(false)
    expect(isEligibleMember({ ...realMember, profile_complete: false })).toBe(false)  // incomplete onboarding
    expect(isEligibleMember({ ...realMember, matching_paused: true })).toBe(false)    // participation paused (migration 019)
    expect(isEligibleMember(null)).toBe(false)
    expect(isEligibleMember(undefined)).toBe(false)
  })
  it('is strict: unknown account_status or missing flags are excluded, not included', () => {
    expect(isEligibleMember({ profile_complete: true, is_test_account: false })).toBe(false) // no account_status
    expect(isEligibleMember({ account_status: 'active', is_test_account: false })).toBe(false) // not complete
  })
})

describe('filterEligible', () => {
  it('removes every excluded account from a mixed list', () => {
    const list = [
      realMember,
      { ...realMember, id: 't', is_test_account: true },
      { ...realMember, id: 'a', is_admin: true },
      { ...realMember, id: 's', account_status: 'suspended' },
      { ...realMember, id: 'i', profile_complete: false },
    ]
    const out = filterEligible(list as any)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(realMember)
  })
  it('handles null/empty', () => {
    expect(filterEligible(null)).toEqual([])
    expect(filterEligible([])).toEqual([])
  })
})

describe('applyMemberEligibility — DB query filter', () => {
  it('adds exactly the canonical exclusions to the query', () => {
    const calls: string[] = []
    const qb: any = {
      eq: (c: string, v: any) => { calls.push(`eq:${c}=${v}`); return qb },
      neq: (c: string, v: any) => { calls.push(`neq:${c}!=${v}`); return qb },
      not: (c: string, op: string, v: any) => { calls.push(`not:${c} ${op} ${v}`); return qb },
    }
    applyMemberEligibility(qb)
    expect(calls).toContain('eq:account_status=active')
    expect(calls).toContain('eq:profile_complete=true')
    expect(calls).toContain('not:is_test_account is true')
    expect(calls).toContain('not:is_admin is true')
    expect(calls).toContain('not:matching_paused is true')
    expect(calls).toContain(`neq:email!=${ADMIN_EMAIL}`)
  })
  it('ELIGIBILITY_COLUMNS lists the columns the in-memory re-check needs', () => {
    for (const col of ['account_status', 'profile_complete', 'is_test_account', 'is_admin', 'email']) {
      expect(ELIGIBILITY_COLUMNS).toContain(col)
    }
  })
})

describe('fail-fast: excluded account reaching scoring aborts loudly', () => {
  const bad = { id: 'u-99', email: 'sneaky@x.com', account_status: 'active', profile_complete: true, is_test_account: true, is_admin: false, purposes: ['networking'] }

  it('eligibilityExclusionReason pinpoints the reason for each excluded class', () => {
    expect(eligibilityExclusionReason({ id: 'x', is_test_account: true })).toBe('test_account')
    expect(eligibilityExclusionReason({ id: 'x', is_admin: true })).toBe('admin_account')
    expect(eligibilityExclusionReason({ id: 'x', email: ADMIN_EMAIL })).toBe('admin_email')
    expect(eligibilityExclusionReason({ id: 'x', matching_paused: true })).toBe('matching_paused')
    expect(eligibilityExclusionReason({ id: 'x', account_status: 'suspended' })).toBe('inactive_status:suspended')
    expect(eligibilityExclusionReason({ id: 'x', profile_complete: false })).toBe('incomplete_onboarding')
    expect(eligibilityExclusionReason({ id: 'x', account_status: 'active', profile_complete: true })).toBeNull()
  })

  it('assertAllEligible throws a descriptive error naming id, email, reason, and code path', () => {
    expect(() => assertAllEligible([bad], 'unit-test-path')).toThrow(/id=u-99/)
    expect(() => assertAllEligible([bad], 'unit-test-path')).toThrow(/email=sneaky@x.com/)
    expect(() => assertAllEligible([bad], 'unit-test-path')).toThrow(/reason=test_account/)
    expect(() => assertAllEligible([bad], 'unit-test-path')).toThrow(/unit-test-path/)
  })

  it('does not throw for an all-eligible pool', () => {
    expect(() => assertAllEligible([{ id: '1', account_status: 'active', profile_complete: true, is_test_account: false, is_admin: false, email: 'a@x.com' }], 'p')).not.toThrow()
    expect(() => assertAllEligible([], 'p')).not.toThrow()
  })

  it('buildScoringContext (the scoring choke point) ABORTS if any excluded account is present — cannot be bypassed', () => {
    const pool = [
      { id: '1', account_status: 'active', profile_complete: true, is_test_account: false, is_admin: false, email: 'a@x.com', purposes: ['networking'] },
      bad, // slipped past a hypothetical missing filter
    ]
    expect(() => buildScoringContext(pool, undefined, 'generate-batch')).toThrow(/eligibility:fail-fast/)
    expect(() => buildScoringContext(pool, undefined, 'generate-batch')).toThrow(/reason=test_account/)
    expect(() => buildScoringContext(pool, undefined, 'generate-batch')).toThrow(/generate-batch/)
  })

  it('catches every excluded class at the scoring boundary', () => {
    const base = { id: 'b', account_status: 'active', profile_complete: true, is_test_account: false, is_admin: false, email: 'b@x.com' }
    for (const mut of [{ is_test_account: true }, { is_admin: true }, { email: ADMIN_EMAIL }, { account_status: 'deleted' }, { profile_complete: false }]) {
      expect(() => buildScoringContext([{ ...base, ...mut }], undefined, 'p')).toThrow(/fail-fast/)
    }
  })
})

describe('every recommendation path shares the canonical filter + fail-fast', () => {
  const paths: [string, string][] = [
    ['app/api/admin/generate-batch/route.ts', 'generate-batch'],
    ['app/api/admin/batch/[batchId]/generate-replacements/route.ts', 'generate-replacements'],
    ['lib/generate-recommendations.ts', 'generate-recommendations'],
    ['app/api/admin/simulate-matches/route.ts', 'simulate-matches'],
    ['lib/opportunities/matching.ts', ''],
  ]
  it('every path applies the canonical DB filter', () => {
    for (const [f] of paths) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).toContain('applyMemberEligibility')
    }
  })
  it('every scoring path runs the fail-fast before scoring (directly or via buildScoringContext)', () => {
    for (const [f, codePath] of paths) {
      if (!codePath) continue // opportunities: filter-only surface, no batch scoring
      const src = readFileSync(f, 'utf8')
      const wired = src.includes(`assertAllEligible(`) || src.includes('buildScoringContext(')
      expect(wired, `${f} must fail-fast before scoring`).toBe(true)
      if (src.includes('assertAllEligible(')) expect(src, f).toContain(`'${codePath}'`)
    }
  })
})

describe('excluded accounts cannot influence scoring / rarity / IDF', () => {
  it('a test account with extreme purposes does not shift rarity once filtered', () => {
    const real = [
      { id: '1', purposes: ['networking'], interests: [] },
      { id: '2', purposes: ['networking'], interests: [] },
      { id: '3', purposes: ['fundraising'], interests: [] },
    ].map(m => ({ ...m, ...realMember }))
    const withTest = [...real, { id: 'test', purposes: ['fundraising', 'fundraising'], interests: [], account_status: 'active', profile_complete: true, is_test_account: true, is_admin: false, email: 't@x.com' }]

    const ctxClean = buildScoringContext(real)
    const ctxFiltered = buildScoringContext(filterEligible(withTest as any))
    // Filtering the test account out yields IDENTICAL rarity factors → no influence.
    expect(Array.from(ctxFiltered.purposeRarity.entries())).toEqual(Array.from(ctxClean.purposeRarity.entries()))
    expect(ctxFiltered.memberCount).toBe(real.length)
  })
})
