/**
 * GLOBAL LEXICOGRAPHIC b-MATCHING for admin reciprocal batches.
 *
 * WHY THIS EXISTS
 * ---------------
 * The previous pipeline was greedy b-matching + two coverage fills + a bounded
 * "repair" pass restricted to members sitting at EXACTLY one card. That chain is not a
 * b-matching solver and provably strands members. Measured against the real exported
 * functions over 4,000 random 4–7 member graphs: in 282 cases a feasible assignment
 * existed that was >= the pipeline's result for EVERY member and strictly better for at
 * least one (so nobody had to be sacrificed), and in 214 of those a perfect assignment
 * giving everyone two cards existed. 65% of the misses involved a member left at ZERO,
 * whom repairOneIntroCoverage cannot help because it only iterates degree-1 members.
 *
 * The canonical counterexample, which this module's tests pin:
 *     members A,B,C,D   edges AB AC AD BC BD
 *     greedy takes the triangle AB/AC/BC  -> A2 B2 C2 D0   (D gets nothing)
 *     the 4-cycle A-C-B-D-A              -> A2 B2 C2 D2
 * Coverage fill cannot repair it (A and B are already at cap, so no edge can be ADDED),
 * and the repair pass never even considers D.
 *
 * WHAT THIS DOES
 * --------------
 * An EXACT lexicographic optimizer over the deficit subgraph, by depth-first
 * branch-and-bound with admissible bounds and a hard node budget. The unit of choice is
 * an UNDIRECTED EDGE, which consumes one unit of capacity from BOTH endpoints — so
 * reciprocity is a property of the representation, not a post-process, and a one-sided
 * result is unrepresentable.
 *
 * Members already at capacity have deficit 0, are therefore incident to no selectable
 * edge, and cannot be disturbed.
 *
 * LEXICOGRAPHIC OBJECTIVE (strict; a later term never trades against an earlier one)
 *   1. maximize  # zero-card members receiving at least one pair
 *   2. maximize  # underfilled members receiving at least one pair
 *   3. maximize  total deficit filled (each edge fills one unit at each endpoint)
 *   4. maximize  total ADJUSTED match quality  (raw edge weight + bounded policy adjustment)
 *   5. minimize  exposure concentration (sum of squared final card counts)
 *   6. deterministic tiebreak: smallest sorted pair-key sequence
 *
 * WHY PAIR TYPE IS NOT ITS OWN OBJECTIVE. An earlier revision ranked cross-market legal
 * composition ABOVE quality. That is wrong: a lexicographic pair-type term lets a barely
 * qualifying cross-market edge beat an arbitrarily stronger same-side one, because no
 * quality difference — however large — can outrank a term above it. The preference belongs
 * inside objective 4 as a BOUNDED weight adjustment, where the maximum trade-off is a
 * finite, stated number of score points.
 *
 * With the authoritative legalSameSidePenalty supplied as `qualityAdjustment` (applied once
 * per direction, so twice per undirected edge), the ceiling is exactly:
 *     Law Firm Partner  <-> Law Firm Partner    2 x -60  = -120 mutual points
 *     Law Firm Partner  <-> law-firm attorney   2 x -45  =  -90 mutual points
 *     law-firm attorney <-> law-firm attorney   2 x -30  =  -60 mutual points
 * A same-side edge whose raw mutual score exceeds the cross-market alternative by more than
 * that margin still wins. The preference therefore cannot select an arbitrarily weaker
 * cross-market match, and a materially stronger same-side pairing remains reachable.
 *
 * HARD GATES vs PREFERENCES — the distinction is deliberate and load-bearing:
 *   HARD (the caller must have removed these edges before calling; this module never
 *   re-admits them): eligibility, same-company, blocking, existing matches, hard intro
 *   history, cooldown, availability tier, and the minimum score threshold.
 *   PREFERENCE (expressed in the objective, never as a filter): cross-market legal
 *   composition, match quality, exposure spread. A preference can lose to coverage; a
 *   hard gate cannot lose to anything.
 *
 *   The minimum score threshold is a HARD GATE applied by the caller to the UNADJUSTED
 *   score. The legal adjustment moves ranking only. Keeping those separate is deliberate:
 *   subtracting the penalty before the gate would push same-side edges below the floor and
 *   delete them from the pool, which is precisely the failure lib/matching/batch-scoring.ts
 *   documents at line 275 — it would leave a member with zero introductions rather than one.
 *
 * DETERMINISM. Edges are ordered once, by (mutualScore desc, pairKey asc). Branching is
 * include-then-exclude in that fixed order, and objective 7 breaks any remaining tie by
 * pair-key sequence, so identical input yields identical output on every run and host.
 *
 * BOUNDS. Search is capped by `nodeBudget`. On exhaustion the best incumbent is returned
 * with `exact: false` and a reason — the result is still feasible and still respects
 * every hard gate; only optimality is surrendered, and it is reported rather than hidden.
 */

