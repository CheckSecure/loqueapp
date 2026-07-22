import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { RECOMMENDATIONS_PER_BATCH, ACTIVE_INTRO_CAP, getActiveIntroCap } from '@/lib/introductions/limits'
import { BATCH_CONFIG, effectiveTierDistribution } from '@/lib/matching/batch-scoring'
import { perRecipientIntroLimit } from '@/lib/matching/batch-limits'
import { isLawFirmLawyer, applyLawFirmCompositionPolicy } from '@/lib/generate-recommendations'
import {
  enqueueBatch, promoteIfResolved, getActiveBatch, getQueuedBatch,
  countUnresolvedRecommendations, weeklyEligibilityCheck,
} from '@/lib/introductions/queue'
import { buildBackfillReport } from '@/lib/introductions/migration-backfill'

// ── In-memory Supabase mock ───────────────────────────────────────────────────
// Supports the query surface the queue service / metrics / backfill use:
// select/insert/update/delete with eq/in/not/gt/gte/order/limit/maybeSingle/then.
function makeClient(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    recommendation_batches: [...(seed.recommendation_batches ?? [])],
    intro_requests: [...(seed.intro_requests ?? [])],
    profiles: [...(seed.profiles ?? [])],
    matches: [...(seed.matches ?? [])],
    batch_suggestions: [...(seed.batch_suggestions ?? [])],
  }
  function from(table: string) {
    if (!tables[table]) tables[table] = []
    const filters: ((r: any) => boolean)[] = []
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let payload: any = null
    let limitN = Infinity
    const b: any = {
      select() { op = 'select'; return b },
      insert(v: any) { op = 'insert'; payload = v; return b },
      update(v: any) { op = 'update'; payload = v; return b },
      delete() { op = 'delete'; return b },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b },
      in(k: string, arr: any[]) { const s = new Set(arr); filters.push((r) => s.has(r[k])); return b },
      not(k: string, o: string, v: any) { if (o === 'is') filters.push((r) => r[k] !== v); return b },
      gt(k: string, v: any) { filters.push((r) => r[k] > v); return b },
      gte(k: string, v: any) { filters.push((r) => r[k] >= v); return b },
      order() { return b },
      limit(n: number) { limitN = n; return b },
      maybeSingle() { return run().then((x: any) => ({ data: x.data[0] ?? null, error: null })) },
      single() { return run().then((x: any) => ({ data: x.data[0] ?? null, error: null })) },
      then(res: any, rej: any) { return run().then(res, rej) },
    }
    const matches = () => tables[table].filter((r) => filters.every((f) => f(r)))
    async function run() {
      if (op === 'insert') {
        const arr = Array.isArray(payload) ? payload : [payload]
        for (const v of arr) tables[table].push({ ...v })
        return { data: null, error: null }
      }
      const m = matches()
      if (op === 'update') { for (const r of m) Object.assign(r, payload); return { data: null, error: null } }
      if (op === 'delete') { tables[table] = tables[table].filter((r) => !filters.every((f) => f(r))); return { data: null, error: null } }
      return { data: m.slice(0, limitN).map((r) => ({ ...r })), error: null }
    }
    return b
  }
  return { from, __tables: tables } as any
}

const irOf = (c: any, memberId = 'M') => c.__tables.intro_requests.filter((r: any) => r.requester_id === memberId)
const suggestedOf = (c: any, memberId = 'M') => irOf(c, memberId).filter((r: any) => r.status === 'suggested')
const queuedOf = (c: any, memberId = 'M') => irOf(c, memberId).filter((r: any) => r.status === 'queued')
const batchesOf = (c: any, state?: string, memberId = 'M') =>
  c.__tables.recommendation_batches.filter((b: any) => b.member_id === memberId && (!state || b.state === state))

// ==============================================================================

describe('RECOMMENDATIONS_PER_BATCH — one central constant drives every path', () => {
  it('is 2 and is the single source of truth', () => {
    expect(RECOMMENDATIONS_PER_BATCH).toBe(2)
    expect(ACTIVE_INTRO_CAP).toBe(RECOMMENDATIONS_PER_BATCH)
    expect(getActiveIntroCap()).toBe(RECOMMENDATIONS_PER_BATCH)
    expect(getActiveIntroCap('executive')).toBe(RECOMMENDATIONS_PER_BATCH)
  })
  it('the admin reciprocal batch references the same constant', () => {
    expect(BATCH_CONFIG.introductionsPerMemberCap).toBe(RECOMMENDATIONS_PER_BATCH)
    expect(effectiveTierDistribution('free').total).toBe(RECOMMENDATIONS_PER_BATCH)
    expect(effectiveTierDistribution('executive').total).toBe(RECOMMENDATIONS_PER_BATCH)
    expect(perRecipientIntroLimit('free')).toBe(RECOMMENDATIONS_PER_BATCH)
  })
})

