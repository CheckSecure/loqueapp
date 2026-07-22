/**
 * Reciprocal recommendation graph — the unit of optimization is the GRAPH, not the
 * individual member's list.
 *
 * WHY THIS EXISTS
 * ---------------
 * The original generator built each member's recommendation list independently: every
 * member greedily kept their own top-K candidates. Nothing linked "A keeps B" to "B
 * keeps A", so a popular candidate could appear in many lists (high visibility) while
 * only ever receiving their own K picks. That produced one-way recommendations — an
 * introduction that can never become mutual — which breaks Andrel's core promise.
 *
 * THE INVARIANT (guaranteed by construction here, not patched afterward)
 * ---------------------------------------------------------------------
 *   If A is recommended to B, then B is recommended to A.
 * We model recommendations as an UNDIRECTED graph. A selected edge {A,B} is, by
 * definition, mutual: it emits exactly two rows (A→B and B→A). Because each edge
 * contributes 1 to BOTH endpoints' degree, every member's "appears-in count" equals
 * their "receives count" equals their degree — so a single per-member degree cap
 * bounds visibility and receipt simultaneously and identically. Reciprocity and the
 * two-directional cap are therefore mathematical properties of the output, impossible
 * to violate regardless of the input scores.
 *
 * THE ALGORITHM
 * -------------
 * This is a maximum-weight degree-bounded subgraph (a "b-matching") problem: choose a
 * set of edges maximizing total quality such that no vertex's degree exceeds its cap.
 * We solve it with a deterministic GREEDY b-matching: consider edges from highest
 * mutual quality to lowest and take each edge whose endpoints both still have spare
 * capacity (and whose per-member role / business-solution mix stays within the same
 * caps the old path enforced). Greedy b-matching is a well-understood 1/2-approximation
 * in the adversarial worst case, but on a real quality distribution with a small cap it
 * lands at or very near the optimum, and it is simple, explainable, and O(E log E) —
 * the right fit for this codebase's "understandable and maintainable" bar. If a future
 * quality audit ever shows a material gap, this is the single choke point to swap for
 * an exact solver (blossom / min-cost flow) without touching any caller.
 *
 * Because greedy is only LOCALLY optimal, selection runs a second phase — an
 * augmenting-path improvement (augmentForCoverage) — that reroutes edges through
 * saturated hubs to seat members greedy stranded, but only when the rearrangement keeps
 * total quality ≥ its current value. So coverage improves without ever costing quality,
 * and members are reached by the algorithm rather than by any manual exception.
 */

/** The minimum an edge must expose for the graph to rank and cap it. `mutualScore` is
 *  the sum of both directional scores (the edge weight); the directional scores are
 *  preserved so each member still sees the correct per-direction score and reason. */
export interface ReciprocalEdgeInput {
  userA: any
  userB: any
  scoreAtoB: number
  scoreBtoA: number
  mutualScore: number
}

export interface ReciprocalGraphConfig {
  /** Per-member introduction cap (both directions). Typically perRecipientIntroLimit(tier). */
  capOf: (member: any) => number
  /** Max fraction of one member's edges that may share a single role_type. */
  maxSameRolePercent: number
  /** role_type accessor (defaults to member.role_type). */
  roleOf?: (member: any) => string
  /** Whether a member is a business-solution provider (throttled per recipient). */
  isBusinessSolutionProvider?: (member: any) => boolean
  /** Business-solution cap for a member given their resolved intro cap. */
  bsCapOf?: (member: any, cap: number) => number
}

export interface ReciprocalGraphResult<E extends ReciprocalEdgeInput> {
  /** Selected edges — each is mutual by construction. Emit two rows per edge. */
  selected: E[]
  /** Final degree (== appears-in == receives) per member id. */
  degree: Map<string, number>
}

const defaultRoleOf = (m: any) => String(m?.role_type || 'unknown')

