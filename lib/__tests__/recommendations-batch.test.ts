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
import { attachQueueRpc } from './helpers/queueRpcModel'
import { buildBackfillReport, applyBackfill } from '@/lib/introductions/migration-backfill'
import { classifyIntroHistory } from '@/lib/introRequests/history'

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
    let rangeFrom = 0
    let rangeTo = Infinity
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
      range(a: number, z: number) { rangeFrom = a; rangeTo = z; return run() },
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
      const sliced = Number.isFinite(rangeTo) ? m.slice(rangeFrom, rangeTo + 1) : m.slice(0, limitN)
      return { data: sliced.map((r) => ({ ...r })), error: null }
    }
    return b
  }
  return attachQueueRpc({ from, __tables: tables } as any)
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

describe('law-firm composition policy — CROSS-MARKET-FIRST (issue #2 product rule)', () => {
  const viewer = { role_type: 'Law Firm Partner', city: 'Washington', expertise: ['Litigation', 'Legal'] }
  const gc = { id: 'gc', role_type: 'General Counsel' }
  const exec = { id: 'exec', role_type: 'COO' }
  const clonePeer = { id: 'clone', role_type: 'Law Firm Partner', city: 'Washington', expertise: ['Litigation', 'Compliance', 'Legal'] }
  const attorneyPeer = { id: 'atty', role_type: 'Law Firm Attorney', city: 'Washington', expertise: ['Regulatory', 'Legal'] }

  it('CASE A — ≥2 cross-market candidates → 0 same-side law firm in the top 2', () => {
    const top2 = applyLawFirmCompositionPolicy([clonePeer, attorneyPeer, gc, exec], viewer).slice(0, 2)
    expect(top2.filter((c) => isLawFirmLawyer(c))).toHaveLength(0)
    expect(top2.map((c) => c.id)).toEqual(['gc', 'exec'])
  })
  it('CASE B — exactly 1 cross-market candidate → cross-market slot 1, one same-side fills slot 2', () => {
    const top2 = applyLawFirmCompositionPolicy([attorneyPeer, gc], viewer).slice(0, 2)
    expect(isLawFirmLawyer(top2[0])).toBe(false)   // gc first
    expect(top2[0].id).toBe('gc')
    expect(top2[1].id).toBe('atty')                // same-side only as fallback for slot 2
  })
  it('CASE C — 0 cross-market candidates → same-side used as fallback (not banned)', () => {
    const top2 = applyLawFirmCompositionPolicy([attorneyPeer, clonePeer], viewer).slice(0, 2)
    expect(top2).toHaveLength(2)
    expect(top2.every((c) => isLawFirmLawyer(c))).toBe(true)
  })
  it('a same-side peer never takes slot 1 when any cross-market candidate exists', () => {
    const out = applyLawFirmCompositionPolicy([attorneyPeer, gc, exec], viewer)
    expect(isLawFirmLawyer(out[0])).toBe(false)
  })
  it('partner ↔ law-firm ATTORNEY is treated as same-side (deferred behind cross-market)', () => {
    const top2 = applyLawFirmCompositionPolicy([attorneyPeer, gc, exec], viewer).slice(0, 2)
    expect(top2.map((c) => c.id)).toEqual(['gc', 'exec'])
  })
  it('leaves a non-law-firm viewer’s ranking unchanged', () => {
    const gcViewer = { role_type: 'General Counsel' }
    const input = [clonePeer, gc, attorneyPeer, exec]
    expect(applyLawFirmCompositionPolicy(input, gcViewer)).toEqual(input)
  })
})

describe('queue — active-window invariant (one active, at most one queued, never >N visible)', () => {
  it('first enqueue into an empty member becomes the ACTIVE batch', async () => {
    const c = makeClient()
    const r = await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    expect(r.placed).toBe(true)
    expect(r.visiblePlaced).toBe(2)
    expect(r.reservedPlaced).toBe(0)
    expect(batchesOf(c, 'active')).toHaveLength(1)
    expect(suggestedOf(c)).toHaveLength(2)
  })

  it('second enqueue becomes the QUEUED batch — exactly one active + one queued, only 2 visible', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    const r2 = await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'C' }, { target_user_id: 'D' }] })
    expect(r2.reservedPlaced).toBe(2)
    expect(r2.visiblePlaced).toBe(0)   // visible tier already at cap
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
    expect(r3.reason).toBe('at_capacity')   // both tiers full — nothing is evicted to make room
    expect(batchesOf(c, 'queued')).toHaveLength(1)
  })

  it('dedupes a target the member already holds', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    const r = await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'A' }] }) // A already active
    expect(r.placed).toBe(false)
    expect(r.reason).toBe('no_eligible_candidates')
  })
})