export interface BEdge {
  userA: { id: string; role_type?: string | null }
  userB: { id: string; role_type?: string | null }
  mutualScore: number
}

export interface BMatchConfig {
  /** Remaining capacity for a member: 2 - current cards. Members at 0 are excluded. */
  deficitOf: (memberId: string) => number
  /** Cards the member already holds; used only by objective 6 (exposure spread). */
  existingCardsOf?: (memberId: string) => number
  /**
   * BOUNDED quality adjustment applied to an edge's weight for optimisation only.
   *
   * This is where the cross-market legal preference lives. It is deliberately NOT a
   * separate lexicographic objective: a pair-type objective ranked above quality would let
   * a barely-qualifying cross-market edge beat an arbitrarily stronger same-side one. As a
   * bounded weight adjustment the trade-off is capped and provable — see the module header.
   *
   * It is applied to the RANKING weight only, never to the eligibility gate: the caller
   * still admits edges on their unadjusted score, so a same-side edge cannot be pushed
   * below the relevance floor and out of the pool. That is the exact objection recorded at
   * lib/matching/batch-scoring.ts:275, and honouring it is what keeps the last-resort
   * fallback alive for a member who would otherwise get nothing.
   *
   * Defaults to 0 (no adjustment).
   */
  qualityAdjustment?: (a: { role_type?: string | null }, b: { role_type?: string | null }) => number

  /**
   * BUSINESS-SOLUTION THROTTLE — a HARD constraint, ported from the previous selection pass.
   * `providerCapOf` is how many provider edges a member may receive as a BUYER;
   * `isProviderFor(member, other)` is true when `other` counts against that member's quota.
   * Peer edges (both providers, or an explicitly exempt pair such as legal<->legal) must return
   * false from isProviderFor, exactly as the old path treated them.
   * Omit both to disable the throttle.
   */
  providerCapOf?: (memberId: string) => number
  isProviderFor?: (member: { role_type?: string | null }, other: { role_type?: string | null }) => boolean

  /**
   * ROLE DIVERSITY — a PREFERENCE, not a limit, which is what the previous pipeline's own
   * comment called it ("role diversity is a PREFERENCE, not a hard limit") before relaxing it in
   * the coverage fill. Modelled here as a bounded penalty per repeated role beyond `roleCapOf`,
   * subtracted from quality. A hard cap would be a coverage regression: with a per-member cap of
   * 2 the diversity cap evaluates to 1, i.e. "never two partners of the same role", which in a
   * small network is exactly what strands members.
   */
  roleOf?: (m: { role_type?: string | null }) => string
  roleCapOf?: (memberId: string) => number
  roleRepeatPenalty?: number
  /** Search cap. Exceeding it returns the incumbent with exact:false. */
  nodeBudget?: number
}

