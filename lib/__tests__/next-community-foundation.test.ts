import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * ANDREL NEXT — PHASE 2 FOUNDATION.
 *
 * Two things are under test, and they are tested differently on purpose.
 *
 * 1. THE TYPESCRIPT MIRROR (`lib/community/memberType.ts`) is executed directly. It is pure, so its
 *    fail-closed behaviour can be proven rather than argued.
 *
 * 2. THE DATABASE CONTRACT (migration 095) cannot be executed here — there is no Postgres in this
 *    suite, and the project applies migrations by hand. So the migration's TEXT is asserted against,
 *    which pins the properties a reviewer would otherwise have to re-derive by reading SQL: that the
 *    column is NOT NULL DEFAULT 'professional', that the CHECK exists, that the mentorship flags
 *    default false, that the predicate is SECURITY DEFINER with a pinned search_path, that EXECUTE
 *    is revoked from browser roles, and that no grant on public.profiles is touched.
 *
 *    A text assertion is weaker than an execution, and this file says so rather than implying
 *    otherwise. The migration carries its own in-transaction postcondition block (Section 5) which
 *    IS an execution test — it runs at apply time and rolls the whole migration back on any
 *    violation. These tests catch a bad edit before it is ever applied; the postconditions catch a
 *    bad outcome at the moment of applying.
 */

const MIGRATION = readFileSync('supabase/migrations/095_member_community_foundation.sql', 'utf8')

import {
  MEMBER_TYPES,
  DEFAULT_MEMBER_TYPE,
  isMemberType,
  communityOf,
  isNextMember,
  isProfessionalMember,
  sameCommunity,
} from '@/lib/community/memberType'

const pro = { member_type: 'professional' }
const next = { member_type: 'next' }

// ── 1. Community identity ─────────────────────────────────────────────────────────────────────
describe('member_type: existing members are professional by construction', () => {
  it('the column is NOT NULL and defaults to professional, so no backfill can half-run', () => {
    expect(MIGRATION).toMatch(
      /ADD COLUMN IF NOT EXISTS member_type text NOT NULL DEFAULT 'professional'/,
    )
  })

  it('the default is the same value the TypeScript layer calls default', () => {
    expect(DEFAULT_MEMBER_TYPE).toBe('professional')
    expect(MIGRATION).toContain("DEFAULT 'professional'")
  })

  it('a CHECK constraint — not a bare text column — restricts the allowed values', () => {
    expect(MIGRATION).toMatch(/CONSTRAINT profiles_member_type_check\s+CHECK \(member_type IN \('professional', 'next'\)\)/)
  })

  it('the two allowed values are exactly professional and next', () => {
    expect([...MEMBER_TYPES]).toEqual(['professional', 'next'])
  })

  it('a NULL member_type is impossible, and the postcondition proves it after apply', () => {
    expect(MIGRATION).toMatch(/profiles\.member_type is not NOT NULL/)
    expect(MIGRATION).toMatch(/member_type IS NULL OR member_type NOT IN \('professional', 'next'\)/)
  })

  it('rejects an invalid member_type in the TypeScript mirror too', () => {
    for (const bad of ['student', 'Professional', 'PROFESSIONAL', '', ' next', null, undefined, 3, {}]) {
      expect(isMemberType(bad)).toBe(false)
    }
    expect(isMemberType('professional')).toBe(true)
    expect(isMemberType('next')).toBe(true)
  })

  it('does NOT create a separate students table or duplicate profiles', () => {
    expect(MIGRATION).not.toMatch(/CREATE TABLE/i)
  })
})

// ── 2. Mentorship flags ───────────────────────────────────────────────────────────────────────
describe('Next mentorship flags default safely OFF', () => {
  it('open_to_next_mentorship is NOT NULL DEFAULT false', () => {
    expect(MIGRATION).toMatch(
      /ADD COLUMN IF NOT EXISTS open_to_next_mentorship boolean NOT NULL DEFAULT false/,
    )
  })

  it('seeking_next_mentorship is NOT NULL DEFAULT false', () => {
    expect(MIGRATION).toMatch(
      /ADD COLUMN IF NOT EXISTS seeking_next_mentorship boolean NOT NULL DEFAULT false/,
    )
  })

  it('the apply-time postcondition refuses if anyone is already opted in', () => {
    expect(MIGRATION).toMatch(/a member is already opted in to Next mentorship/)
  })

  it('grad_year is nullable with a sanity range, not a free integer', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS grad_year smallint/)
    expect(MIGRATION).toMatch(/grad_year IS NULL OR \(grad_year BETWEEN 1950 AND 2100\)/)
  })
})