describe('law-firm composition policy — never two law-firm lawyers', () => {
  const viewer = { role_type: 'Law Firm Partner', city: 'Washington', expertise: ['Litigation', 'Legal'] }
  const gc = { id: 'gc', role_type: 'General Counsel' }
  const exec = { id: 'exec', role_type: 'COO' }
  const clonePeer = { id: 'clone', role_type: 'Law Firm Partner', city: 'Washington', expertise: ['Litigation', 'Compliance', 'Legal'] }
  const strategicPeer = { id: 'strat', role_type: 'Law Firm Attorney', city: 'Washington', expertise: ['Regulatory', 'Legal'] }
  const outOfTownPeer = { id: 'far', role_type: 'Law Firm Partner', city: 'Denver', expertise: ['Antitrust'] }

  it('two clients when available → zero law-firm in the top 2', () => {
    const top2 = applyLawFirmCompositionPolicy([clonePeer, strategicPeer, gc, exec], viewer).slice(0, 2)
    expect(top2.filter((c) => isLawFirmLawyer(c))).toHaveLength(0)
  })
  it('admits ONE strategic peer (complementary practice + same city) into slot 2', () => {
    const top2 = applyLawFirmCompositionPolicy([gc, strategicPeer, exec], viewer).slice(0, 2)
    expect(isLawFirmLawyer(top2[0])).toBe(false)
    expect(top2.filter((c) => isLawFirmLawyer(c))).toHaveLength(1)
    expect(top2[1].id).toBe('strat')
  })
  it('excludes a same-practice clone even if higher-ranked', () => {
    const top2 = applyLawFirmCompositionPolicy([clonePeer, gc, exec], viewer).slice(0, 2)
    expect(top2.map((c) => c.id)).toEqual(['gc', 'exec'])
  })
  it('excludes a complementary peer that lacks the local (same-city) signal', () => {
    const out = applyLawFirmCompositionPolicy([gc, outOfTownPeer, exec], viewer)
    expect(out.slice(0, 2).filter((c) => isLawFirmLawyer(c))).toHaveLength(0)
  })
  it('never places a peer in slot 1 (always ≥1 client)', () => {
    const out = applyLawFirmCompositionPolicy([strategicPeer, gc, exec], viewer)
    expect(isLawFirmLawyer(out[0])).toBe(false)
  })
  it('leaves a non-law-firm viewer’s ranking unchanged', () => {
    const gcViewer = { role_type: 'General Counsel' }
    const input = [clonePeer, gc, strategicPeer, exec]
    expect(applyLawFirmCompositionPolicy(input, gcViewer)).toEqual(input)
  })
})

describe('queue — active-window invariant (one active, at most one queued, never >N visible)', () => {
  it('first enqueue into an empty member becomes the ACTIVE batch', async () => {
    const c = makeClient()
    const r = await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    expect(r.placed).toBe(true)
    expect(r.state).toBe('active')
    expect(batchesOf(c, 'active')).toHaveLength(1)
    expect(suggestedOf(c)).toHaveLength(2)
  })

  it('second enqueue becomes the QUEUED batch — exactly one active + one queued, only 2 visible', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    const r2 = await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'C' }, { target_user_id: 'D' }] })
    expect(r2.state).toBe('queued')
    expect(batchesOf(c, 'active')).toHaveLength(1)
    expect(batchesOf(c, 'queued')).toHaveLength(1)
    expect(suggestedOf(c)).toHaveLength(2)  // never more than N visible
    expect(queuedOf(c)).toHaveLength(2)
  })

  it('a third organic enqueue is refused — no unlimited backlog', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'C' }, { target_user_id: 'D' }] })
    const r3 = await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'E' }] })
    expect(r3.placed).toBe(false)
    expect(r3.reason).toBe('queued_slot_full')
    expect(batchesOf(c, 'queued')).toHaveLength(1)
  })

  it('dedupes a target the member already holds', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    const r = await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'A' }] }) // A already active
    expect(r.placed).toBe(false)
    expect(r.reason).toBe('all_duplicates')
  })
})