export interface BMatchResult<E extends BEdge> {
  selected: E[]
  degree: Map<string, number>
  /** True when the search space was fully explored and the answer is provably optimal. */
  exact: boolean
  /** Set when exact === false. */
  reason?: 'node_budget_exhausted' | 'component_edge_cap'
  nodesExplored: number
  objective: number[]
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * Search budget per component, sized from MEASUREMENT rather than taste.
 *
 * Measured on cohort-shaped instances (24 underfilled members, 12 holding zero cards and
 * 12 holding one, which is the shape the production audit found):
 *     ~25% edge density,  60 edges  ->        137 nodes,    <1 ms, exact
 *     ~50% edge density, 132 edges  ->      4,568 nodes,     4 ms, exact
 *     ~40% edge density, 110 edges  ->  1,895,559 nodes, 1,134 ms, exact   <- worst observed
 * Density near 40% is the hard region: sparse graphs have few choices and dense ones have
 * many equivalent optima that prune quickly, while the middle has neither advantage.
 *
 * 2,000,000 covers the worst measured cohort case with headroom. Admin batch generation is
 * a manual, infrequent operation, so ~1s of search is a good trade for provable optimality.
 * Components that still exceed it return a feasible answer with exact:false — never a
 * silently degraded one.
 */
const DEFAULT_NODE_BUDGET = 2_000_000
/**
 * Per-component edge ceiling. Above this the component is reduced to each member's top-K
 * edges before searching. This is what makes runtime AND STACK DEPTH bounded: search
 * recursion is one frame per edge, so an unbounded edge list is a crash, not just a slow
 * run. Exceeding the ceiling is reported as exact:false — never hidden.
 */
const MAX_COMPONENT_EDGES = 220
const TOP_K_PER_MEMBER = 8

/** Compare two lexicographic objective tuples. > 0 when `x` is strictly better. */
export function compareObjective(x: number[], y: number[]): number {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const a = x[i] ?? 0, b = y[i] ?? 0
    if (a !== b) return a - b
  }
  return 0
}

/**
 * Solve one connected component exactly (subject to the node budget).
 * Exported for tests; callers should use solveGlobalBMatching.
 */