/** Deterministic, order-independent key for an undirected pair. */
export function reciprocalPairKey(aId: string, bId: string): string {
  return aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`
}

/**
 * Greedy maximum-weight b-matching over pre-filtered eligible edges.
 *
 * The caller is responsible for building `edges` as the set of ELIGIBLE undirected
 * pairs — i.e. every pairwise constraint that does not depend on the rest of the graph
 * (eligibility, same-company, prior-intro exclusions, the minimum relevance threshold)
 * has already removed disqualified pairs. This function then enforces the constraints
 * that DO depend on the chosen set (per-member degree, role mix, business-solution mix)
 * while maximizing total mutual quality.
 *
 * Determinism: edges are ranked by mutualScore descending with a stable pair-key
 * tiebreak, so identical input always yields identical output.
 */
export function selectReciprocalGraph<E extends ReciprocalEdgeInput>(
  edges: E[],
  config: ReciprocalGraphConfig,
): ReciprocalGraphResult<E> {
  const roleOf = config.roleOf || defaultRoleOf
  const isBS = config.isBusinessSolutionProvider || (() => false)

  // Per-member state, lazily initialized so callers needn't pass the member list.
  const cap = new Map<string, number>()
  const maxRole = new Map<string, number>()
  const bsCap = new Map<string, number>()
  const degree = new Map<string, number>()
  const roleCount = new Map<string, Map<string, number>>()
  const bsCount = new Map<string, number>()

  const ensure = (m: any) => {
    const id = m.id
    if (cap.has(id)) return
    const c = Math.max(0, config.capOf(m))
    cap.set(id, c)
    maxRole.set(id, Math.max(1, Math.ceil(c * config.maxSameRolePercent)))
    bsCap.set(id, config.bsCapOf ? config.bsCapOf(m, c) : c)
    degree.set(id, 0)
    roleCount.set(id, new Map())
    bsCount.set(id, 0)
  }

  // Rank edges by mutual quality (edge weight), highest first, deterministic tiebreak.
  const ranked = edges.slice().sort((x, y) =>
    y.mutualScore - x.mutualScore ||
    reciprocalPairKey(x.userA.id, x.userB.id).localeCompare(reciprocalPairKey(y.userA.id, y.userB.id)))

  const selected: E[] = []
  for (const e of ranked) {
    const a = e.userA
    const b = e.userB
    ensure(a)
    ensure(b)

    // Degree cap — enforces BOTH "receives ≤ cap" and "appears-in ≤ cap" at once.
    if (degree.get(a.id)! >= cap.get(a.id)! || degree.get(b.id)! >= cap.get(b.id)!) continue

    // Role-diversity cap: adding this edge gives A a partner of role(B) and vice versa.
    const roleB = roleOf(b)
    const roleA = roleOf(a)
    if ((roleCount.get(a.id)!.get(roleB) || 0) >= maxRole.get(a.id)!) continue
    if ((roleCount.get(b.id)!.get(roleA) || 0) >= maxRole.get(b.id)!) continue

    // Business-solution throttle — buyer↔provider ONLY. Two providers meeting is PEER
    // networking (not vendor exposure), so it is exempt and never counts against any
    // quota. The quota bounds how many providers a NON-provider buyer is shown. See
    // lib/matching/business-solutions.ts.
    const bIsBS = isBS(b)
    const aIsBS = isBS(a)
    const peer = aIsBS && bIsBS
    if (!peer) {
      if (bIsBS && bsCount.get(a.id)! >= bsCap.get(a.id)!) continue // provider b shown to buyer a
      if (aIsBS && bsCount.get(b.id)! >= bsCap.get(b.id)!) continue // provider a shown to buyer b
    }

    // Accept — update both endpoints symmetrically.
    selected.push(e)
    degree.set(a.id, degree.get(a.id)! + 1)
    degree.set(b.id, degree.get(b.id)! + 1)
    roleCount.get(a.id)!.set(roleB, (roleCount.get(a.id)!.get(roleB) || 0) + 1)
    roleCount.get(b.id)!.set(roleA, (roleCount.get(b.id)!.get(roleA) || 0) + 1)
    if (!peer) { // peer edges do not consume either member's provider quota
      if (bIsBS) bsCount.set(a.id, bsCount.get(a.id)! + 1)
      if (aIsBS) bsCount.set(b.id, bsCount.get(b.id)! + 1)
    }
  }

  // PHASE 2 — augmenting-path improvement.
  // Greedy b-matching is only LOCALLY optimal: it never revisits a saturated hub, so
  // it can strand a member whose single viable partner filled up early, even when a
  // feasible rearrangement would seat everyone. augmentForCoverage repairs exactly
  // those cases by rerouting one edge through a saturated vertex (an augmenting path),
  // and only when the swap keeps total quality ≥ its current value — so coverage never
  // costs quality. This is what lets the graph reach members greedy alone leaves out,
  // with no manual exception and every invariant intact.
  const improved = augmentForCoverage(selected, edges, config)
  const finalDegree = new Map<string, number>()
  for (const e of improved) {
    finalDegree.set(e.userA.id, (finalDegree.get(e.userA.id) || 0) + 1)
    finalDegree.set(e.userB.id, (finalDegree.get(e.userB.id) || 0) + 1)
  }
  return { selected: improved, degree: finalDegree }
}

/**
 * Augmenting-path improvement over a greedy b-matching (Phase 2 of selectReciprocalGraph,
 * also usable standalone). Repeatedly looks for a member `u` with spare capacity and
 * either
 *   (length-1) an eligible partner P who also has spare capacity, or
 *   (length-3) a saturated partner P whose matched partner Q can be re-seated with a
 *              still-free member R — i.e. remove {P,Q}, add {u,P} and {Q,R}.
 * A length-3 swap raises the matching size by one (u and R gain an edge; P and Q keep
 * theirs), so coverage never drops. It is applied only when the full result stays
 * feasible (every degree/role/business-solution cap) AND total quality does not
 * decrease — making every improvement Pareto-safe (more coverage, never less quality).
 *
 * Bounded to length-3 (one intermediary reroute), which is the dominant real case and
 * keeps the pass O(V·d³) and fully deterministic (members by id; neighbors by weight
 * then id; first admissible improvement wins). Longer augmenting paths are intentionally
 * out of scope; extend the search depth here if a future audit ever needs it.
 */
export function augmentForCoverage<E extends ReciprocalEdgeInput>(
  seed: E[],
  edges: E[],
  config: ReciprocalGraphConfig,
): E[] {
  const roleOf = config.roleOf || defaultRoleOf
  const isBS = config.isBusinessSolutionProvider || (() => false)

  const memberById = new Map<string, any>()
  const weightByKey = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    memberById.set(e.userA.id, e.userA)
    memberById.set(e.userB.id, e.userB)
    const k = reciprocalPairKey(e.userA.id, e.userB.id)
    weightByKey.set(k, e.mutualScore)
    if (!adj.has(e.userA.id)) adj.set(e.userA.id, [])
    if (!adj.has(e.userB.id)) adj.set(e.userB.id, [])
    adj.get(e.userA.id)!.push(e.userB.id)
    adj.get(e.userB.id)!.push(e.userA.id)
  }
  // Deterministic neighbor order: strongest edge first, id tiebreak.
  for (const [id, ns] of Array.from(adj.entries())) {
    ns.sort((x, y) =>
      (weightByKey.get(reciprocalPairKey(id, y))! - weightByKey.get(reciprocalPairKey(id, x))!) ||
      (x < y ? -1 : 1))
  }

  const capOf = (id: string) => Math.max(0, config.capOf(memberById.get(id)))
  const maxRoleOf = (id: string) => Math.max(1, Math.ceil(capOf(id) * config.maxSameRolePercent))
  const bsCapOf = (id: string) => (config.bsCapOf ? config.bsCapOf(memberById.get(id), capOf(id)) : capOf(id))

  let matched = new Set(seed.map((e) => reciprocalPairKey(e.userA.id, e.userB.id)))

  const degreeIn = (S: Set<string>) => {
    const d = new Map<string, number>()
    for (const k of Array.from(S)) {
      const [a, b] = k.split('|')
      d.set(a, (d.get(a) || 0) + 1)
      d.set(b, (d.get(b) || 0) + 1)
    }
    return d
  }
  // Full-matching feasibility: every degree / role / business-solution cap holds.
  const feasible = (S: Set<string>) => {
    const d = new Map<string, number>()
    const rc = new Map<string, Map<string, number>>()
    const bc = new Map<string, number>()
    for (const k of Array.from(S)) {
      const [a, b] = k.split('|')
      d.set(a, (d.get(a) || 0) + 1)
      d.set(b, (d.get(b) || 0) + 1)
      if (!rc.has(a)) rc.set(a, new Map())
      if (!rc.has(b)) rc.set(b, new Map())
      const rb = roleOf(memberById.get(b))
      const ra = roleOf(memberById.get(a))
      rc.get(a)!.set(rb, (rc.get(a)!.get(rb) || 0) + 1)
      rc.get(b)!.set(ra, (rc.get(b)!.get(ra) || 0) + 1)
      const aBS = isBS(memberById.get(a))
      const bBS = isBS(memberById.get(b))
      if (!(aBS && bBS)) { // provider↔provider peer edges are exempt from the quota
        if (bBS) bc.set(a, (bc.get(a) || 0) + 1)
        if (aBS) bc.set(b, (bc.get(b) || 0) + 1)
      }
    }
    for (const [id, dg] of Array.from(d.entries())) {
      if (dg > capOf(id)) return false
      const rcm = rc.get(id)
      if (rcm) for (const [, c] of Array.from(rcm.entries())) if (c > maxRoleOf(id)) return false
      if ((bc.get(id) || 0) > bsCapOf(id)) return false
    }
    return true
  }
  const weightSum = (S: Set<string>) => {
    let s = 0
    for (const k of Array.from(S)) s += weightByKey.get(k) || 0
    return s
  }
  const K = reciprocalPairKey
  // MOST-CONSTRAINED-FIRST: process members with the FEWEST eligible partners first, so
  // a member with a single viable match (like a sparse profile) gets first claim on a
  // scarce augmenting reroute before a well-connected member — who has alternatives —
  // spends that capacity. This is a general fairness rule (minimum-remaining-values),
  // not a per-member exception. Deterministic: eligible-edge count asc, then id.
  const members = Array.from(memberById.keys()).sort((x, y) =>
    ((adj.get(x)?.length || 0) - (adj.get(y)?.length || 0)) || (x < y ? -1 : 1))

  let improving = true
  while (improving) {
    improving = false
    const d = degreeIn(matched)
    for (const u of members) {
      if ((d.get(u) || 0) >= capOf(u)) continue // u must have spare capacity
      let applied = false

      // length-1: a free partner (won't normally exist after greedy — greedy is maximal
      // — but keeps the function correct as a standalone improver on any seed).
      for (const P of adj.get(u) || []) {
        if (matched.has(K(u, P))) continue
        if ((d.get(P) || 0) >= capOf(P)) continue
        const cand = new Set(matched)
        cand.add(K(u, P))
        if (feasible(cand)) { matched = cand; applied = true; break }
      }
      if (applied) { improving = true; break }

      // length-3: reroute one edge through a saturated partner P.
      for (const P of adj.get(u) || []) {
        if (matched.has(K(u, P))) continue
        for (const Q of adj.get(P) || []) {
          if (Q === u || !matched.has(K(P, Q))) continue
          for (const R of adj.get(Q) || []) {
            if (R === P || R === u || matched.has(K(Q, R))) continue
            if ((d.get(R) || 0) >= capOf(R)) continue
            const cand = new Set(matched)
            cand.delete(K(P, Q))
            cand.add(K(u, P))
            cand.add(K(Q, R))
            if (cand.size > matched.size && weightSum(cand) >= weightSum(matched) && feasible(cand)) {
              matched = cand
              applied = true
              break
            }
          }
          if (applied) break
        }
        if (applied) break
      }
      if (applied) { improving = true; break }
    }
  }

  return edges.filter((e) => matched.has(K(e.userA.id, e.userB.id)))
}