describe('queue — admin precedence for the queued slot', () => {
  it('admin batch DISCARDS an organic queued batch (deleted, not archived) and takes the slot', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    const organic = await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'C' }, { target_user_id: 'D' }] })
    const r = await enqueueBatch(c, { memberId: 'M', source: 'admin_reciprocal', rows: [{ target_user_id: 'X' }, { target_user_id: 'Y' }] })
    expect(r.placed).toBe(true)
    expect(r.state).toBe('queued')
    expect(r.discardedQueued).toBe(organic.batchId)
    // organic recommendation rows are gone (discard = delete, never resurface)
    expect(queuedOf(c).map((x: any) => x.target_user_id).sort()).toEqual(['X', 'Y'])
    // the organic batch metadata row remains, marked discarded (analytics only)
    const discarded = batchesOf(c, 'discarded')
    expect(discarded).toHaveLength(1)
    expect(discarded[0].batch_id).toBe(organic.batchId)
    // still exactly one active + one queued, still only 2 visible
    expect(batchesOf(c, 'active')).toHaveLength(1)
    expect(batchesOf(c, 'queued')).toHaveLength(1)
    expect(suggestedOf(c)).toHaveLength(2)
  })

  it('a SECOND admin batch is rejected when an admin batch is already queued', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    await enqueueBatch(c, { memberId: 'M', source: 'admin_reciprocal', rows: [{ target_user_id: 'X' }, { target_user_id: 'Y' }] })
    const r = await enqueueBatch(c, { memberId: 'M', source: 'admin_reciprocal', rows: [{ target_user_id: 'Z' }] })
    expect(r.placed).toBe(false)
    expect(r.reason).toBe('queued_admin_exists')
  })
})

describe('queue — promotion (reveal only, never generation)', () => {
  it('promotes the queued batch when the active batch is fully resolved by passing', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'C' }, { target_user_id: 'D' }] })
    // resolve the active batch: pass both
    for (const r of suggestedOf(c)) r.status = 'passed'
    const before = c.__tables.intro_requests.length
    const p = await promoteIfResolved(c, 'M')
    expect(p.promoted).toBe(true)
    // NO generation during promotion — row count unchanged
    expect(c.__tables.intro_requests.length).toBe(before)
    // queued batch is now the active batch; its rows are visible
    expect(suggestedOf(c).map((x: any) => x.target_user_id).sort()).toEqual(['C', 'D'])
    expect(batchesOf(c, 'active')).toHaveLength(1)
    expect(batchesOf(c, 'queued')).toHaveLength(0)
    expect(batchesOf(c, 'completed')).toHaveLength(1)
  })

  it('interest resolves a recommendation; the completed batch’s suggested rows are archived on promotion', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'C' }, { target_user_id: 'D' }] })
    // express interest in both actives: insert pending rows, leave 'suggested' in place
    c.__tables.intro_requests.push({ requester_id: 'M', target_user_id: 'A', status: 'pending' })
    c.__tables.intro_requests.push({ requester_id: 'M', target_user_id: 'B', status: 'pending' })
    expect(await countUnresolvedRecommendations(c, 'M')).toBe(0)
    const p = await promoteIfResolved(c, 'M')
    expect(p.promoted).toBe(true)
    // the two pending interest rows still exist (interest is never lost)
    expect(irOf(c).filter((r: any) => r.status === 'pending')).toHaveLength(2)
    // visible = promoted batch only
    expect(suggestedOf(c).map((x: any) => x.target_user_id).sort()).toEqual(['C', 'D'])
  })

  it('with an empty queue, resolving completes the active batch and generates NOTHING', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    for (const r of suggestedOf(c)) r.status = 'passed'
    const before = c.__tables.intro_requests.length
    const p = await promoteIfResolved(c, 'M')
    expect(p.promoted).toBe(false)
    expect(p.reason).toBe('empty_queue')
    expect(batchesOf(c, 'active')).toHaveLength(0)      // no active batch left
    expect(batchesOf(c, 'completed')).toHaveLength(1)
    expect(c.__tables.intro_requests.length).toBe(before) // no rapid-cycle refill
  })
})