export function solveComponent<E extends BEdge>(
  edges: E[],
  config: BMatchConfig,
): BMatchResult<E> {
  const adjust = config.qualityAdjustment ?? (() => 0)
  const provCapOf = config.providerCapOf ?? (() => Number.POSITIVE_INFINITY)
  const isProvFor = config.isProviderFor ?? (() => false)
  const roleOf = config.roleOf ?? ((m: { role_type?: string | null }) => String(m?.role_type ?? 'unknown'))
  const roleCapOf = config.roleCapOf ?? (() => Number.POSITIVE_INFINITY)
  const rolePenalty = config.roleRepeatPenalty ?? 0
  const budget = config.nodeBudget ?? DEFAULT_NODE_BUDGET
  const existingOf = config.existingCardsOf ?? (() => 0)

  // ── Restrict to the deficit subgraph. An edge is selectable only when BOTH endpoints
  // still have capacity; members at capacity are therefore untouchable by construction.
  const cap = new Map<string, number>()
  const capOf = (id: string) => {
    if (!cap.has(id)) cap.set(id, Math.max(0, config.deficitOf(id)))
    return cap.get(id)!
  }
  const usable0 = edges.filter((e) =>
    e.userA.id !== e.userB.id &&                       // a self-pair is never a recommendation
    capOf(e.userA.id) > 0 && capOf(e.userB.id) > 0)

  // DEDUPE BY UNORDERED PAIR. The caller may legitimately supply {A,B} and {B,A}, or the
  // same pair from two sources. Treating them as distinct edges would let the optimizer
  // select both and recommend the same two people to each other TWICE — a duplicate pair,
  // which every downstream gate forbids. Keep the best-scoring representative; ties break
  // on the endpoint ids so the choice is deterministic rather than input-order dependent.
  const byPair = new Map<string, E>()
  for (const e of usable0) {
    const key = pairKey(e.userA.id, e.userB.id)
    const prev = byPair.get(key)
    if (!prev) { byPair.set(key, e); continue }
    if (e.mutualScore > prev.mutualScore ||
        (e.mutualScore === prev.mutualScore && e.userA.id < prev.userA.id)) byPair.set(key, e)
  }
  const usable = Array.from(byPair.values())

  const ids: string[] = []
  const seen = new Set<string>()
  for (const e of usable) for (const m of [e.userA, e.userB]) {
    if (!seen.has(m.id)) { seen.add(m.id); ids.push(m.id) }
  }
  ids.sort()

  // Deterministic edge order: quality desc, then pair key asc.
  const ordered = usable.slice().sort((x, y) =>
    y.mutualScore - x.mutualScore ||
    pairKey(x.userA.id, x.userB.id).localeCompare(pairKey(y.userA.id, y.userB.id)))

  const n = ordered.length
  const isZeroCard = (id: string) => existingOf(id) === 0
  /** Adjusted ranking weight: the raw edge weight plus the bounded policy adjustment. */
  const weightOf = (e: E) => e.mutualScore + adjust(e.userA, e.userB)
  const adjW = ordered.map(weightOf)

  // Remaining incident-edge counts, for the admissible coverage bound.
  const remainingIncident = new Map<string, number>()
  for (const id of ids) remainingIncident.set(id, 0)
  for (const e of ordered) {
    remainingIncident.set(e.userA.id, remainingIncident.get(e.userA.id)! + 1)
    remainingIncident.set(e.userB.id, remainingIncident.get(e.userB.id)! + 1)
  }

  const deg = new Map<string, number>(ids.map((i) => [i, 0]))
  const prov = new Map<string, number>(ids.map((i) => [i, 0]))   // provider edges received, as buyer
  const chosen: number[] = []
  let best: number[] | null = null
  let bestChosen: number[] = []
  let nodes = 0
  let exhausted = false

  const zeroCardIds = ids.filter(isZeroCard)

  const objectiveOf = (sel: number[]): number[] => {
    const d = new Map<string, number>(ids.map((i) => [i, 0]))
    let quality = 0
    const roleSeen = new Map<string, Map<string, number>>()
    const bumpRole = (owner: string, role: string) => {
      let mm = roleSeen.get(owner); if (!mm) { mm = new Map(); roleSeen.set(owner, mm) }
      const n = (mm.get(role) ?? 0) + 1; mm.set(role, n)
      if (n > roleCapOf(owner)) quality -= rolePenalty   // soft: over-cap repeats cost quality
    }
    for (const i of sel) {
      const e = ordered[i]
      d.set(e.userA.id, d.get(e.userA.id)! + 1)
      d.set(e.userB.id, d.get(e.userB.id)! + 1)
      quality += adjW[i]
      if (rolePenalty > 0) { bumpRole(e.userA.id, roleOf(e.userB)); bumpRole(e.userB.id, roleOf(e.userA)) }
    }
    const zeroCovered = zeroCardIds.filter((i) => d.get(i)! >= 1).length
    const anyCovered = ids.filter((i) => d.get(i)! >= 1).length
    const filled = ids.reduce((s, i) => s + Math.min(d.get(i)!, capOf(i)), 0)
    // Objective 6 is MINIMIZED, so it enters the tuple negated.
    const spread = -ids.reduce((s, i) => { const t = existingOf(i) + d.get(i)!; return s + t * t }, 0)
    return [zeroCovered, anyCovered, filled, quality, spread]
  }

  // Suffix sums over the score-sorted edge list. Because `ordered` is sorted by score
  // descending, the M highest-scoring edges still available from position `idx` are
  // exactly ordered[idx .. idx+M-1] — so a prefix walk gives a tight, admissible cap.
  // Bound on the ADJUSTED weight. Adjustments may be negative, so the optimistic cap uses
  // max(0, w): a negative-weight edge can always be declined, never forced.
  const suffixQuality: number[] = new Array(n + 1).fill(0)
  for (let i = n - 1; i >= 0; i--) suffixQuality[i] = suffixQuality[i + 1] + Math.max(0, adjW[i])
  const topQualityFrom = (idx: number, take: number) => {
    if (take <= 0) return 0
    const end = Math.min(n, idx + take)
    return suffixQuality[idx] - suffixQuality[end]
  }

  /**
   * Admissible optimistic bound: never underestimates what the remaining edges can add.
   *
   * The capacity cap is what makes it tight. At most floor(totalSpare / 2) further edges
   * can EVER be selected, because each consumes two units of spare capacity. Bounding
   * quality and the legal term by the best that many remaining edges — rather than by
   * every remaining edge — is what lets the search actually prune instead of enumerating
   * every equal-coverage arrangement.
   */
  const bound = (idx: number, curZero: number, curAny: number, curFilled: number,
                 curQuality: number): number[] => {
    let addZero = 0, addAny = 0, totalSpare = 0
    for (const id of ids) {
      const d = deg.get(id)!
      const spare = capOf(id) - d
      if (spare <= 0) continue
      const reach = remainingIncident.get(id)!
      if (reach <= 0) continue
      if (d === 0) { addAny++; if (isZeroCard(id)) addZero++ }
      totalSpare += Math.min(spare, reach)
    }
    const maxMoreEdges = Math.min(n - idx, Math.floor(totalSpare / 2))
    const addFilled = Math.min(totalSpare, 2 * maxMoreEdges)
    return [curZero + addZero, curAny + addAny, curFilled + addFilled,
            curQuality + topQualityFrom(idx, maxMoreEdges), 0]
  }

  /**
   * Seed the incumbent with a coverage-first greedy solution. A strong initial bound is
   * worth far more than any single pruning rule: without it the search wanders through
   * millions of equal-coverage arrangements before finding anything to prune against.
   * This is a STARTING POINT only — the search still proves or improves on it.
   */
  const seedIncumbent = () => {
    const d = new Map<string, number>(ids.map((i) => [i, 0]))
    const pv = new Map<string, number>(ids.map((i) => [i, 0]))
    const okThrottle = (e: E) => (!isProvFor(e.userA, e.userB) || pv.get(e.userA.id)! < provCapOf(e.userA.id))
                              && (!isProvFor(e.userB, e.userA) || pv.get(e.userB.id)! < provCapOf(e.userB.id))
    const takeProv = (e: E) => {
      if (isProvFor(e.userA, e.userB)) pv.set(e.userA.id, pv.get(e.userA.id)! + 1)
      if (isProvFor(e.userB, e.userA)) pv.set(e.userB.id, pv.get(e.userB.id)! + 1)
    }
    const picked: number[] = []
    // Pass 1: cover members with no card at all; Pass 2: everyone else; Pass 3: top up.
    for (const wantUncovered of [true, false]) {
      for (let i = 0; i < n; i++) {
        const e = ordered[i]
        const a = e.userA.id, b = e.userB.id
        if (d.get(a)! >= capOf(a) || d.get(b)! >= capOf(b) || !okThrottle(e)) continue
        const helps = wantUncovered
          ? (d.get(a) === 0 && isZeroCard(a)) || (d.get(b) === 0 && isZeroCard(b))
          : d.get(a) === 0 || d.get(b) === 0
        if (!helps) continue
        d.set(a, d.get(a)! + 1); d.set(b, d.get(b)! + 1); takeProv(e); picked.push(i)
      }
    }
    for (let i = 0; i < n; i++) {
      const e = ordered[i]
      if (picked.includes(i)) continue
      const a = e.userA.id, b = e.userB.id
      if (d.get(a)! >= capOf(a) || d.get(b)! >= capOf(b) || !okThrottle(e)) continue
      d.set(a, d.get(a)! + 1); d.set(b, d.get(b)! + 1); takeProv(e); picked.push(i)
    }
    picked.sort((x, y) => x - y)
    best = objectiveOf(picked)
    bestChosen = picked
  }
  seedIncumbent()

  const dfs = (idx: number, curZero: number, curAny: number, curFilled: number,
               curQuality: number): void => {
    if (exhausted) return
    if (++nodes > budget) { exhausted = true; return }
    if (best !== null) {
      const b = bound(idx, curZero, curAny, curFilled, curQuality)
      // Compare only the first four terms; `spread` and the pair-key tiebreak are settled
      // at leaves, where the true value is known.
      if (compareObjective(b.slice(0, 4), best.slice(0, 4)) < 0) return
    }
    if (idx === n) {
      const obj = objectiveOf(chosen)
      if (best === null || compareObjective(obj, best) > 0) { best = obj; bestChosen = chosen.slice() }
      else if (compareObjective(obj, best) === 0) {
        // Objective 7 — deterministic: prefer the lexicographically smallest key sequence.
        const keyOf = (sel: number[]) => sel
          .map((i) => pairKey(ordered[i].userA.id, ordered[i].userB.id)).sort().join(',')
        if (keyOf(chosen) < keyOf(bestChosen)) bestChosen = chosen.slice()
      }
      return
    }
    const e = ordered[idx]
    const a = e.userA.id, b = e.userB.id
    // Branch 1: INCLUDE (tried first so a good incumbent appears early and prunes hard).
    const aTakesProv = isProvFor(e.userA, e.userB)
    const bTakesProv = isProvFor(e.userB, e.userA)
    const throttleOk = (!aTakesProv || prov.get(a)! < provCapOf(a))
                    && (!bTakesProv || prov.get(b)! < provCapOf(b))
    if (deg.get(a)! < capOf(a) && deg.get(b)! < capOf(b) && throttleOk) {
      const za = deg.get(a) === 0, zb = deg.get(b) === 0
      deg.set(a, deg.get(a)! + 1); deg.set(b, deg.get(b)! + 1)
      if (aTakesProv) prov.set(a, prov.get(a)! + 1)
      if (bTakesProv) prov.set(b, prov.get(b)! + 1)
      remainingIncident.set(a, remainingIncident.get(a)! - 1)
      remainingIncident.set(b, remainingIncident.get(b)! - 1)
      chosen.push(idx)
      const dz = (za && isZeroCard(a) ? 1 : 0) + (zb && isZeroCard(b) ? 1 : 0)
      const dany = (za ? 1 : 0) + (zb ? 1 : 0)
      dfs(idx + 1, curZero + dz, curAny + dany, curFilled + 2, curQuality + adjW[idx])
      chosen.pop()
      deg.set(a, deg.get(a)! - 1); deg.set(b, deg.get(b)! - 1)
      if (aTakesProv) prov.set(a, prov.get(a)! - 1)
      if (bTakesProv) prov.set(b, prov.get(b)! - 1)
      remainingIncident.set(a, remainingIncident.get(a)! + 1)
      remainingIncident.set(b, remainingIncident.get(b)! + 1)
    } else {
      remainingIncident.set(a, remainingIncident.get(a)! - 1)
      remainingIncident.set(b, remainingIncident.get(b)! - 1)
      dfs(idx + 1, curZero, curAny, curFilled, curQuality)
      remainingIncident.set(a, remainingIncident.get(a)! + 1)
      remainingIncident.set(b, remainingIncident.get(b)! + 1)
      return
    }
    // Branch 2: EXCLUDE.
    remainingIncident.set(a, remainingIncident.get(a)! - 1)
    remainingIncident.set(b, remainingIncident.get(b)! - 1)
    dfs(idx + 1, curZero, curAny, curFilled, curQuality)
    remainingIncident.set(a, remainingIncident.get(a)! + 1)
    remainingIncident.set(b, remainingIncident.get(b)! + 1)
  }

  dfs(0, 0, 0, 0, 0)

  const selected = bestChosen.map((i) => ordered[i])
  const degree = new Map<string, number>()
  for (const e of selected) {
    degree.set(e.userA.id, (degree.get(e.userA.id) ?? 0) + 1)
    degree.set(e.userB.id, (degree.get(e.userB.id) ?? 0) + 1)
  }
  return {
    selected,
    degree,
    exact: !exhausted,
    ...(exhausted ? { reason: 'node_budget_exhausted' as const } : {}),
    nodesExplored: nodes,
    objective: best ?? [0, 0, 0, 0, 0],
  }
}

