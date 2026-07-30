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
  /**
   * Edge-level exemption from the business-solution throttle, IN ADDITION to the
   * built-in provider↔provider peer rule. Returns true when the pair should be
   * treated as peers (e.g. legal↔legal professional networking). Optional and
   * default-off: when unset, throttle behavior is exactly the provider↔provider rule.
   */
  isThrottleExemptPair?: (a: any, b: any) => boolean
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
    // Peer edges are exempt from the throttle: both providers, OR an explicit
    // edge-level exemption (e.g. legal↔legal professional networking).
    const peer = (aIsBS && bIsBS) || !!config.isThrottleExemptPair?.(a, b)
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
 * COVERAGE FILL — role diversity is a PREFERENCE, not a hard limit.
 *
 * selectReciprocalGraph optimizes quality while respecting the role-diversity cap as a
 * HARD constraint, which can leave a member below their intro cap when their only
 * remaining eligible partners share a role_type they've already used. This pass runs
 * AFTER selection and tops up any under-cap member with their best remaining eligible
 * edge, relaxing ONLY the role-diversity preference. Everything else is preserved:
 *   • the per-member degree cap is never exceeded (the 2-intro maximum holds);
 *   • the business-solution throttle is still enforced;
 *   • `edges` is the caller's already-filtered eligible set (history, availability
 *     tiers, same-company, and the relevance floor were applied upstream), so no
 *     excluded pair can enter here;
 *   • edges are considered by mutualScore (which already carries any role demotion),
 *     so cross-role fills are preferred and demoted pairs are the genuine last resort.
 * Reciprocity is intact — each returned edge is undirected and fans out to both members.
 * Deterministic (mutualScore desc, pair-key tiebreak). Adds only consume capacity, so a
 * single pass is sufficient.
 */
export function fillForCoverage<E extends ReciprocalEdgeInput>(
  selected: E[],
  edges: E[],
  config: {
    capOf: (m: any) => number
    isBusinessSolutionProvider?: (m: any) => boolean
    bsCapOf?: (m: any, cap: number) => number
    isThrottleExemptPair?: (a: any, b: any) => boolean
  },
): E[] {
  const isBS = config.isBusinessSolutionProvider || (() => false)
  const isExempt = (a: any, b: any) => !!config.isThrottleExemptPair?.(a, b)
  const result = selected.slice()
  const chosen = new Set(result.map((e) => reciprocalPairKey(e.userA.id, e.userB.id)))
  const degree = new Map<string, number>()
  const bsCount = new Map<string, number>()
  const bump = (m: Map<string, number>, id: string) => m.set(id, (m.get(id) || 0) + 1)
  for (const e of result) {
    bump(degree, e.userA.id); bump(degree, e.userB.id)
    const aBS = isBS(e.userA), bBS = isBS(e.userB)
    if (!((aBS && bBS) || isExempt(e.userA, e.userB))) { if (bBS) bump(bsCount, e.userA.id); if (aBS) bump(bsCount, e.userB.id) }
  }
  const capOf = (m: any) => Math.max(0, config.capOf(m))
  const bsCapOf = (m: any) => (config.bsCapOf ? config.bsCapOf(m, capOf(m)) : capOf(m))

  const remaining = edges
    .filter((e) => !chosen.has(reciprocalPairKey(e.userA.id, e.userB.id)))
    .sort((x, y) => y.mutualScore - x.mutualScore ||
      reciprocalPairKey(x.userA.id, x.userB.id).localeCompare(reciprocalPairKey(y.userA.id, y.userB.id)))

  for (const e of remaining) {
    const a = e.userA, b = e.userB
    const da = degree.get(a.id) || 0, db = degree.get(b.id) || 0
    if (da >= capOf(a) || db >= capOf(b)) continue // never exceed the hard per-member cap
    const aBS = isBS(a), bBS = isBS(b), peer = (aBS && bBS) || isExempt(a, b)
    if (!peer) { // keep the business-solution throttle; only role diversity is relaxed
      if (bBS && (bsCount.get(a.id) || 0) >= bsCapOf(a)) continue
      if (aBS && (bsCount.get(b.id) || 0) >= bsCapOf(b)) continue
    }
    result.push(e); chosen.add(reciprocalPairKey(a.id, b.id))
    bump(degree, a.id); bump(degree, b.id)
    if (!peer) { if (bBS) bump(bsCount, a.id); if (aBS) bump(bsCount, b.id) }
  }
  return result
}

