import { randomUUID } from 'node:crypto'

/**
 * In-memory MODEL of the two capacity RPCs in migration 063
 * (public.place_batch_rows, public.promote_queued_rows).
 *
 * WHY A MODEL AND NOT THE REAL THING. Placement and promotion are capacity decisions, so they were
 * moved into the database where a single transaction can hold
 * pg_advisory_xact_lock(hashtextextended(member_id)) across "count" and "write". That is the whole
 * point of the change: it is not expressible from Node. Vitest has no Postgres, so these behavioural
 * suites drive a transcription of the SQL instead.
 *
 * WHAT THIS MODEL DOES AND DOES NOT PROVE. It proves the queue's OBSERVABLE CONTRACT — which tier a
 * batch lands in, what gets deduped, what gets truncated, what promotion reveals, what it defers —
 * and it proves the TypeScript client maps arguments and results correctly. It CANNOT prove the SQL
 * text is right, and it cannot prove the locking works; a model of a lock is not a lock. Those are
 * pinned separately:
 *   • the SQL's enforcement clauses are asserted as text in unified-introduction-capacity.test.ts
 *   • the lock itself is verifiable only against a real database, and is called out as such
 *
 * ELIGIBILITY IS NOT MODELLED. The SQL re-checks every candidate against profiles eligibility,
 * blocks, matches, live-intro history and the dismissal cooldown. Those gates need real tables and
 * are proven in scripts/verify-063-concurrency.sh against PostgreSQL (scenario group 14). This model
 * covers only the CAPACITY and BATCH algorithm, so the legacy suites can keep using opaque ids. A
 * test asserts the gates exist in the SQL, so their removal cannot pass unnoticed.
 *
 * If you change the SQL, change this file in the same commit. It is deliberately written to read
 * like the SQL, in the same order, with the same branch names, so the two can be diffed by eye.
 */

// The caps are constants here exactly as they are constants in the SQL — neither the model nor the
// function accepts a capacity argument, so there is no knob for a caller to turn.
const MAX_VISIBLE = 2
const MAX_RESERVED = 2
const MAX_ROWS = 50
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const OCCUPYING = ['suggested', 'queued', 'pending', 'accepted', 'accepted_pending_payment', 'admin_pending', 'approved']
const EXPRESSED = ['pending', 'accepted', 'accepted_pending_payment', 'admin_pending', 'approved']
const BATCH_SOURCES = ['onboarding', 'weekly', 'admin_reciprocal', 'migration']

type Tables = Record<string, any[]>

/**
 * The SQL casts `target_user_id` to uuid and therefore screens each element with a uuid regex,
 * dropping anything malformed instead of raising 22P02 mid-statement. Two of the older behavioural
 * suites predate this file and identify members with opaque short labels ('M', 'A', 'B'); the id
 * FORMAT is not what those suites test, so they run with the screen relaxed. The capacity suite runs
 * with `strictUuid: true` and real uuids, and is where the screening rule itself is proven. This is
 * the ONLY behaviour the harness can vary, and it is stated rather than hidden.
 */
let STRICT_UUID = false
const validTarget = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && (!STRICT_UUID || UUID.test(v))