// ── Aggregate, identity-free reporting ──────────────────────────────────────────────

/**
 * The shared classifiers (isLegalProfessional, isBusinessSolutionProvider) are typed
 * `{ role_type?: string }` while members here carry `string | null`. Function parameters
 * are contravariant, so those predicates are not directly assignable. This adapter makes
 * the impedance explicit in ONE place instead of scattering `?? undefined` through every
 * call site — and keeps the shared helpers, which are the authoritative classifiers,
 * unmodified.
 */
export const nullSafeRole =
  (p: (m: { role_type?: string }) => boolean) =>
  (m: { role_type?: string | null }): boolean => p({ role_type: m.role_type ?? undefined })

export type PairType =
  | 'law_firm__in_house' | 'law_firm__exec_or_other' | 'law_firm__law_firm'
  | 'in_house__exec_or_other' | 'other'

/**
 * Bucket an edge for aggregate reporting. Classification comes ONLY from the controlled
 * role_type enum, via the same helpers the scorers use — never from display titles.
 */
export function classifyPair(
  a: { role_type?: string | null }, b: { role_type?: string | null },
  isLawFirm: (m: { role_type?: string | null }) => boolean,
  isLegalProfessional: (m: { role_type?: string | null }) => boolean,
): PairType {
  const la = isLawFirm(a), lb = isLawFirm(b)
  const inHouse = (m: { role_type?: string | null }) => isLegalProfessional(m) && !isLawFirm(m)
  if (la && lb) return 'law_firm__law_firm'
  if (la || lb) {
    const other = la ? b : a
    return inHouse(other) ? 'law_firm__in_house' : 'law_firm__exec_or_other'
  }
  if (inHouse(a) !== inHouse(b)) return 'in_house__exec_or_other'
  return 'other'
}

