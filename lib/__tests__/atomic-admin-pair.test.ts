import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { toUndirectedPairs, isDeferrable, TERMINAL_OUTCOMES, canonicalApprovalOrder } from '@/lib/introductions/materializeAdminPair'
import { legalSameSidePenalty, LEGAL_SAME_SIDE_PENALTY, lawFirmRole } from '@/lib/matching/legalSameSidePenalty'
import {
  legalPolicyAdjustment, crossMarketAdjustment, CROSS_MARKET_PER_DIRECTION,
  solveGlobalBMatching, pairTypeCounts, nullSafeRole,
} from '@/lib/matching/globalBMatching'
import { isLegalProfessional } from '@/lib/matching/business-solutions'

const LAW = 'Law Firm Partner'
const GC = 'General Counsel'
type Mm = { id: string; role_type?: string | null }
const m = (id: string, role_type = 'CEO'): Mm => ({ id, role_type })
const edge = (a: Mm, b: Mm, score = 100) => ({ userA: a, userB: b, mutualScore: score })
const legalPro = nullSafeRole(isLegalProfessional)
const degOf = (r: { degree: Map<string, number> }, id: string) => r.degree.get(id) ?? 0

/**
 * ATOMIC TWO-SIDED MATERIALIZATION (migration 064).
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE — stated rather than implied.
 *   • Pure TypeScript (pair collapsing, outcome classification) is tested behaviourally here.
 *   • SQL TEXT assertions pin the properties only the database can enforce — the advisory locks,
 *     the read-only-before-write ordering, SECURITY DEFINER, search_path, and the grants.
 *   • Atomicity, concurrency, rollback and idempotency are NOT provable from text. They are
 *     proven against a real PostgreSQL by scripts/verify-064-atomic-pair.sh, and the last block
 *     pins that harness's scenario list so it cannot silently lose coverage.
 */

const SQL = readFileSync('supabase/migrations/064_materialize_admin_pair.sql', 'utf8')
const FN = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.materialize_admin_pair'), SQL.indexOf('$$;'))
const APPROVE = readFileSync('app/api/admin/approve-batch/route.ts', 'utf8')
const GENERATE = readFileSync('app/api/admin/generate-batch/route.ts', 'utf8')

describe('migration 064 is a NEW migration and 063 is untouched', () => {
  it('064 exists and is the next number after 063', () => {
    expect(existsSync('supabase/migrations/064_materialize_admin_pair.sql')).toBe(true)
    expect(existsSync('supabase/migrations/065_.sql')).toBe(false)
  })

  it('is marked NOT YET APPLIED', () => {
    expect(SQL).toMatch(/NOT YET APPLIED/)
  })

  it('does not redefine anything migration 063 owns', () => {
    for (const f of ['create_reciprocal_suggestion', 'place_batch_rows', 'promote_queued_rows']) {
      expect(SQL, `064 must not redefine ${f}`).not.toContain(`CREATE OR REPLACE FUNCTION public.${f}(`)
    }
    expect(SQL).not.toMatch(/DROP\s+FUNCTION/i)
    expect(SQL).not.toMatch(/ALTER\s+TABLE/i)   // no schema change, no grant change
  })

  it('changes no table grant and no RLS policy', () => {
    expect(SQL).not.toMatch(/CREATE\s+POLICY|DROP\s+POLICY|ALTER\s+POLICY/i)
    expect(SQL).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+ON\s+(TABLE|public\.)/i)
    expect(SQL).not.toMatch(/ENABLE ROW LEVEL SECURITY|DISABLE ROW LEVEL SECURITY/i)
  })
})

describe('security posture', () => {
  it('is SECURITY DEFINER with an empty search_path', () => {
    expect(FN).toMatch(/SECURITY DEFINER/)
    expect(FN).toMatch(/SET search_path = ''/)
  })

  it('revokes from PUBLIC/anon/authenticated and grants only service_role', () => {
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION public\.materialize_admin_pair[\s\S]*FROM PUBLIC, anon, authenticated/)
    expect(SQL).toMatch(/GRANT EXECUTE ON FUNCTION public\.materialize_admin_pair[\s\S]*TO service_role/)
    expect(SQL).not.toMatch(/TO\s+(anon|authenticated|PUBLIC)\b/)
  })

  it('schema-qualifies the objects it touches', () => {
    for (const t of ['profiles', 'blocked_users', 'matches', 'intro_requests',
                     'member_pairs', 'recommendation_batches', 'batch_suggestions',
                     'introduction_batches']) {
      expect(FN, `${t} must be schema-qualified`).toContain(`public.${t}`)
    }
    expect(FN).toMatch(/pg_catalog\.pg_advisory_xact_lock/)
    expect(FN).toMatch(/pg_catalog\.hashtextextended/)
  })

  it('never emails, notifies, or logs an identity from SQL', () => {
    expect(FN).not.toMatch(/RAISE\s+(NOTICE|LOG|WARNING|INFO)/i)
    expect(FN).not.toMatch(/pg_notify|SELECT\s+net\.|http_post/i)
    expect(FN).not.toMatch(/SQLERRM/)      // no raw database error is ever returned
    expect(FN).not.toMatch(/\bemail\b/i)   // no identity field in any returned object
  })
})