// ── 3. The existing professional mentorship semantics are untouched ───────────────────────────
describe('existing open_to_mentorship semantics are NOT reused or altered', () => {
  it('095 never writes to, alters or drops open_to_mentorship or mentorship_role', () => {
    // It may NAME them in commentary explaining why they are not reused; it must not modify them.
    const statements = MIGRATION
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
    expect(statements).not.toMatch(/ALTER COLUMN open_to_mentorship/)
    expect(statements).not.toMatch(/DROP COLUMN open_to_mentorship/)
    expect(statements).not.toMatch(/UPDATE public\.profiles/)
    expect(statements).not.toMatch(/ALTER COLUMN mentorship_role/)
  })

  it('the Next mentor flag is a DIFFERENT column from open_to_mentorship', () => {
    expect(MIGRATION).toContain('open_to_next_mentorship')
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS open_to_next_mentorship/)
    // and the old column is never added/redefined here
    expect(MIGRATION).not.toMatch(/ADD COLUMN IF NOT EXISTS open_to_mentorship\b/)
  })

  it('the professional matcher still reads the ORIGINAL flag, unchanged', () => {
    const gen = readFileSync('lib/generate-recommendations.ts', 'utf8')
    expect(gen).toContain('userProfile.open_to_mentorship')
    expect(gen).not.toContain('open_to_next_mentorship')   // Phase 2 adds no matcher behaviour
  })
})

// ── 4. The pair predicate ─────────────────────────────────────────────────────────────────────
describe('community_pair_allowed — the base rule', () => {
  it('is created with both member ids and returns boolean', () => {
    expect(MIGRATION).toMatch(
      /CREATE OR REPLACE FUNCTION public\.community_pair_allowed\(member_one uuid, member_two uuid\)/,
    )
    expect(MIGRATION).toMatch(/RETURNS boolean/)
  })

  it('encodes same-community-only: both types valid AND equal', () => {
    expect(MIGRATION).toMatch(/a\.member_type IN \('professional', 'next'\)/)
    expect(MIGRATION).toMatch(/b\.member_type IN \('professional', 'next'\)/)
    expect(MIGRATION).toMatch(/a\.member_type = b\.member_type/)
  })

  it('fails closed: NULL ids, self-pairing, and a NULL result are all impossible', () => {
    expect(MIGRATION).toMatch(/member_one IS NOT NULL/)
    expect(MIGRATION).toMatch(/member_two IS NOT NULL/)
    expect(MIGRATION).toMatch(/member_one <> member_two/)
    expect(MIGRATION).toMatch(/COALESCE\(/)             // never returns NULL
  })

  it('contains NO mentorship exception — the bridge must not live in the default rule', () => {
    // The FUNCTION BODY only: between `AS $$` and the closing `$$;`. The surrounding COMMENT ON
    // deliberately discusses mentorship (to record why it is absent), so asserting over the whole
    // statement would test the prose rather than the logic.
    const start = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.community_pair_allowed')
    const bodyStart = MIGRATION.indexOf('AS $$', start) + 'AS $$'.length
    const bodyEnd = MIGRATION.indexOf('$$;', bodyStart)
    const body = MIGRATION.slice(bodyStart, bodyEnd)
    expect(body.length).toBeGreaterThan(50)
    expect(body).not.toContain('mentorship')
    expect(body).not.toContain('open_to_next_mentorship')
    expect(body).not.toContain('seeking_next_mentorship')
  })
})

describe('community_pair_allowed — security model', () => {
  it('is SECURITY DEFINER with a pinned empty search_path', () => {
    expect(MIGRATION).toMatch(/SECURITY DEFINER/)
    expect(MIGRATION).toMatch(/SET search_path = ''/)
  })

  it('EXECUTE is revoked from every browser role and granted only to service_role', () => {
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION public\.community_pair_allowed\(uuid, uuid\) FROM PUBLIC/)
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION public\.community_pair_allowed\(uuid, uuid\) FROM anon/)
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION public\.community_pair_allowed\(uuid, uuid\) FROM authenticated/)
    expect(MIGRATION).toMatch(/GRANT EXECUTE ON FUNCTION public\.community_pair_allowed\(uuid, uuid\) TO service_role/)
  })

  it('the apply-time postcondition re-proves the ACL rather than trusting the GRANT ran', () => {
    expect(MIGRATION).toMatch(/a browser role can EXECUTE community_pair_allowed/)
    expect(MIGRATION).toMatch(/service_role cannot EXECUTE community_pair_allowed/)
  })

  it('returns only a boolean — it can never be used to read a profile field', () => {
    const fn = MIGRATION.slice(
      MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.community_pair_allowed'),
      MIGRATION.indexOf('REVOKE ALL ON FUNCTION public.community_pair_allowed'),
    )
    expect(fn).toMatch(/SELECT 1\s+FROM public\.profiles/)   // existence only, no columns projected
    expect(fn).not.toMatch(/SELECT\s+a\.(full_name|email|company|title)/)
  })
})