/** Counts by pair type. Contains no identifiers of any kind. */
export function pairTypeCounts<E extends BEdge>(
  selected: E[],
  isLawFirm: (m: { role_type?: string | null }) => boolean,
  isLegalProfessional: (m: { role_type?: string | null }) => boolean,
): Record<PairType, number> {
  const out: Record<PairType, number> = {
    law_firm__in_house: 0, law_firm__exec_or_other: 0, law_firm__law_firm: 0,
    in_house__exec_or_other: 0, other: 0,
  }
  for (const e of selected) out[classifyPair(e.userA, e.userB, isLawFirm, isLegalProfessional)]++
  return out
}

/**
 * Why each still-underfilled member remained underfilled, as COUNTS ONLY.
 * No member id, name, email, company or profile field appears in the output.
 */
export function underfillReasonCounts<E extends BEdge>(
  memberIds: string[],
  selected: E[],
  candidateEdges: E[],
  deficitOf: (id: string) => number,
): Record<string, number> {
  const deg = new Map<string, number>()
  for (const e of selected) {
    deg.set(e.userA.id, (deg.get(e.userA.id) ?? 0) + 1)
    deg.set(e.userB.id, (deg.get(e.userB.id) ?? 0) + 1)
  }
  const incident = new Map<string, number>()
  for (const e of candidateEdges) {
    incident.set(e.userA.id, (incident.get(e.userA.id) ?? 0) + 1)
    incident.set(e.userB.id, (incident.get(e.userB.id) ?? 0) + 1)
  }
  const out: Record<string, number> = {
    filled_to_capacity: 0,
    no_scored_candidate_edge: 0,
    fewer_candidate_edges_than_deficit: 0,
    candidates_exhausted_by_higher_priority_coverage: 0,
  }
  for (const id of memberIds) {
    const want = deficitOf(id), got = deg.get(id) ?? 0
    if (got >= want) { out.filled_to_capacity++; continue }
    const inc = incident.get(id) ?? 0
    if (inc === 0) out.no_scored_candidate_edge++
    else if (inc < want) out.fewer_candidate_edges_than_deficit++
    else out.candidates_exhausted_by_higher_priority_coverage++
  }
  return out
}