describe('the transactional contract', () => {
  it('takes BOTH participant advisory locks in canonical order', () => {
    const lockLo = FN.indexOf('pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text')
    const lockHi = FN.indexOf('pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text')
    expect(lockLo).toBeGreaterThan(-1)
    expect(lockHi).toBeGreaterThan(lockLo)   // lo before hi -> two approvals cannot deadlock
    // canonicalisation must precede the locks, or "canonical order" means nothing
    expect(FN.indexOf('lo := LEAST(')).toBeLessThan(lockLo)
  })

  it('rejects a self-pair explicitly, because no CHECK constraint does', () => {
    expect(FN).toMatch(/IF p_member_a = p_member_b THEN/)
    expect(FN).toMatch(/'self_pair'/)
  })

  it('requires BOTH symmetric review rows and locks them', () => {
    expect(FN).toMatch(/recipient_id = lo AND bs\.suggested_id = hi/)
    expect(FN).toMatch(/recipient_id = hi AND bs\.suggested_id = lo/)
    expect((FN.match(/FOR UPDATE/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect(FN).toMatch(/'proposal_not_symmetric'/)
  })

  it('EVERY refusal happens before the FIRST WRITE — RETURN does not roll back', () => {
    // The load-bearing ordering property. A PL/pgSQL RETURN leaves earlier INSERTs committed, so a
    // single write above any refusal would leave a stray member_pairs or recommendation_batches row.
    const firstWrite = FN.indexOf('FIRST WRITE')
    expect(firstWrite).toBeGreaterThan(-1)
    for (const outcome of ["'ineligible'", "'blocked'", "'already_matched'", "'same_company'",
                           "'history'", "'capacity'", "'exists_active'", "'duplicate_proposal'",
                           "'proposal_not_symmetric'",
                           "'batch_id_mismatch'", "'active_batch_source_conflict'", "'pair_status_matched'", "'pair_status_blocked'",
                           "'pair_status_ineligible'", "'pair_status_superseded'", "'pair_cooldown'",
                           "'materialized_state_inconsistent'"]) {
      expect(FN.indexOf(outcome), `${outcome} must be decided before the first write`)
        .toBeLessThan(firstWrite)
    }
    // and no INSERT/UPDATE may appear above it
    const before = FN.slice(0, firstWrite)
    expect(before).not.toMatch(/INSERT INTO/)
    expect(before).not.toMatch(/^\s*UPDATE /m)
  })

  it('reads the canonical member_pairs row without creating it', () => {
    const readIdx = FN.indexOf('(14) member_pairs: READ, not create')
    expect(readIdx).toBeGreaterThan(-1)
    expect(readIdx).toBeLessThan(FN.indexOf('INSERT INTO public.member_pairs'))
  })

  it('legacy check retained: refusals precede the first INSERT', () => {
    const firstInsert = Math.min(
      ...['INSERT INTO public.member_pairs', 'INSERT INTO public.intro_requests',
          'INSERT INTO public.recommendation_batches']
        .map((k) => { const i = FN.indexOf(k); return i === -1 ? Number.MAX_SAFE_INTEGER : i }))
    for (const outcome of ["'ineligible'", "'blocked'", "'already_matched'", "'same_company'",
                           "'history'", "'capacity'", "'exists_active'"]) {
      expect(FN.indexOf(outcome), `${outcome} must be decided before any write`).toBeLessThan(firstInsert)
    }
  })

  it('inserts EXACTLY two directional rows sharing one pair_id', () => {
    const ins = FN.slice(FN.indexOf('INSERT INTO public.intro_requests'))
    expect(ins).toMatch(/\(lo, hi, v_tier[\s\S]*\(hi, lo, v_tier/)   // both directions, one statement
    expect(ins).toMatch(/v_pair_id, v_batch_lo/)
    expect(ins).toMatch(/v_pair_id, v_batch_hi/)                     // per-member batch ids differ
  })

  it('places both members in the visible tier or neither — the only placeable tier', () => {
    expect(FN).toMatch(/v_tier := 'suggested'/)
    // BOTH members must be under the visible cap; there is no second tier to fall through to.
    expect(FN).toMatch(/v_vis_lo < c_max_visible AND v_vis_hi < c_max_visible/)
    // reserved counts are still READ, but only to explain a refusal
    expect(FN).toMatch(/reserved_free_lo/)
    expect(FN).toMatch(/'outcome','capacity'/)
  })

  it('uses the same capacity constants as migration 063 and lets no argument raise them', () => {
    expect(FN).toMatch(/c_max_visible\s+constant integer := 2/)
    expect(FN).toMatch(/c_max_reserved constant integer := 2/)
    expect(FN).not.toMatch(/p_max_(visible|reserved|cards)/)
  })

  it('marks review rows materialized ONLY after a successful insert', () => {
    const upd = FN.indexOf("SET status = 'shown'")
    expect(upd).toBeGreaterThan(FN.indexOf('INSERT INTO public.intro_requests'))
  })

  it('is idempotent on repeat without writing anything', () => {
    const idx = FN.indexOf("'already_materialized'")
    expect(idx).toBeGreaterThan(-1)
    expect(idx).toBeLessThan(FN.indexOf('INSERT INTO public.member_pairs'))
  })
})

describe('undirected pair collapsing', () => {
  it('collapses symmetric rows into one pair', () => {
    const { pairs, unpaired } = toUndirectedPairs([
      { recipient_id: 'a', suggested_id: 'b' },
      { recipient_id: 'b', suggested_id: 'a' },
    ])
    expect(pairs).toEqual([{ a: 'a', b: 'b' }])
    expect(unpaired).toBe(0)
  })

  it('never emits a pair for a one-sided proposal', () => {
    const { pairs, unpaired } = toUndirectedPairs([{ recipient_id: 'a', suggested_id: 'b' }])
    expect(pairs).toHaveLength(0)
    expect(unpaired).toBe(1)
  })

  it('is deterministic regardless of row order', () => {
    const rows = [
      { recipient_id: 'c', suggested_id: 'd' }, { recipient_id: 'a', suggested_id: 'b' },
      { recipient_id: 'd', suggested_id: 'c' }, { recipient_id: 'b', suggested_id: 'a' },
    ]
    const fwd = toUndirectedPairs(rows).pairs
    const rev = toUndirectedPairs([...rows].reverse()).pairs
    expect(fwd).toEqual(rev)
    expect(fwd).toEqual([{ a: 'a', b: 'b' }, { a: 'c', b: 'd' }])
  })

  it('drops self rows and never yields a pair identity twice', () => {
    const { pairs } = toUndirectedPairs([
      { recipient_id: 'a', suggested_id: 'a' },
      { recipient_id: 'a', suggested_id: 'b' }, { recipient_id: 'b', suggested_id: 'a' },
      { recipient_id: 'a', suggested_id: 'b' },
    ])
    expect(pairs).toEqual([{ a: 'a', b: 'b' }])
  })

  it('the canonical key IS the stable review identity', () => {
    const a = toUndirectedPairs([{ recipient_id: 'x', suggested_id: 'y' }, { recipient_id: 'y', suggested_id: 'x' }]).pairs[0]
    const b = toUndirectedPairs([{ recipient_id: 'y', suggested_id: 'x' }, { recipient_id: 'x', suggested_id: 'y' }]).pairs[0]
    expect(a).toEqual(b)
  })
})

describe('outcome classification', () => {
  it('capacity and transport errors are deferrable; everything else is settled', () => {
    expect(isDeferrable('capacity')).toBe(true)
    expect(isDeferrable('error')).toBe(true)
    for (const o of ['created', 'already_materialized', 'exists_active', 'ineligible', 'blocked',
                     'same_company', 'already_matched', 'history', 'cooldown', 'invalid'] as const) {
      expect(isDeferrable(o), `${o} must not be retried in-cycle`).toBe(false)
      expect(TERMINAL_OUTCOMES.has(o)).toBe(true)
    }
  })

  it('every outcome the SQL can return is represented in the client type', () => {
    const inSql = Array.from(SQL.matchAll(/'outcome','([a-z_]+)'/g)).map((m) => m[1])
    expect(new Set(inSql).size).toBeGreaterThan(5)
    for (const o of inSql) {
      expect(TERMINAL_OUTCOMES.has(o as any) || o === 'capacity',
        `SQL can return '${o}' but the client does not classify it`).toBe(true)
    }
  })
})

describe('approval wiring', () => {
  it('approve-batch materializes per PAIR, not per recipient', () => {
    expect(APPROVE).toContain('toUndirectedPairs')
    expect(APPROVE).toContain('materializeAdminPair')
    // enqueueBatch may still be NAMED in the comment that explains why it was removed; what must
    // be gone is the CALL. Strip comments before asserting, so documentation is not mistaken for code.
    const code = APPROVE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code).not.toMatch(/\benqueueBatch\s*\(/)
    expect(code).not.toContain("from '@/lib/introductions/queue'\nimport { enqueueBatch")
  })

  it('does not pre-mark review rows shown, so a rejected pair stays reviewable', () => {
    // The old route flipped every row to 'shown' BEFORE materializing, so a capacity-rejected
    // pair was recorded as delivered. The RPC now marks them, and only on success.
    expect(APPROVE).not.toMatch(/\.update\(\{\s*status:\s*'shown'/)
  })

  it('reports outcomes in aggregate with no identity', () => {
    expect(APPROVE).toMatch(/byOutcome\[r\.outcome\]/)
    expect(APPROVE).toContain('outcomes: byOutcome')
  })

  it('place_batch_rows survives only for its legitimate caller, documented', () => {
    expect(APPROVE).toMatch(/generate-recommendations\.ts/)      // names the remaining caller
    expect(readFileSync('lib/generate-recommendations.ts', 'utf8')).toContain('enqueueBatch')
  })

  it('generation selects globally and no longer partitions by availability tier', () => {
    expect(GENERATE).toContain('solveGlobalBMatching')
    expect(GENERATE).not.toContain('membersWithUnresolvedIntros')
    expect(GENERATE).toContain('crossMarketAdjustment(lawFirmRole)')
  })

  it('generation still applies every hard gate before the optimizer sees an edge', () => {
    for (const gate of ['isSameCompany(userA, userB)', 'introHistory', 'aHiddenB', 'aPassedB',
                        'aMatchedB', 'aShownB', 'if (avgScore < MIN_RELEVANCE_SCORE) continue']) {
      expect(GENERATE, `missing hard gate: ${gate}`).toContain(gate)
    }
  })
})

describe('the PostgreSQL harness covers what text cannot', () => {
  it('exists and refuses a non-disposable database', () => {
    expect(existsSync('scripts/verify-064-atomic-pair.sh')).toBe(true)
    const sh = readFileSync('scripts/verify-064-atomic-pair.sh', 'utf8')
    expect(sh).toMatch(/REFUSING/)
    expect(sh).toMatch(/supabase\.co/)
    expect(sh).toMatch(/lock_timeout/)
  })

  it('pins every scenario only a real database can prove', () => {
    const sh = readFileSync('scripts/verify-064-atomic-pair.sh', 'utf8')
    for (const scenario of [
      'visible/visible atomic placement',
      'repeated approval is idempotent',
      'VISIBLE-ONLY: a pair is never placed in the reserved tier',
      'only ONE side lacks visible room -> capacity, never a split tier',
      'MULTI-PAIR, MIXED-TIER LIFECYCLE (one member in two pairs)',
      'DUPLICATE AND MALFORMED REVIEW PROPOSALS (must fail closed, zero writes)',
      'no shared tier -> capacity, ZERO inserts',
      'one side fails a gate -> NEITHER row',
      'malformed input',
      'concurrency (two real sessions)',
      'rollback leaves nothing',
      'deletion lifecycle',
      'security posture',
      'FINAL INVARIANTS',
    ]) expect(sh, `missing scenario: ${scenario}`).toContain(scenario)
    // the control that stops the concurrency proof passing vacuously
    expect(sh).toContain('a DIFFERENT pair does NOT block (control)')
  })

  it('has a fixture transcribed from the production catalog, not from migrations', () => {
    expect(existsSync('supabase/tests/064_fixture.sql')).toBe(true)
    const fx = readFileSync('supabase/tests/064_fixture.sql', 'utf8')
    expect(fx).toContain('CREATE TABLE IF NOT EXISTS public.introduction_batches')
    expect(fx).toContain('CREATE TABLE IF NOT EXISTS public.batch_suggestions')
    // production has NO unique constraint and NO self-pair check — the fixture must not add them,
    // or it would prove an idempotency the real schema does not enforce
    expect(fx).not.toMatch(/UNIQUE\s*\(\s*requester_id/i)
    expect(fx).toMatch(/DELIBERATELY absent/i)
    expect(fx).toMatch(/no unique/i)
  })
})

describe('VISIBLE-TIER ONLY: a pair can never be split by promotion', () => {
  it('the function never writes status queued', () => {
    // The safety property is structural, not argued: promote_queued_rows (migration 063) acts on
    // ONE member and has zero pair_id awareness, and it runs from five member-triggered paths. A
    // queued pair would be split the moment either member touched an unrelated card.
    const body = FN.slice(FN.indexOf('BEGIN'))
    expect(body).not.toMatch(/v_tier\s*:=\s*'queued'/)
    expect(body).not.toMatch(/'queued'\s*,\s*true\s*,/)      // not inserted as a row status
    expect(FN).toMatch(/v_tier := 'suggested'/)
    expect(FN).toMatch(/v_state := 'active'/)
  })

  it('creates no queued recommendation_batches row', () => {
    const inserts = FN.slice(FN.indexOf('INSERT INTO public.recommendation_batches'))
    expect(inserts).not.toMatch(/'queued'/)
  })

  it('records why, so the constraint cannot be relaxed without meeting the reason', () => {
    expect(SQL).toMatch(/promote_queued_rows/)
    expect(SQL).toMatch(/zero references to pair_id/i)
    expect(SQL).toMatch(/REQUIRES making promotion pair-aware first/i)
  })

  it('promote_queued_rows is NOT modified by this migration', () => {
    expect(SQL).not.toContain('CREATE OR REPLACE FUNCTION public.promote_queued_rows')
  })
})

describe('exactly one approvable proposal per direction (no LIMIT)', () => {
  it('counts before locking and refuses on duplicates', () => {
    expect(FN).toMatch(/SELECT count\(\*\) INTO v_n_lo/)
    expect(FN).toMatch(/SELECT count\(\*\) INTO v_n_hi/)
    expect(FN).toMatch(/IF v_n_lo > 1 OR v_n_hi > 1 THEN/)
    expect(FN).toMatch(/'duplicate_proposal'/)
  })

  it('contains no executable LIMIT anywhere', () => {
    const code = FN.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(code).not.toMatch(/\bLIMIT\b/i)
  })

  it('distinguishes an idempotent replay from a half-state', () => {
    expect(FN).toMatch(/v_m_lo <> 1 OR v_m_hi <> 1 OR v_n_lo <> 0 OR v_n_hi <> 0/)
    expect(FN).toMatch(/'already_materialized'/)
    expect(FN).toMatch(/'materialized_state_inconsistent'/)
    expect(FN).toMatch(/'proposal_not_symmetric'/)
  })
})

describe('member-batch (envelope) lifecycle', () => {
  const seg = () => FN.slice(FN.indexOf('(15) envelopes: READ + decide'), FN.indexOf('FIRST WRITE'))

  it('looks up by a unique key and never orders or limits', () => {
    expect(seg()).toMatch(/WHERE b\.member_id = lo AND b\.state = v_state/)
    expect(seg()).toMatch(/FOR UPDATE/)
    // strip comments: the section's own prose says "no ordering, no LIMIT"
    const code = seg().split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(code).not.toMatch(/ORDER BY/i)     // no "most recent" selection
    expect(code).not.toMatch(/\bLIMIT\b/i)
  })

  it('REUSES an admin envelope regardless of which review created it', () => {
    // Requiring reciprocal_batch_id = the current review was stricter than production semantics
    // (place_batch_rows appends without it) and would have permanently refused an underfilled
    // member holding one card from an older cycle — the exact underfill this work removes.
    expect(seg()).not.toMatch(/reciprocal_batch_id IS DISTINCT FROM p_review_batch_id/)
    expect(SQL).toMatch(/REUSE it, whatever review created it/)
  })

  it('never rewrites an envelope\'s reciprocal_batch_id', () => {
    const writes = FN.slice(FN.indexOf('FIRST WRITE'))
    expect(writes).not.toMatch(/UPDATE public\.recommendation_batches[\s\S]{0,200}reciprocal_batch_id\s*=/)
    expect(SQL).toMatch(/is left ALONE|never rewritten/)
  })

  it('retires only a STALE envelope, proven by having no live row', () => {
    expect(seg()).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.intro_requests ir\s+WHERE ir\.batch_id = v_bat_lo\.batch_id AND ir\.status IN \('suggested','queued'\)\)/)
    const writes = FN.slice(FN.indexOf('FIRST WRITE'))
    expect(writes).toMatch(/IF v_retire_lo THEN[\s\S]*state = 'completed', completed_at = v_now/)
  })

  it('refuses a LIVE foreign-source envelope instead of falsifying batch_source', () => {
    expect(seg()).toMatch(/'active_batch_source_conflict'/)
    expect(seg()).toMatch(/NOT v_stale_lo AND v_bat_lo\.batch_source IS DISTINCT FROM c_source/)
  })

  it('never deletes, archives or restatuses an existing member card', () => {
    expect(FN).not.toMatch(/DELETE FROM public\.intro_requests/)
    expect(FN).not.toMatch(/UPDATE public\.intro_requests/)
  })

  it('validates a supplied id against the member it belongs to, before any write', () => {
    expect(seg()).toMatch(/CASE WHEN p_member_a = lo THEN v_batch_lo ELSE v_batch_hi END/)
    expect(seg().indexOf("'batch_id_mismatch'")).toBeGreaterThan(-1)
    expect(FN.indexOf("'batch_id_mismatch'")).toBeLessThan(FN.indexOf('FIRST WRITE'))
  })

  it('documents what an active envelope means, traced not assumed', () => {
    expect(SQL).toMatch(/CURRENT VISIBLE DELIVERY ENVELOPE, not a review cycle/)
    expect(SQL).toMatch(/never reads this table/)
    expect(SQL).toMatch(/23 active member envelopes spanning 3 distinct reciprocal_batch_id/)
  })
})

describe('canonical approval order', () => {
  const P = (a: string, b: string) => ({ a, b })

  it('serves zero-card members before partially filled ones', () => {
    const order = canonicalApprovalOrder([P('x', 'y'), P('p', 'q')], {
      visibleCardsOf: (id) => (['p', 'q'].includes(id) ? 0 : 1),
    })
    expect(order[0]).toEqual(P('p', 'q'))
  })

  it('prefers more zero-card endpoints, then more underfilled endpoints', () => {
    const order = canonicalApprovalOrder([P('a', 'b'), P('c', 'd'), P('e', 'f')], {
      visibleCardsOf: (id) => ({ a: 0, b: 0, c: 0, d: 1, e: 2, f: 2 } as any)[id] ?? 0,
    })
    expect(order.map((p) => p.a)).toEqual(['a', 'c', 'e'])
  })

  it('breaks a full tie by quality, then by canonical key', () => {
    const eq = { visibleCardsOf: () => 1 }
    const byQuality = canonicalApprovalOrder([P('a', 'b'), P('c', 'd')], {
      ...eq, scoreOf: (a) => (a === 'c' ? 200 : 100),
    })
    expect(byQuality[0]).toEqual(P('c', 'd'))
    const byKey = canonicalApprovalOrder([P('c', 'd'), P('a', 'b')], eq)
    expect(byKey.map((p) => p.a)).toEqual(['a', 'c'])
  })

  it('is a total order — input order never changes the result', () => {
    const pairs = [P('a', 'b'), P('c', 'd'), P('e', 'f'), P('g', 'h')]
    const ctx = { visibleCardsOf: (id: string) => (id.charCodeAt(0) % 3) }
    const fwd = canonicalApprovalOrder(pairs, ctx).map((p) => p.a + p.b).join(',')
    const rev = canonicalApprovalOrder([...pairs].reverse(), ctx).map((p) => p.a + p.b).join(',')
    expect(fwd).toBe(rev)
  })

  it('a retry reproduces the same sequence', () => {
    const pairs = [P('m', 'n'), P('o', 'p'), P('q', 'r')]
    const ctx = { visibleCardsOf: (id: string) => (id === 'q' ? 0 : 1) }
    const first = canonicalApprovalOrder(pairs, ctx)
    for (let i = 0; i < 5; i++) expect(canonicalApprovalOrder(pairs, ctx)).toEqual(first)
  })

  it('approve-batch uses it, not database or object order', () => {
    expect(APPROVE).toContain('canonicalApprovalOrder')
    expect(APPROVE).toMatch(/visibleCardsOf/)
    // counts are read ONCE, before the loop, so the order is fixed up front
    expect(APPROVE.indexOf('canonicalApprovalOrder')).toBeLessThan(APPROVE.indexOf('for (const pair of pairs)'))
  })
})

describe('cross-market penalty: unit compatibility', () => {
  it('legalSameSidePenalty returns non-positive DIRECTIONAL score points', () => {
    expect(legalSameSidePenalty({ role_type: 'Law Firm Partner' }, { role_type: 'Law Firm Partner' })).toBe(-60)
    expect(legalSameSidePenalty({ role_type: 'Law Firm Partner' }, { role_type: 'Law firm attorney' })).toBe(-45)
    expect(legalSameSidePenalty({ role_type: 'Law firm attorney' }, { role_type: 'Law firm attorney' })).toBe(-30)
    expect(legalSameSidePenalty({ role_type: 'Law Firm Partner' }, { role_type: 'General Counsel' })).toBe(0)
    expect(legalSameSidePenalty({ role_type: 'CEO' }, { role_type: 'CFO' })).toBe(0)
  })

  it('is symmetric, so applying it per direction cannot depend on argument order', () => {
    const a = { role_type: 'Law Firm Partner' }, b = { role_type: 'Law firm attorney' }
    expect(legalSameSidePenalty(a, b)).toBe(legalSameSidePenalty(b, a))
  })

  it('2x applies it ONCE PER DIRECTION, matching mutualScore being a SUM of two directions', () => {
    // mutualScore = scoreAtoB + scoreBtoA (a sum, not an average). The penalty is defined on a
    // single directional score — generate-recommendations.ts adds it to one candidate's
    // finalScore. A same-side pair is same-side from BOTH directions, so the faithful edge-level
    // adjustment is one application per direction: exactly 2x, never more.
    const adj = legalPolicyAdjustment(legalSameSidePenalty)
    expect(adj({ role_type: 'Law Firm Partner' }, { role_type: 'Law Firm Partner' })).toBe(-120)
    expect(adj({ role_type: 'Law Firm Partner' }, { role_type: 'Law firm attorney' })).toBe(-90)
    expect(adj({ role_type: 'Law firm attorney' }, { role_type: 'Law firm attorney' })).toBe(-60)
    expect(adj({ role_type: 'Law Firm Partner' }, { role_type: 'General Counsel' })).toBe(0)
    // exactly twice the directional value — not squared, not compounded
    for (const [x, y] of [['Law Firm Partner', 'Law Firm Partner'],
                          ['Law Firm Partner', 'Law firm attorney'],
                          ['Law firm attorney', 'Law firm attorney']] as const) {
      expect(adj({ role_type: x }, { role_type: y })).toBe(2 * legalSameSidePenalty({ role_type: x }, { role_type: y }))
    }
  })

  it('the stated ceilings match the constants', () => {
    expect(2 * LEGAL_SAME_SIDE_PENALTY.partnerPartner).toBe(120)
    expect(2 * LEGAL_SAME_SIDE_PENALTY.partnerAttorney).toBe(90)
    expect(2 * LEGAL_SAME_SIDE_PENALTY.attorneyAttorney).toBe(60)
  })

  it('classification is by controlled role_type only', () => {
    expect(lawFirmRole({ role_type: 'Law Firm Partner' })).toBe('partner')
    expect(lawFirmRole({ role_type: 'General Counsel' })).toBeNull()
  })

  it('the relevance gate stays on the UNADJUSTED score', () => {
    // The adjustment must never reach the gate: subtracting it before the floor would delete
    // same-side edges from the pool, which is the failure batch-scoring.ts documents at line 275.
    expect(GENERATE).toContain('if (avgScore < MIN_RELEVANCE_SCORE) continue')
    const gateIdx = GENERATE.indexOf('if (avgScore < MIN_RELEVANCE_SCORE) continue')
    const adjIdx = GENERATE.indexOf('crossMarketAdjustment(lawFirmRole)')
    expect(gateIdx).toBeLessThan(adjIdx)          // gate is applied while building allPairs
    expect(GENERATE).not.toMatch(/avgScore\s*\+\s*legal|legalSameSidePenalty\([^)]*\)\s*\+\s*avgScore/)
  })
})

describe('member_pairs status policy', () => {
  it('every CHECK-allowed status has an explicit rule', () => {
    for (const st of ['matched', 'blocked', 'ineligible', 'superseded', 'active', 'passed', 'expired']) {
      expect(SQL, `no documented rule for status '${st}'`).toMatch(new RegExp(`\\b${st}\\b`))
    }
    expect(FN).toMatch(/v_pair\.status = 'matched'/)
    expect(FN).toMatch(/v_pair\.status = 'blocked'/)
    expect(FN).toMatch(/v_pair\.status = 'ineligible'/)
    expect(FN).toMatch(/v_pair\.status = 'superseded'/)
    expect(FN).toMatch(/v_pair\.status NOT IN \('active','passed','expired'\)/)
  })

  it('terminal statuses are decided before the row is ever updated to active', () => {
    expect(FN.indexOf("'pair_status_matched'")).toBeLessThan(FN.indexOf("status               = 'active'"))
    expect(FN.indexOf("'pair_status_blocked'")).toBeLessThan(FN.indexOf("status               = 'active'"))
  })
})

describe('cross-market calibration is an explicit, measured choice', () => {
  const P = (r: string) => ({ role_type: r })
  const A = legalPolicyAdjustment(legalSameSidePenalty)   // Option A
  const B = crossMarketAdjustment(lawFirmRole)            // Option B (wired)

  it('Option A reproduces the full shared penalty, once per direction', () => {
    expect(A(P('Law Firm Partner'), P('Law Firm Partner'))).toBe(-120)
    expect(A(P('Law Firm Partner'), P('Law firm attorney'))).toBe(-90)
    expect(A(P('Law firm attorney'), P('Law firm attorney'))).toBe(-60)
  })

  it('Option B is bounded to roughly 30% of the observed 104-point spread', () => {
    expect(B(P('Law Firm Partner'), P('Law Firm Partner'))).toBe(-32)
    expect(B(P('Law Firm Partner'), P('Law firm attorney'))).toBe(-24)
    expect(B(P('Law firm attorney'), P('Law firm attorney'))).toBe(-16)
    expect(2 * CROSS_MARKET_PER_DIRECTION.partnerPartner).toBe(-32)
  })

  it('neither option touches a cross-market or non-legal edge', () => {
    for (const adj of [A, B]) {
      expect(adj(P('Law Firm Partner'), P('General Counsel'))).toBe(0)
      expect(adj(P('CEO'), P('CFO'))).toBe(0)
    }
  })

  // Realistic production mutual scores: observed 62..166, median 98.
  const decide = (adj: any, sameSide: number, crossMarket: number) => {
    const P1 = m('P1', LAW), P2 = m('P2', LAW), G = m('G', GC)
    const es = [edge(P1, P2, sameSide), edge(P1, G, crossMarket)]
    const ids = ['P1', 'P2', 'G']
    const r = solveGlobalBMatching(es, {
      capacityByMember: new Map(ids.map((i) => [i, 1])),
      existingVisibleByMember: new Map(ids.map((i) => [i, 0])),
      qualityAdjustment: adj,
    })
    return pairTypeCounts(r.selected, (x) => lawFirmRole(x) !== null, legalPro).law_firm__law_firm
      ? 'same-side' : 'cross-market'
  }

  it('both options prefer cross-market among COMPARABLY strong matches', () => {
    for (const adj of [A, B]) {
      expect(decide(adj, 98, 98)).toBe('cross-market')     // median vs median
      expect(decide(adj, 112, 98)).toBe('cross-market')    // p75 vs median
      expect(decide(adj, 130, 98)).toBe('cross-market')    // strong vs median
    }
  })

  it('Option A makes a near-best same-side match unwinnable — the reason it was rejected', () => {
    expect(decide(A, 160, 84)).toBe('cross-market')        // 160 is near the observed max of 166
    expect(decide(A, 166, 62)).toBe('cross-market')        // even max vs min
  })

  it('Option B lets a MATERIALLY stronger same-side match win, as the product goal requires', () => {
    expect(decide(B, 160, 84)).toBe('same-side')
    expect(decide(B, 166, 62)).toBe('same-side')
    expect(decide(B, 62, 166)).toBe('cross-market')        // and a weak one still loses
  })

  it('coverage still outranks either calibration', () => {
    const P1 = m('P1', LAW), P2 = m('P2', LAW), G = m('G', GC)
    for (const adj of [A, B]) {
      const ids2 = ['P1', 'P2', 'G']
      const r = solveGlobalBMatching([edge(P1, G, 166), edge(P1, P2, 62)], {
        capacityByMember: new Map(ids2.map((i) => [i, 2])),
        existingVisibleByMember: new Map(ids2.map((i) => [i, 0])),
        qualityAdjustment: adj,
      })
      expect(degOf(r, 'P2'), 'a zero-card member is covered regardless of pair type').toBe(1)
    }
  })
})

describe('migration-health registration is deliberately absent, and why', () => {
  it('064 is not registered on the admin health surface', () => {
    // NOT an oversight, and the gap must not be glossed. lib/db/migrationHealth.ts probes a
    // migration by looking for a COLUMN it adds. Migration 064 adds no column — it adds a
    // FUNCTION, public.materialize_admin_pair — so registering it needs the kind:'function'
    // probe machinery. At HEAD that machinery does not exist: it is introduced by unrelated,
    // uncommitted company-admin work, so a 064 entry could not be staged without dragging that
    // work into this commit. Migration 063 was left unregistered for exactly the same reason.
    expect(readFileSync('lib/db/migrationHealth.ts', 'utf8')).not.toContain('064_materialize')
  })

  it('what actually protects ordering is the RPC being absent, not a dashboard banner', () => {
    // If 064 were somehow unapplied, materializeAdminPair returns the transient 'error' outcome
    // and approve-batch records a rejection. The failure mode is "no cards materialised" — never
    // one-sided or over-capacity cards. Degradation is safe without the health entry.
    const client = readFileSync('lib/introductions/materializeAdminPair.ts', 'utf8')
    expect(client).toMatch(/return \{ outcome: 'error' \}/)
    expect(client).toMatch(/rpc failed \(class\)/)
    expect(APPROVE).toMatch(/byOutcome\[r\.outcome\]/)
  })
})