// ── 5. Profile privacy is not weakened ────────────────────────────────────────────────────────
describe('095 does not weaken the 057/058 profile privacy contract', () => {
  it('introduces NO grant of any kind to a browser role on any table', () => {
    expect(MIGRATION).not.toMatch(/GRANT[^;]*ON TABLE[^;]*TO (anon|authenticated|PUBLIC)/i)
    expect(MIGRATION).not.toMatch(/GRANT SELECT[^;]*public\.profiles/i)
  })

  it('the only GRANT in the file is EXECUTE to service_role', () => {
    const grants = MIGRATION.split('\n').filter((l) => /^\s*GRANT\b/i.test(l))
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatch(/GRANT EXECUTE ON FUNCTION public\.community_pair_allowed\(uuid, uuid\) TO service_role;/)
  })

  it('asserts at apply time that no browser role holds SELECT on profiles', () => {
    expect(MIGRATION).toMatch(/has_table_privilege\('anon', 'public\.profiles', 'SELECT'\)/)
    expect(MIGRATION).toMatch(/has_table_privilege\('authenticated', 'public\.profiles', 'SELECT'\)/)
    expect(MIGRATION).toMatch(/migration 058''s contract is broken/)
  })

  it('does not MODIFY can_discover_profile or public_profiles', () => {
    // Naming them in commentary is fine and useful — the invariant is that no statement targets
    // them. Strip comment lines, then assert no DDL mentions either object.
    const statements = MIGRATION
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
    expect(statements).not.toMatch(/(CREATE|DROP|ALTER|REPLACE)[^;]*can_discover_profile/i)
    expect(statements).not.toMatch(/(CREATE|DROP|ALTER|REPLACE)[^;]*public_profiles/i)
  })

  it('can_discover_profile on disk is still the migration-079 definition', () => {
    const m079 = readFileSync('supabase/migrations/079_discovery_requires_complete_profile.sql', 'utf8')
    expect(m079).toContain('CREATE OR REPLACE FUNCTION public.can_discover_profile(member_id uuid)')
    // 095 is the newest migration and does not redefine it
    expect(MIGRATION).not.toMatch(/FUNCTION public\.can_discover_profile/)
  })
})

// ── 6. The TypeScript mirror: fail-closed behaviour ───────────────────────────────────────────
describe('sameCommunity — the in-memory mirror of the base rule', () => {
  it('professional + professional -> allowed', () => {
    expect(sameCommunity(pro, pro)).toBe(true)
  })

  it('next + next -> allowed', () => {
    expect(sameCommunity(next, next)).toBe(true)
  })

  it('professional + next -> denied', () => {
    expect(sameCommunity(pro, next)).toBe(false)
  })

  it('next + professional -> denied (order carries no meaning)', () => {
    expect(sameCommunity(next, pro)).toBe(false)
  })

  it('a missing member fails closed', () => {
    expect(sameCommunity(null, pro)).toBe(false)
    expect(sameCommunity(pro, null)).toBe(false)
    expect(sameCommunity(undefined, undefined)).toBe(false)
  })

  it('an absent or unrecognised member_type fails closed — never defaults to professional', () => {
    expect(sameCommunity({}, pro)).toBe(false)
    expect(sameCommunity({ member_type: null }, pro)).toBe(false)
    expect(sameCommunity({ member_type: 'student' }, pro)).toBe(false)
    expect(sameCommunity({ member_type: 'student' }, { member_type: 'student' })).toBe(false)
  })

  it('communityOf returns null rather than guessing', () => {
    expect(communityOf(pro)).toBe('professional')
    expect(communityOf(next)).toBe('next')
    expect(communityOf({})).toBeNull()
    expect(communityOf(null)).toBeNull()
    expect(communityOf({ member_type: 'PROFESSIONAL' })).toBeNull()
  })

  it('the predicates agree with communityOf and fail closed', () => {
    expect(isProfessionalMember(pro)).toBe(true)
    expect(isNextMember(next)).toBe(true)
    expect(isProfessionalMember(next)).toBe(false)
    expect(isNextMember(pro)).toBe(false)
    expect(isProfessionalMember({})).toBe(false)
    expect(isNextMember({})).toBe(false)
  })

  it('has no mentorship exception, matching the SQL predicate', () => {
    // Bounded to sameCommunity's OWN body, and to executable lines. The whole-file-tail version of
    // this check started failing in Phase 3 Stage 2A for a reason that is the opposite of a
    // regression: filterSameCommunity was added below it, and its doc comment says in so many words
    // that the ordinary pool rule has no mentorship exception. Asserting over prose meant the
    // documentation of the rule broke the test for the rule.
    const src = readFileSync('lib/community/memberType.ts', 'utf8')
    const from = src.indexOf('export function sameCommunity')
    const body = src.slice(from, src.indexOf('\n}', from))
    const code = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toContain('mentorship')
    // And the same guarantee for the Stage 2A pool filter, which is the other place a bridge could
    // be smuggled into the ordinary rule.
    const f2 = src.indexOf('export function filterSameCommunity')
    const code2 = src.slice(f2, src.indexOf('\n}', f2)).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code2).not.toContain('mentorship')
  })
})