function placeBatchRows(t: Tables, a: any) {
  const memberId = a.p_member_id
  const now = new Date().toISOString()

  if (!memberId) return { placed: false, reason: 'invalid' }
  if (!a.p_source || !BATCH_SOURCES.includes(a.p_source)) return { placed: false, reason: 'invalid' }
  if (a.p_rows == null || !Array.isArray(a.p_rows)) return { placed: false, reason: 'invalid' }

  const supplied: any[] = a.p_rows
  if (supplied.length === 0) return { placed: false, reason: 'empty' }
  if (supplied.length > MAX_ROWS) return { placed: false, reason: 'too_many_rows', dropped: supplied.length }

  // (0) the advisory lock has no analogue here — see the header.
  const mine = () => t.intro_requests.filter((r) => r.requester_id === memberId)

  // (1) candidates, computed ONCE, before any write. The SQL needs a MATERIALIZED fence here so the
  // uuid screen provably runs before the uuid cast; JavaScript has no cast to protect, so the
  // ordering is implicit — one more thing only the real database can verify.
  const seen = new Set<string>()
  const candidates = supplied
    .filter((r) => validTarget(r?.target_user_id) && r.target_user_id !== memberId)
    .filter((r) => { if (seen.has(r.target_user_id)) return false; seen.add(r.target_user_id); return true })
    .filter((r) => !mine().some((x) => x.target_user_id === r.target_user_id && OCCUPYING.includes(x.status)))
  if (candidates.length === 0) {
    return { placed: false, reason: 'no_eligible_candidates', visible_placed: 0, reserved_placed: 0, dropped: supplied.length }
  }

  // (2) capacity from CARD COUNTS — status alone, never batch_id or pair_id.
  const visible = mine().filter((r) => r.status === 'suggested').length
  const reserved = mine().filter((r) => r.status === 'queued').length

  const nActive = t.recommendation_batches.filter((b) => b.member_id === memberId && b.state === 'active').length
  const nQueued = t.recommendation_batches.filter((b) => b.member_id === memberId && b.state === 'queued').length
  if (nActive > 1 || nQueued > 1) return { placed: false, reason: 'inconsistent_batches' }
  const active = t.recommendation_batches.find((b) => b.member_id === memberId && b.state === 'active') ?? null
  const queued = t.recommendation_batches.find((b) => b.member_id === memberId && b.state === 'queued') ?? null

  const visibleFree = Math.max(0, MAX_VISIBLE - visible)
  const reservedFree = Math.max(0, MAX_RESERVED - reserved)

  // THE TWO-TIER ALGORITHM: fill visible first, then reserved with what is left, drop only what
  // exceeds BOTH. Provenance guard: append only into a batch of the same source.
  let takeV = 0
  let takeR = 0
  if (visibleFree > 0 && (!active || active.batch_source === a.p_source)) {
    takeV = Math.min(visibleFree, candidates.length)
  }
  if (reservedFree > 0 && (!queued || queued.batch_source === a.p_source)) {
    takeR = Math.min(reservedFree, candidates.length - takeV)
  }

  if (takeV === 0 && takeR === 0) {
    return {
      placed: false,
      reason: visibleFree === 0 && reservedFree === 0 ? 'at_capacity'
            : reservedFree === 0 ? 'reserved_full'
            : 'source_mismatch',
      visible_placed: 0, reserved_placed: 0, dropped: supplied.length,
    }
  }

  // (3) writes, contiguous, last. NOTHING IS EVER EVICTED — there is no delete or discard here.
  let activeId: string | null = null
  let queuedId: string | null = null

  if (takeV > 0) {
    if (!active) {
      activeId = randomUUID()
      t.recommendation_batches.push({
        batch_id: activeId, member_id: memberId, batch_source: a.p_source, state: 'active',
        reciprocal_batch_id: a.p_reciprocal_batch_id ?? null,
        created_at: now, generated_at: now, displayed_at: now, completed_at: null,
      })
    } else {
      activeId = active.batch_id     // append; never a second active batch
    }
    for (const r of candidates.slice(0, takeV)) {
      t.intro_requests.push({
        id: randomUUID(), requester_id: memberId, target_user_id: r.target_user_id, status: 'suggested',
        match_reason: r.match_reason ?? null, batch_id: activeId, created_at: now, updated_at: now,
      })
    }
  }

  if (takeR > 0) {
    if (!queued) {
      queuedId = randomUUID()
      t.recommendation_batches.push({
        batch_id: queuedId, member_id: memberId, batch_source: a.p_source, state: 'queued',
        reciprocal_batch_id: a.p_reciprocal_batch_id ?? null,
        created_at: now, generated_at: now, displayed_at: null, completed_at: null,
      })
    } else {
      queuedId = queued.batch_id     // append; never a second queued batch
    }
    for (const r of candidates.slice(takeV, takeV + takeR)) {
      t.intro_requests.push({
        id: randomUUID(), requester_id: memberId, target_user_id: r.target_user_id, status: 'queued',
        match_reason: r.match_reason ?? null, batch_id: queuedId, created_at: now, updated_at: now,
      })
    }
  }

  return {
    placed: true,
    visible_placed: takeV,
    reserved_placed: takeR,
    dropped: supplied.length - takeV - takeR,
    active_batch_id: activeId,
    queued_batch_id: queuedId,
  }
}