describe('queue — batch lifecycle metadata timestamps', () => {
  it('active gets generated_at + displayed_at; queued has null displayed_at until promoted; completion stamps completed_at', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    const activeBatch = (await getActiveBatch(c, 'M'))!
    expect(activeBatch.generated_at).toBeTruthy()
    expect(activeBatch.displayed_at).toBeTruthy()
    expect(activeBatch.completed_at).toBeNull()

    await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'C' }, { target_user_id: 'D' }] })
    const queuedBatch = (await getQueuedBatch(c, 'M'))!
    expect(queuedBatch.generated_at).toBeTruthy()
    expect(queuedBatch.displayed_at).toBeNull()

    for (const r of suggestedOf(c)) r.status = 'passed'
    await promoteIfResolved(c, 'M')
    const completed = batchesOf(c, 'completed')[0]
    expect(completed.completed_at).toBeTruthy()
    const promoted = batchesOf(c, 'active')[0]
    expect(promoted.displayed_at).toBeTruthy() // stamped at promotion
  })
})

describe('queue — weekly generation eligibility', () => {
  it('skips a member who already has a queued batch', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'C' }, { target_user_id: 'D' }] })
    expect(await weeklyEligibilityCheck(c, 'M')).toBe(false)
  })
  it('skips a member sitting behind an INCOMPLETE admin batch', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'admin_reciprocal', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    // A,B are unresolved 'suggested' → not eligible for a pre-loaded organic next
    expect(await weeklyEligibilityCheck(c, 'M')).toBe(false)
  })
  it('is eligible behind an incomplete ORGANIC active batch (pre-load allowed) and when empty', async () => {
    const organic = makeClient()
    await enqueueBatch(organic, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    expect(await weeklyEligibilityCheck(organic, 'M')).toBe(true)
    const empty = makeClient()
    expect(await weeklyEligibilityCheck(empty, 'M')).toBe(true)
  })
})

describe('queue — the "never 4 recommendations" scenario', () => {
  it('a live active pair + an admin send yields 2 visible + 2 queued, never 4 visible', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    await enqueueBatch(c, { memberId: 'M', source: 'admin_reciprocal', rows: [{ target_user_id: 'X' }, { target_user_id: 'Y' }] })
    expect(suggestedOf(c)).toHaveLength(2)                    // visible
    expect(queuedOf(c)).toHaveLength(2)                       // hidden
    expect(suggestedOf(c).map((r: any) => r.target_user_id).sort()).toEqual(['A', 'B'])
  })
})

describe('no manual refresh / rapid-cycle endpoint exists', () => {
  it('the user-facing refresh-recommendations route is removed', () => {
    expect(existsSync(resolve(process.cwd(), 'app/api/user/refresh-recommendations/route.ts'))).toBe(false)
  })
})

describe('migration dry-run report', () => {
  it('counts visible distribution, over-batch-size members, discards, and admin batches to materialize', async () => {
    const c = makeClient({
      profiles: [
        { id: 'M1', account_status: 'active', profile_complete: true },
        { id: 'M2', account_status: 'active', profile_complete: true },
        { id: 'M3', account_status: 'active', profile_complete: true },
      ],
      intro_requests: [
        { requester_id: 'M1', target_user_id: 'A', status: 'suggested' },
        { requester_id: 'M1', target_user_id: 'B', status: 'suggested' },
        { requester_id: 'M2', target_user_id: 'A', status: 'suggested' },
        { requester_id: 'M2', target_user_id: 'B', status: 'suggested' },
        { requester_id: 'M2', target_user_id: 'C', status: 'suggested' },
      ],
      batch_suggestions: [
        { recipient_id: 'M2', suggested_id: 'D', status: 'shown', batch_id: 'BS1' },
        { recipient_id: 'M2', suggested_id: 'E', status: 'shown', batch_id: 'BS1' },
      ],
    })
    const report = await buildBackfillReport(c)
    expect(report.batchSize).toBe(2)
    expect(report.totalMembers).toBe(3)
    expect(report.usersSeeingMoreThanBatchSize).toBe(1)   // M2 sees 5
    expect(report.visibleDistribution['2']).toBe(1)        // M1
    expect(report.visibleDistribution['4plus']).toBe(1)    // M2
    expect(report.visibleDistribution['0']).toBe(1)        // M3
    expect(report.recommendationsToDiscard).toBe(1)        // M2: 5 − (Current2+Next2)=1
    expect(report.adminSuggestionBatchesToMaterialize).toBe(1)
  })
})