// ── 7. What Phase 2 left inert, and what Stage 1b deliberately switched on ───────────────────
//
// This block ORIGINALLY asserted that NOTHING read member_type — the correct invariant for Phase 2,
// whose whole point was to add the column and change no behaviour. Phase 3 Stage 1b is the change
// that ends it: the relationship writers now consult the boundary, which is the entire deliverable.
//
// It is rewritten rather than deleted, because the useful half of the original assertion survives
// and is arguably more important now: the pool/scoring layer must STILL be inert, since candidate-
// pool scoping is Stage 2 and has not been authorized. A test that quietly went away here would
// stop noticing if Stage 2 work leaked into Stage 1b.
describe('Stage 2 is still inert: pool and scoring code does not read the new columns', () => {
  it('no matching, scoring or eligibility code references member_type yet', () => {
    for (const f of [
      'lib/generate-recommendations.ts',
      'lib/matching/eligibility.ts',
      'lib/matching/batch-scoring.ts',
      'lib/opportunities/matching.ts',
      'app/api/admin/generate-batch/route.ts',
    ]) {
      const src = readFileSync(f, 'utf8')
      const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
      expect(code, `${f} must not scope candidate pools before Stage 2`).not.toMatch(/member_type/)
      expect(code, `${f} must not consume the pair predicate before Stage 2`).not.toMatch(/community_pair_allowed/)
    }
  })

  it('the relationship writers DO consult the boundary now — that is Stage 1b', () => {
    // The inverse of the assertion above, kept in the same file so the two cannot drift apart and
    // leave the codebase in a state where neither layer checks anything.
    const consults = (f: string) => {
      const src = readFileSync(f, 'utf8')
      return /checkPairCommunity|create_gated_match|createGatedMatch|createSupportMatch/.test(src)
    }
    for (const f of [
      'lib/introRequests/createAdminIntroPair.ts',
      'app/api/intro-requests/accept-incoming/route.ts',
      'lib/opportunities/connect.ts',
      'lib/onboarding/welcomeFromAdmin.ts',
    ]) {
      expect(consults(f), `${f} must consult the community boundary after Stage 1b`).toBe(true)
    }
  })

  it('finalizeMutualMatch is UNCHANGED — its gate is the SQL layer, not a TypeScript check', () => {
    // Stage 1a proved finalize_mutual_match_atomic returns outcome 'invalid' / detail
    // 'cross_community', and this file already maps 'invalid' to a 409. Adding a TypeScript check
    // here would duplicate the SQL predicate in a second place that could drift from it.
    const src = readFileSync('lib/introductions/finalizeMutualMatch.ts', 'utf8')
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    expect(code).not.toMatch(/member_type|community_pair_allowed|checkPairCommunity/)
    expect(code).toMatch(/outcome === 'invalid'/)
  })

  it('the migration is registered so Phase 3 cannot deploy ahead of the schema', () => {
    const health = readFileSync('lib/db/migrationHealth.ts', 'utf8')
    expect(health).toContain('095_member_community_foundation.sql')
    expect(health).toContain("column: 'member_type'")
  })
})