describe('queue — NOTHING IS EVER EVICTED (admin precedence removed)', () => {
  /**
   * WHAT CHANGED AND WHY. Placement used to give an admin batch precedence over the queued slot: it
   * DELETED an organic queued batch's rows and took the slot. That is a member losing a
   * recommendation they were already allocated, purely because a newer producer arrived — and it
   * made "nothing is ever evicted" false. An admin source now has no precedence over capacity: it
   * fills genuinely free slots or it is refused, and every existing row and batch is left alone.
   */
  it('an admin batch does NOT displace a full organic queue — it is refused, nothing is touched', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    const organic = await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'C' }, { target_user_id: 'D' }] })
    const before = JSON.stringify(c.__tables)

    const r = await enqueueBatch(c, { memberId: 'M', source: 'admin_reciprocal', rows: [{ target_user_id: 'X' }, { target_user_id: 'Y' }] })

    expect(r.placed).toBe(false)
    expect(r.reason).toBe('at_capacity')
    expect(JSON.stringify(c.__tables)).toBe(before)         // byte-for-byte unchanged
    expect(queuedOf(c).map((x: any) => x.target_user_id).sort()).toEqual(['C', 'D'])
    expect(batchesOf(c, 'discarded')).toHaveLength(0)       // discarding no longer exists
    expect(organic.queuedBatchId).toBeTruthy()
  })

  it('refuses to merge into a queued batch from a different producer rather than blur provenance', async () => {
    const c = makeClient()
    // visible tier full, reserved tier holds ONE organic row → a free reserved slot exists…
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'C' }] })
    const before = JSON.stringify(c.__tables)

    // …but filling it from an admin source would put an admin row inside a 'weekly' batch.
    const r = await enqueueBatch(c, { memberId: 'M', source: 'admin_reciprocal', rows: [{ target_user_id: 'X' }] })

    expect(r.placed).toBe(false)
    expect(r.reason).toBe('source_mismatch')
    expect(JSON.stringify(c.__tables)).toBe(before)
  })

  it('the SAME producer may append into its own queued batch, up to the reserved cap', async () => {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'C' }] })
    const r = await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'D' }, { target_user_id: 'E' }] })

    expect(r.reservedPlaced).toBe(1)
    expect(r.dropped).toBe(1)                                // beyond the reserved cap
    expect(queuedOf(c)).toHaveLength(2)
    expect(batchesOf(c, 'queued')).toHaveLength(1)           // appended, not a second batch
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
  it('is INELIGIBLE behind an incomplete ORGANIC active batch (queued-organic path retired), eligible when empty', async () => {
    // PART 2 permanent rule: any unresolved introduction from an active batch → ineligible.
    // (Previously an organic active batch allowed a pre-loaded queued next batch; that path is retired.)
    const organic = makeClient()
    await enqueueBatch(organic, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    expect(await weeklyEligibilityCheck(organic, 'M')).toBe(false)
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

describe('migration apply — HARD-DISABLED (it was the last unlocked writer)', () => {
  /**
   * applyBackfill was the one-time collapse of pre-queue members onto the active-window model. It
   * wrote 'suggested' and 'queued' rows directly, with no member advisory lock and no cap check —
   * exactly the shape of writer that migration 063 exists to eliminate. The migration it performed
   * completed in July 2026 and nothing imports it (only the READ-ONLY buildBackfillReport is
   * exposed, via /api/admin/queue-backfill-report), so rather than leave a callable bypass sitting
   * in the module it now refuses to run.
   *
   * The behavioural tests that used to live here drove that writer end to end. They are gone
   * deliberately: they asserted the behaviour of a code path that no longer executes, and keeping
   * them green would have required keeping the bypass callable. What remains is the guarantee that
   * matters now — it cannot write.
   */
  it('throws instead of writing, and names the RPCs that own these rows', async () => {
    const c = makeClient({
      profiles: [{ id: 'M', role_type: 'gc' }],
      intro_requests: [
        { requester_id: 'M', target_user_id: 'A', status: 'suggested', batch_id: null },
        { requester_id: 'M', target_user_id: 'B', status: 'suggested', batch_id: null },
        { requester_id: 'M', target_user_id: 'C', status: 'suggested', batch_id: null },
      ],
    })
    await expect(applyBackfill(c)).rejects.toThrow(/disabled/i)
    // nothing moved: still three untouched suggested rows and no batch metadata
    expect(c.__tables.intro_requests.filter((r: any) => r.status === 'suggested')).toHaveLength(3)
    expect(c.__tables.intro_requests.every((r: any) => r.batch_id === null)).toBe(true)
    expect(c.__tables.recommendation_batches).toHaveLength(0)
  })

  it('the read-only report is untouched and still callable', async () => {
    const c = makeClient({ profiles: [], intro_requests: [], batch_suggestions: [] })
    const report = await buildBackfillReport(c)
    expect(report.batchSize).toBe(RECOMMENDATIONS_PER_BATCH)
    expect(c.__tables.intro_requests).toHaveLength(0)   // a report mutates nothing
  })
})

describe('tiered introduction-history model (queue lifecycle ↔ exclusion)', () => {
  it('every placed pair stays in history — there is no longer a discard path that erases one', async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE. An admin batch displaced an organic queued batch by
    // DELETING its rows, so those pairs left no history and became eligible again. Eviction is gone
    // (see "NOTHING IS EVER EVICTED" above): the admin batch is refused instead, so C and D keep
    // their queued rows and stay in the active window.
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] })
    await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'C' }, { target_user_id: 'D' }] })
    const refused = await enqueueBatch(c, { memberId: 'M', source: 'admin_reciprocal', rows: [{ target_user_id: 'E' }, { target_user_id: 'F' }] })
    expect(refused.placed).toBe(false)

    const rows = c.__tables.intro_requests.filter((r: any) => r.requester_id === 'M' || r.target_user_id === 'M')
    const { hardExcluded } = classifyIntroHistory('M', rows)
    // suggested AND queued are the active window → all four are HARD-excluded
    for (const id of ['A', 'B', 'C', 'D']) expect(hardExcluded.has(id)).toBe(true)
    // E and F were never written, so they carry no history and remain eligible
    expect(hardExcluded.has('E')).toBe(false)
    expect(hardExcluded.has('F')).toBe(false)
    expect(c.__tables.recommendation_batches.filter((b: any) => b.state === 'discarded')).toHaveLength(0)
  })

  it('regeneration: committed pairs HARD, shown-no-commitment SOFT, artifact eligible, fresh candidate eligible', () => {
    const c = makeClient({
      intro_requests: [
        { requester_id: 'M', target_user_id: 'P', status: 'pending' },            // HARD
        { requester_id: 'M', target_user_id: 'S', status: 'archived', batch_id: 'b1' }, // SOFT (shown)
        { requester_id: 'M', target_user_id: 'A', status: 'archived', batch_id: null }, // ARTIFACT → eligible
        { requester_id: 'Q', target_user_id: 'M', status: 'declined' },           // inbound HARD (bidirectional)
      ],
    })
    const rows = c.__tables.intro_requests.filter((r: any) => r.requester_id === 'M' || r.target_user_id === 'M')
    const { hardExcluded, softExcluded } = classifyIntroHistory('M', rows)
    expect(hardExcluded.has('P')).toBe(true)   // pending committed
    expect(hardExcluded.has('Q')).toBe(true)   // inbound declined — bidirectional
    expect(softExcluded.has('S')).toBe(true)   // shown archived — releasable
    expect(hardExcluded.has('A')).toBe(false)  // backfill artifact — eligible
    expect(softExcluded.has('A')).toBe(false)
    expect(hardExcluded.has('FRESH')).toBe(false) // fresh candidate stays eligible
  })
})