// ── Public entry point: exact component decomposition + bounded search ───────────────
//
// Components share no member, so no edge can ever link them and their optimal solutions
// are independent. Solving each separately is therefore EXACT, and it collapses both the
// search space and the recursion depth from "all edges" to "edges in the largest
// component" — which is what makes this safe to run on a growing network.

export function solveGlobalBMatching<E extends BEdge>(
  edges: E[],
  config: BMatchConfig,
): BMatchResult<E> {
  const capOf = (id: string) => Math.max(0, config.deficitOf(id))
  const live = edges.filter((e) =>
    e.userA.id !== e.userB.id && capOf(e.userA.id) > 0 && capOf(e.userB.id) > 0)

  // Union-find over members, to split the deficit subgraph into components.
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    if (!parent.has(x)) { parent.set(x, x); return x }
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    while (parent.get(x) !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx }
    return r
  }
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb) }
  for (const e of live) union(e.userA.id, e.userB.id)

  const groups = new Map<string, E[]>()
  for (const e of live) {
    const r = find(e.userA.id)
    const g = groups.get(r); if (g) g.push(e); else groups.set(r, [e])
  }
  // Deterministic component order.
  const keys = Array.from(groups.keys()).sort()

  const selected: E[] = []
  const degree = new Map<string, number>()
  let exact = true
  let reason: BMatchResult<E>['reason']
  let nodesExplored = 0
  const objective = [0, 0, 0, 0, 0]

  for (const key of keys) {
    let compEdges = groups.get(key)!
    if (compEdges.length > MAX_COMPONENT_EDGES) {
      // Deterministic reduction: keep each member's TOP_K_PER_MEMBER best edges, union them.
      const byMember = new Map<string, E[]>()
      for (const e of compEdges) for (const id of [e.userA.id, e.userB.id]) {
        const l = byMember.get(id); if (l) l.push(e); else byMember.set(id, [e])
      }
      const keep = new Set<E>()
      for (const id of Array.from(byMember.keys()).sort()) {
        const list = byMember.get(id)!.slice().sort((x, y) =>
          y.mutualScore - x.mutualScore ||
          pairKey(x.userA.id, x.userB.id).localeCompare(pairKey(y.userA.id, y.userB.id)))
        for (const e of list.slice(0, TOP_K_PER_MEMBER)) keep.add(e)
      }
      compEdges = compEdges.filter((e) => keep.has(e))
      exact = false
      reason = 'component_edge_cap'
    }
    const r = solveComponent(compEdges, config)
    nodesExplored += r.nodesExplored
    if (!r.exact) { exact = false; reason = reason ?? r.reason }
    for (const e of r.selected) selected.push(e)
    for (const [id, d] of Array.from(r.degree.entries())) degree.set(id, (degree.get(id) ?? 0) + d)
    for (let i = 0; i < objective.length; i++) objective[i] += r.objective[i] ?? 0
  }

  // Deterministic output order, independent of component iteration.
  selected.sort((x, y) =>
    pairKey(x.userA.id, x.userB.id).localeCompare(pairKey(y.userA.id, y.userB.id)))

  return { selected, degree, exact, ...(reason ? { reason } : {}), nodesExplored, objective }
}