function promoteQueuedRows(t: Tables, a: any) {
  const memberId = a.p_member_id
  const maxVisible = MAX_VISIBLE
  const now = new Date().toISOString()
  if (!memberId) return { promoted: false, reason: 'invalid' }

  const nActive = t.recommendation_batches.filter((b) => b.member_id === memberId && b.state === 'active').length
  const nQueued = t.recommendation_batches.filter((b) => b.member_id === memberId && b.state === 'queued').length
  if (nActive > 1 || nQueued > 1) return { promoted: false, reason: 'inconsistent_batches' }

  const mine = () => t.intro_requests.filter((r) => r.requester_id === memberId)
  const active = t.recommendation_batches.find((b) => b.member_id === memberId && b.state === 'active') ?? null
  let completed: string | null = null

  if (active) {
    // SCOPED TO THIS BATCH: rows outside it — reciprocal cards above all — never block completion.
    const unresolved = mine().filter((s) =>
      s.status === 'suggested' && s.batch_id === active.batch_id &&
      !mine().some((e) => e.target_user_id === s.target_user_id && EXPRESSED.includes(e.status))).length
    if (unresolved > 0) return { promoted: false, reason: 'incomplete' }

    for (const r of mine()) {
      if (r.batch_id === active.batch_id && r.status === 'suggested') { r.status = 'archived'; r.updated_at = now }
    }
    active.state = 'completed'; active.completed_at = now
    completed = active.batch_id
  }

  const queued = t.recommendation_batches.find((b) => b.member_id === memberId && b.state === 'queued') ?? null
  if (!queued) return { promoted: false, active_completed: completed, reason: completed ? 'empty_queue' : 'no_active' }

  const visible = mine().filter((r) => r.status === 'suggested').length
  const free = maxVisible - visible
  if (free <= 0) return { promoted: false, active_completed: completed, reason: 'deferred_capacity' }

  const rows = mine()
    .filter((r) => r.batch_id === queued.batch_id && r.status === 'queued')
    .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)) || String(x.id).localeCompare(String(y.id)))
  const promote = rows.slice(0, free)
  for (const r of promote) { r.status = 'suggested'; r.updated_at = now }

  if (promote.length === 0) {
    queued.state = 'completed'; queued.completed_at = now
    return { promoted: false, active_completed: completed, reason: 'empty_queued_batch' }
  }

  // Flip to ACTIVE first, then split leftovers into a NEW queued batch — the order the unique
  // indexes require.
  queued.state = 'active'; queued.displayed_at = now

  const leftover = rows.slice(free)
  let split: string | null = null
  if (leftover.length > 0) {
    split = randomUUID()
    t.recommendation_batches.push({
      batch_id: split, member_id: memberId, batch_source: queued.batch_source, state: 'queued',
      reciprocal_batch_id: queued.reciprocal_batch_id ?? null,
      created_at: queued.created_at, generated_at: queued.generated_at,
      displayed_at: null, completed_at: null,
    })
    for (const r of leftover) { r.batch_id = split; r.updated_at = now }
  }

  return { promoted: true, active_completed: completed, new_active: queued.batch_id, split_batch: split, count: promote.length }
}

/** Attach an `rpc()` to an in-memory Supabase mock that owns `__tables`. */
export function attachQueueRpc(client: any, opts?: { strictUuid?: boolean }) {
  client.rpc = async (name: string, args: any) => {
    STRICT_UUID = opts?.strictUuid === true
    const t = client.__tables as Tables
    if (name === 'place_batch_rows') return { data: placeBatchRows(t, args), error: null }
    if (name === 'promote_queued_rows') return { data: promoteQueuedRows(t, args), error: null }
    return { data: null, error: { code: 'PGRST202', message: 'function not found' } }
  }
  return client
}
