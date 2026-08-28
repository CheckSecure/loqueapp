import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { classifyGenerationOutcome, retryableFor } from '@/lib/generate-recommendations'

const SRC = readFileSync('lib/generate-recommendations.ts', 'utf8')
const code = SRC.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ')

/**
 * THE DEFECT. walkCandidates spends one of maxRpcCalls (8) on every candidate it tries, and
 * create_reciprocal_suggestion returns 'exists_active' instantly for an already-related pair — at
 * the cost of a call. A member with 6 open 'approved' rows had 92 eligible counterparts with free
 * slots; his already-engaged counterparts ranked highest, so 6 of 8 calls were spent on them and
 * the walk genuinely tried 2. It reported 'capacity'.
 */
describe('already-related candidates do not consume the RPC budget', () => {
  it('the prefilter runs BEFORE the walk, on the ordered list', () => {
    // Scoped to generateReciprocalBatchForMember: walkCandidates is DEFINED earlier in the file,
    // so an unscoped indexOf compares against the definition rather than the call site.
    const fn = code.slice(code.indexOf('export async function generateReciprocalBatchForMember'))
    const iPrefilter = fn.indexOf('EXISTS_ACTIVE_STATUSES.has')
    const iWalk = fn.indexOf('await walkCandidates(')
    expect(iPrefilter).toBeGreaterThan(-1)
    expect(iWalk).toBeGreaterThan(-1)
    expect(iPrefilter).toBeLessThan(iWalk)
  })

  it('its predicate mirrors 063 exists_active — statuses and the cooldown', () => {
    for (const st of ['suggested','queued','pending','accepted','accepted_pending_payment',
                      'admin_pending','approved','declined','rejected','hidden','hidden_permanent'])
      expect(code, st).toContain(`'${st}'`)
    expect(code).toMatch(/EXISTS_ACTIVE_COOLDOWN_STATUSES = new Set<string>\(\['passed', 'expired'\]\)/)
    expect(code).toMatch(/RECIPROCAL_COOLDOWN_DAYS = 30/)   // 063's p_cooldown_days DEFAULT
  })

  it('fails OPEN — a prefilter error must never stop generation', () => {
    // The filter is an optimisation; create_reciprocal_suggestion is the authority.
    expect(code).toMatch(/let ordered = orderedAll/)
    expect(code).toMatch(/catch\s*\{/)
  })

  it('never empties the pool: if everything is related, the walk still runs', () => {
    expect(code).toMatch(/ordered = filtered\.length > 0 \? filtered : orderedAll/)
  })

  // ── The label. ──
  it('all-exists_active reports already_related, NOT capacity', () => {
    const o = classifyGenerationOutcome(['exists_active', 'exists_active'],
      { createdCount: 0, candidatesEmpty: false, memberIneligible: false, timedOut: false })
    expect(o).toBe('already_related')
  })

  it('a MIX of exists_active and capacity still reports capacity', () => {
    // At least one counterpart was genuinely full, so the capacity story is true.
    const o = classifyGenerationOutcome(['exists_active', 'capacity'],
      { createdCount: 0, candidatesEmpty: false, memberIneligible: false, timedOut: false })
    expect(o).toBe('capacity')
  })

  it('pure capacity is unchanged', () => {
    expect(classifyGenerationOutcome(['capacity', 'capacity'],
      { createdCount: 0, candidatesEmpty: false, memberIneligible: false, timedOut: false })).toBe('capacity')
  })

  it('created / transient / ineligible precedence is unchanged', () => {
    const base = { candidatesEmpty: false, memberIneligible: false, timedOut: false }
    expect(classifyGenerationOutcome(['exists_active'], { ...base, createdCount: 1 })).toBe('created')
    expect(classifyGenerationOutcome(['exists_active', 'error'], { ...base, createdCount: 0 })).toBe('transient_error')
    expect(classifyGenerationOutcome(['exists_active'], { ...base, createdCount: 0, memberIneligible: true })).toBe('ineligible')
  })

  it('already_related is retryable, like capacity — the retry queue is unaffected', () => {
    expect(retryableFor('already_related')).toBe(true)
    expect(retryableFor('capacity')).toBe(true)
  })

  // ── Observation, added after three refuted explanations for a zero-result generation. ──
  it('walkCandidates records every attempt in order, both passes', () => {
    const c = code
    expect(c).toMatch(/attempts: Array<\{ id: string; outcome: ReciprocalOutcome \}>/)
    // pass 1 and the retry pass must BOTH record, or a retried candidate vanishes from the trace
    expect((c.match(/attempts\.push\(\{ id, outcome: o \}\)/g) ?? []).length).toBe(2)
  })

  it('the visible-card snapshot is taken BEFORE the walk', () => {
    const fn = code.slice(code.indexOf('export async function generateReciprocalBatchForMember'))
    expect(fn.indexOf('visibleBefore')).toBeLessThan(fn.indexOf('await walkCandidates('))
  })

  it('the snapshot never influences selection — it is read-only observation', () => {
    const fn = code.slice(code.indexOf('export async function generateReciprocalBatchForMember'))
    // `ordered` is assigned by the prefilter only; the snapshot must not filter it.
    expect(fn).not.toMatch(/ordered = ordered\.filter\([^)]*visibleBefore/)
  })

  it('diagnostics are returned to the admin caller, never logged', () => {
    const c = code
    expect(c).toMatch(/diagnostics\?: GenerationDiagnostics/)
    // The logging invariant stands: no logReciprocalGeneration call may carry an identifier.
    const calls = SRC.match(/logReciprocalGeneration\([^)]*\)/g) ?? []
    for (const call of calls) expect(call).not.toMatch(/email|\.id\b|requester_id|target_user_id|pair_id|full_name|attempts/i)
  })

  // ── 'unresolved' is not capacity. Observed: both candidates returned it while each held ONE
  //    visible card and a free slot, and the caller was told 'capacity'.
  it('all-unresolved reports counterpart_owes_response, NOT capacity', () => {
    const o = classifyGenerationOutcome(['unresolved', 'unresolved'],
      { createdCount: 0, candidatesEmpty: false, memberIneligible: false, timedOut: false })
    expect(o).toBe('counterpart_owes_response')
  })

  it('a MIX of unresolved and capacity still reports capacity', () => {
    expect(classifyGenerationOutcome(['unresolved', 'capacity'],
      { createdCount: 0, candidatesEmpty: false, memberIneligible: false, timedOut: false })).toBe('capacity')
  })

  it('counterpart_owes_response is retryable — it clears when the counterpart acts', () => {
    expect(retryableFor('counterpart_owes_response')).toBe(true)
  })

  // ── Ranker stages: the pool went 115 -> 2 and the combined filter could not say where. ──
  it('the ranker reports a count after every filter stage', () => {
    for (const k of ['eligible', 'afterHardExcluded', 'afterSameCompany', 'afterDataValid',
                     'afterSoftExcluded', 'scored', 'afterScoreFloor10', 'afterMentorship'])
      expect(code, k).toMatch(new RegExp(`${k}:`))
  })

  it('splitting the combined filter preserved its semantics (same predicates, same order)', () => {
    const c = code
    expect(c).toMatch(/afterHardExcluded = allUsers\.filter\(\(u: any\) => !hardExcluded\.has\(u\.id\)\)/)
    expect(c).toMatch(/afterSameCompany = afterHardExcluded\.filter\(\(u: any\) => !isSameCompany\(newUserProfile, u\)\)/)
    expect(c).toMatch(/base = afterSameCompany\.filter\(\(u: any\) => dataValid\(u\)\)/)
    // and the combined form is gone, so the two cannot drift
    expect(c).not.toMatch(/allUsers\.filter\(\(u: any\) => !hardExcluded\.has\(u\.id\) && !isSameCompany/)
  })

  it('empty_pool still carries the stages — that is exactly when they are needed', () => {
    expect(code).toMatch(/finish\('empty_pool', 0, 0, 0\)[\s\S]{0,120}rankerStages/)
  })
})