describe('Express Interest → promoteIfResolved (queue advances only on FINAL resolution)', () => {
  async function setup() {
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'onboarding', rows: [{ target_user_id: 'A' }, { target_user_id: 'B' }] }) // ACTIVE
    await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'C' }, { target_user_id: 'D' }] })       // QUEUED
    return c
  }
  // Express Interest updates the suggested row in place to 'approved' (per the route).
  const express = (c: any, target: string) =>
    c.from('intro_requests').update({ status: 'approved' }).eq('requester_id', 'M').eq('target_user_id', target)

  it('expressing interest in the FINAL remaining introduction promotes the queued batch', async () => {
    const c = await setup()
    await express(c, 'A')
    const r1 = await promoteIfResolved(c, 'M') // fix runs after each express
    expect(r1.promoted).toBe(false) // B still open → no promotion

    await express(c, 'B')
    const r2 = await promoteIfResolved(c, 'M')
    expect(r2.promoted).toBe(true)
    expect(suggestedOf(c).map((x: any) => x.target_user_id).sort()).toEqual(['C', 'D']) // queued revealed
    expect(queuedOf(c)).toHaveLength(0)
    expect(batchesOf(c, 'active')).toHaveLength(1) // invariant: exactly one active batch
  })

  it('expressing interest in ONLY ONE of two introductions does NOT promote the queued batch', async () => {
    const c = await setup()
    await express(c, 'A')
    const r = await promoteIfResolved(c, 'M')
    expect(r.promoted).toBe(false)
    expect((r as any).reason).toBe('incomplete')
    expect(suggestedOf(c).map((x: any) => x.target_user_id).sort()).toEqual(['B']) // B stays visible
    expect(queuedOf(c).map((x: any) => x.target_user_id).sort()).toEqual(['C', 'D']) // queued NOT revealed
    expect(batchesOf(c, 'active')).toHaveLength(1)
  })

  it('accepted_pending_payment occupies the slot — a new batch never re-introduces that pair', async () => {
    const c = makeClient({ intro_requests: [{ requester_id: 'M', target_user_id: 'X', status: 'accepted_pending_payment', batch_id: 'old' }] })
    const r = await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: [{ target_user_id: 'X' }, { target_user_id: 'Y' }] })
    expect(r.placed).toBe(true)
    const placed = c.__tables.intro_requests
      .filter((row: any) => row.requester_id === 'M' && row.status !== 'accepted_pending_payment')
      .map((row: any) => row.target_user_id)
    expect(placed).toContain('Y')     // fresh target placed
    expect(placed).not.toContain('X') // mid-payment pair deduped away
  })
})