/**
 * CONSTRAINED coverage repair for members left at EXACTLY 1 intro after selection +
 * fill. A focused post-processing pass (never re-runs selection): for each 1-intro
 * member it tries a length-1 add or a length-3 displacement/re-seat swap
 * (remove {P,Q}, add {u,P} and {Q,R}), which lifts `u` (and `R`) without dropping
 * anyone — `P` and `Q` each lose one edge and gain one, so a member at 2 stays at 2.
 *
 * Unlike augmentForCoverage this is NOT Pareto-quality-locked: it accepts a bounded,
 * local quality change to seat a stranded member (best move = max quality delta). It
 * is otherwise strictly guarded:
 *   • never CREATES a Law Firm Partner ↔ Law Firm Partner edge (config.isPartnerPair) —
 *     so the two-pass partner fallback is never regressed (partner count can only fall);
 *   • never exceeds a member's cap (2-intro maximum);
 *   • never drops a member's degree (displaced members are re-seated);
 *   • only draws edges from `edges` (the caller's eligible set — history / availability
 *     tiers / same-company / relevance already applied) and re-checks the
 *     business-solution throttle on every add, so no excluded/throttled edge slips in.
 * Deterministic: 1-intro members processed most-constrained-first (fewest reachable
 * candidates, id tiebreak); best move by quality delta then pair-key.
 */
