import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadPoolHealth } from '@/lib/introductions/poolHealth'

/**
 * PHASE 3 STAGE 2B, COMMIT 4 — pool health tells the truth about who is reachable.
 *
 * Ordinary matching only ever offers same-community candidates: Stage 2A scopes the six
 * viewer-relative pools, Stage 2B partitions the weekly batch. `loadPoolHealth` mirrored the
 * ranker's exclusions but not its community rule, so once a Next member exists it would report a
 * Professional as having candidates the ranker will never offer them.
 *
 * This is DIAGNOSTIC CORRECTNESS. Nothing reads these numbers to decide anything — Stage 1's
 * database gates remain the authority for what may be created — but an operator reading
 * "50 candidates" when 30 are unreachable would draw the wrong conclusion about pool exhaustion.
 */

// ── a Supabase stub shaped like the one poolHealth actually uses ───────────────────────────────
const stub = (profiles: any[], intro: any[] = [], matches: any[] = [], blocks: any[] = []) => ({
  from(table: string) {
    const rows =
      table === 'profiles' ? profiles
      : table === 'intro_requests' ? intro
      : table === 'matches' ? matches
      : table === 'blocked_users' ? blocks
      : []
    const q: any = {
      select: () => q,
      // pageAll() pages with .range(); one full page then an empty one ends the scan.
      range: (from: number) => Promise.resolve({ data: from === 0 ? rows : [], error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: rows, error: null }).then(res, rej),
    }
    return q
  },
})

const member = (id: string, member_type: unknown, over: Record<string, unknown> = {}) => ({
  id,
  member_type,
  full_name: `M ${id}`,
  role_type: 'Founder',
  expertise: ['ai', 'saas'],
  company: `Co ${id}`,
  account_status: 'active',
  profile_complete: true,
  is_test_account: false,
  ...over,
})
const PRO = (id: string, over = {}) => member(id, 'professional', over)
const NEXT = (id: string, over = {}) => member(id, 'next', over)

/**
 * PoolHealthReport is an AGGREGATE — there is no per-member array on it. `smallestPools` is the
 * only per-member view it exposes, keyed by name, so the fixtures below are small enough to fit
 * inside its 10-row window and are read through it.
 */
const poolOf = async (profiles: any[], id: string) => {
  const report = await loadPoolHealth(stub(profiles))
  const row = report.smallestPools.find((r: any) => r.name === `M ${id}`)
  if (!row) throw new Error(`member ${id} not in smallestPools (fixture too large?)`)
  return row.pool
}
const reportFor = (profiles: any[]) => loadPoolHealth(stub(profiles))

describe('poolHealth counts only same-community candidates', () => {
  it('a Professional does not count Next members as available candidates', async () => {
    const profiles = [PRO('p1'), PRO('p2'), PRO('p3'), NEXT('n1'), NEXT('n2'), NEXT('n3')]
    // 3 Professionals total -> p1 can reach p2 and p3, and neither of the three Next members.
    expect(await poolOf(profiles, 'p1')).toBe(2)
  })

  it('a Next member does not count Professionals as available candidates', async () => {
    const profiles = [PRO('p1'), PRO('p2'), PRO('p3'), NEXT('n1'), NEXT('n2')]
    expect(await poolOf(profiles, 'n1')).toBe(1)   // only n2
  })

  it('same-community candidates still count, exactly as before', async () => {
    // The regression guard: scoping must not shrink a Professional-only network's numbers.
    const professionalOnly = Array.from({ length: 6 }, (_, i) => PRO(`p${i}`))
    expect(await poolOf(professionalOnly, 'p0')).toBe(5)
  })

  it('adding Next members does not change any Professional pool number', async () => {
    const pros = Array.from({ length: 5 }, (_, i) => PRO(`p${i}`))
    const before = await reportFor(pros)
    const after = await reportFor([...pros, ...Array.from({ length: 40 }, (_, i) => NEXT(`n${i}`))])
    // Every Professional still sees exactly the other four, however many Next members exist.
    expect(before.pool).toEqual({ avg: 4, min: 4, max: 4 })
    expect(after.smallestPools.filter((r: any) => r.name.startsWith('M p')).map((r: any) => r.pool))
      .toEqual([4, 4, 4, 4, 4])
  })

  it('an unknown or malformed community counts for NEITHER side', async () => {
    const profiles = [
      PRO('p1'), PRO('p2'),
      member('u1', null), member('u2', 'student'), member('u3', 'Professional'), member('u4', ''),
      NEXT('n1'), NEXT('n2'),
    ]
    expect(await poolOf(profiles, 'p1')).toBe(1)   // only p2
    expect(await poolOf(profiles, 'n1')).toBe(1)   // only n2
  })

  it('a member whose OWN community is unreadable reports an empty pool (fails closed)', async () => {
    const profiles = [member('u', null), PRO('p1'), PRO('p2'), NEXT('n1')]
    expect(await poolOf(profiles, 'u')).toBe(0)
  })

  it('same-company exclusion still applies within a community', async () => {
    // An unrelated pre-existing rule must survive untouched.
    const profiles = [PRO('p1', { company: 'Acme' }), PRO('p2', { company: 'Acme' }), PRO('p3')]
    expect(await poolOf(profiles, 'p1')).toBe(1)   // p3 only; p2 is a colleague
  })
})

describe('poolHealth: minimal change, shared rule, no exceptions', () => {
  const SRC = readFileSync('lib/introductions/poolHealth.ts', 'utf8')
  const code = SRC.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

  it('reuses the shared helper rather than redefining the rule', () => {
    expect(SRC).toMatch(/import \{[^}]*sameCommunity[^}]*\} from '@\/lib\/community\/memberType'/)
    expect(code).toContain('if (!sameCommunity(m, o)) continue')
    // No second definition of professional/next anywhere in this file.
    expect(code).not.toMatch(/'professional'|'next'|"professional"|"next"/)
  })

  it('loads member_type through the shared column constant', () => {
    expect(code).toContain('${MEMBER_TYPE_COLUMNS}')
  })

  it('adds no mentorship, recruiting or admin exception', () => {
    expect(code).not.toMatch(/open_to_next_mentorship|seeking_next_mentorship|recruit|bridge|bypass|allowCross/i)
  })

  it('leaves the file’s pre-existing quirks alone — this was not a cleanup', () => {
    // The audit flagged the hand-rolled eligibility and by-name exclusion as out of scope. They
    // must still be here, unchanged, or this commit did more than it was authorised to do.
    expect(code).toContain("(p.full_name || '').trim().toLowerCase() === 'daniel abramoff'")
    expect(code).not.toContain('applyMemberEligibility')
    expect(code).toContain('p.account_status === \'active\' && p.profile_complete && !p.is_test_account')
  })

  it('is diagnostics only — it writes nothing and gates nothing', () => {
    // Anchored on the CLIENT, because `.from(` alone also matches Array.from and `.delete(` also
    // matches Set.delete — both of which this file legitimately uses.
    expect(code).not.toMatch(/\badmin\.from\([^)]*\)[\s\S]{0,120}?\.(insert|update|upsert|delete)\(/)
    expect(code).not.toContain('rpc(')
  })
})