/**
 * THE cross-market legal policy adjustment for the admin batch.
 *
 * Wraps the authoritative, already-bounded legalSameSidePenalty and applies it ONCE PER
 * DIRECTION, because an undirected edge carries both directional scores in its weight.
 * Pass this as `qualityAdjustment`. Nothing else in this module knows about law firms.
 *
 * Returns 0 for every pair that is not same-side legal, so cross-market and non-legal
 * edges are untouched and compete on their genuine score alone.
 */
/**
 * CROSS-MARKET LEGAL CALIBRATION — an explicit, measured product choice.
 *
 * OPTION A (strong fallback-only): reuse legalSameSidePenalty unchanged, once per direction, giving
 * per-edge ceilings of -120 / -90 / -60. Measured against the real production score distribution
 * (mutual scores 62..166, median 98, spread 104), the crossover is +121 mutual points: a same-side
 * edge would have to reach 219 to beat a median cross-market edge. That is OUTSIDE the observed
 * range, so under Option A a same-side pair can never win on quality — it appears only when a
 * coverage objective requires it. Available as `legalPolicyAdjustment(legalSameSidePenalty)`.
 *
 * OPTION B (quality-balanced, RECOMMENDED and wired): per-direction -16 / -12 / -8, i.e. per-edge
 * -32 / -24 / -16, roughly 30% of the observed spread. Crossover is +33 mutual points, reachable at
 * 131 within the real range. Cross-market still wins every comparable case (98 vs 98, 112 vs 98,
 * 130 vs 98), so law-firm members generally meet in-house counsel and executives — while a
 * materially stronger same-side match (160 vs 84) can still win, so no member is handed a mediocre
 * introduction merely to satisfy pair composition.
 *
 * Option A was rejected because it makes a near-top-of-distribution same-side match (160) lose to a
 * below-median cross-market one (84), which conflicts with "every recommendation must still be
 * substantively strong".
 *
 * legalSameSidePenalty itself is NOT modified: it is shared with the weekly ranker in
 * lib/generate-recommendations.ts, which applies it to a different candidate list on its own terms.
 * This calibration is scoped to the admin batch optimizer alone.
 */
export const CROSS_MARKET_PER_DIRECTION = {
  partnerPartner: -16,
  partnerAttorney: -12,
  attorneyAttorney: -8,
} as const

export function crossMarketAdjustment(
  lawFirmRoleOf: (m: { role_type?: string | null }) => 'partner' | 'attorney' | null,
): (a: { role_type?: string | null }, b: { role_type?: string | null }) => number {
  return (a, b) => {
    const ra = lawFirmRoleOf(a), rb = lawFirmRoleOf(b)
    if (!ra || !rb) return 0                       // cross-market or non-legal: untouched
    const per = ra === 'partner' && rb === 'partner' ? CROSS_MARKET_PER_DIRECTION.partnerPartner
      : (ra === 'partner' || rb === 'partner') ? CROSS_MARKET_PER_DIRECTION.partnerAttorney
      : CROSS_MARKET_PER_DIRECTION.attorneyAttorney
    return 2 * per                                 // once per direction; mutualScore is a SUM
  }
}

export function legalPolicyAdjustment(
  penalty: (a: { role_type?: string | null }, b: { role_type?: string | null }) => number,
): (a: { role_type?: string | null }, b: { role_type?: string | null }) => number {
  return (a, b) => 2 * penalty(a, b)
}