export function repairOneIntroCoverage<E extends ReciprocalEdgeInput>(
  selected: E[],
  edges: E[],
  config: {
    capOf: (m: any) => number
    isBusinessSolutionProvider?: (m: any) => boolean
    bsCapOf?: (m: any, cap: number) => number
    isThrottleExemptPair?: (a: any, b: any) => boolean
    isPartnerPair?: (a: any, b: any) => boolean
    target?: number
  },
): E[] {
  const isBS = config.isBusinessSolutionProvider || (() => false)
  const isExempt = (a: any, b: any) => !!config.isThrottleExemptPair?.(a, b)
  const isPartner = (a: any, b: any) => !!config.isPartnerPair?.(a, b)
  const capOf = (m: any) => Math.max(0, config.capOf(m))
  const bsCapOf = (m: any) => (config.bsCapOf ? config.bsCapOf(m, capOf(m)) : capOf(m))
  const K = reciprocalPairKey
  const target = config.target ?? 2

  const result = selected.slice()
  const memberById = new Map<string, any>()
  const adj = new Map<string, string[]>()
  const edgeByKey = new Map<string, E>()
  for (const e of edges) {
    memberById.set(e.userA.id, e.userA); memberById.set(e.userB.id, e.userB)
    edgeByKey.set(K(e.userA.id, e.userB.id), e)
    ;(adj.get(e.userA.id) ?? adj.set(e.userA.id, []).get(e.userA.id)!).push(e.userB.id)
    ;(adj.get(e.userB.id) ?? adj.set(e.userB.id, []).get(e.userB.id)!).push(e.userA.id)
  }
  const M = (id: string) => memberById.get(id)
  const w = (x: string, y: string) => edgeByKey.get(K(x, y))?.mutualScore ?? 0
  const peer = (x: string, y: string) => (isBS(M(x)) && isBS(M(y))) || isExempt(M(x), M(y))

  const matched = new Set(result.map((e) => K(e.userA.id, e.userB.id)))
  const degree = new Map<string, number>()
  const bsCount = new Map<string, number>()
  const bump = (m: Map<string, number>, id: string, d = 1) => m.set(id, (m.get(id) || 0) + d)
  // bsCount[x] = providers x (as a buyer) has been shown; peer/exempt edges don't count.
  const bsAdjust = (x: string, y: string, sign: number) => {
    if (peer(x, y)) return
    if (isBS(M(y))) bump(bsCount, x, sign)
    if (isBS(M(x))) bump(bsCount, y, sign)
  }
  for (const e of result) { bump(degree, e.userA.id); bump(degree, e.userB.id); bsAdjust(e.userA.id, e.userB.id, +1) }

  // Would adding {x,y} respect the throttle at the CURRENT bsCount? (x,y disjoint from
  // any concurrently-removed edge — callers pre-apply removals via bsAdjust.)
  const canAdd = (x: string, y: string) => {
    if (peer(x, y)) return true
    if (isBS(M(y)) && (bsCount.get(x) || 0) >= bsCapOf(M(x))) return false
    if (isBS(M(x)) && (bsCount.get(y) || 0) >= bsCapOf(M(y))) return false
    return true
  }
  const applyAdd = (x: string, y: string) => {
    const e = edgeByKey.get(K(x, y))!; result.push(e); matched.add(K(x, y))
    bump(degree, x); bump(degree, y); bsAdjust(x, y, +1)
  }
  const applyRemove = (x: string, y: string) => {
    matched.delete(K(x, y))
    const i = result.findIndex((e) => K(e.userA.id, e.userB.id) === K(x, y))
    if (i >= 0) result.splice(i, 1)
    bump(degree, x, -1); bump(degree, y, -1); bsAdjust(x, y, -1)
  }

  const ones = Array.from(memberById.keys())
    .filter((id) => (degree.get(id) || 0) === 1)
    .sort((a, b) => (adj.get(a)?.length || 0) - (adj.get(b)?.length || 0) || (a < b ? -1 : 1))

  for (const u of ones) {
    if ((degree.get(u) || 0) >= Math.min(target, capOf(M(u)))) continue
    let best: { P: string; Q?: string; R?: string; delta: number; tie: string } | null = null
    const consider = (cand: { P: string; Q?: string; R?: string; delta: number }) => {
      const tie = cand.Q ? `${K(u, cand.P)}#${K(cand.Q, cand.R!)}` : K(u, cand.P)
      if (!best || cand.delta > best.delta || (cand.delta === best.delta && tie < best.tie)) best = { ...cand, tie }
    }
    for (const P of adj.get(u) || []) {
      if (matched.has(K(u, P)) || isPartner(M(u), M(P))) continue
      if ((degree.get(P) || 0) < capOf(M(P))) { // length-1
        if (canAdd(u, P)) consider({ P, delta: w(u, P) })
        continue
      }
      // length-3: displace a match Q of the saturated P; re-seat Q with a free R.
      const partnersOfP = result.filter((e) => e.userA.id === P || e.userB.id === P)
        .map((e) => (e.userA.id === P ? e.userB.id : e.userA.id))
      for (const Q of partnersOfP) {
        if (Q === u) continue
        for (const R of adj.get(Q) || []) {
          if (R === P || R === u || matched.has(K(Q, R))) continue
          if (isPartner(M(Q), M(R))) continue
          if ((degree.get(R) || 0) >= capOf(M(R))) continue
          // Throttle feasibility with {P,Q} removed (u/P and Q/R are disjoint members).
          bsAdjust(P, Q, -1)
          const ok = canAdd(u, P) && canAdd(Q, R)
          bsAdjust(P, Q, +1)
          if (!ok) continue
          consider({ P, Q, R, delta: w(u, P) + w(Q, R) - w(P, Q) })
        }
      }
    }
    if (!best) continue
    const b = best as { P: string; Q?: string; R?: string }
    if (!b.Q) applyAdd(u, b.P)
    else { applyRemove(b.P, b.Q); applyAdd(u, b.P); applyAdd(b.Q, b.R!) }
  }
  return result
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
      const peer = (aBS && bBS) || !!config.isThrottleExemptPair?.(memberById.get(a), memberById.get(b))
      if (!peer) { // peer edges (both providers, or an exempt pair) don't consume the quota
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
