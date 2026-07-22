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

    // Business-solution throttle: cap how many BS providers each member is shown.
    const bIsBS = isBS(b)
    const aIsBS = isBS(a)
    if (bIsBS && bsCount.get(a.id)! >= bsCap.get(a.id)!) continue
    if (aIsBS && bsCount.get(b.id)! >= bsCap.get(b.id)!) continue

    // Accept — update both endpoints symmetrically.
    selected.push(e)
    degree.set(a.id, degree.get(a.id)! + 1)
    degree.set(b.id, degree.get(b.id)! + 1)
    roleCount.get(a.id)!.set(roleB, (roleCount.get(a.id)!.get(roleB) || 0) + 1)
    roleCount.get(b.id)!.set(roleA, (roleCount.get(b.id)!.get(roleA) || 0) + 1)
    if (bIsBS) bsCount.set(a.id, bsCount.get(a.id)! + 1)
    if (aIsBS) bsCount.set(b.id, bsCount.get(b.id)! + 1)
  }

  return { selected, degree }
}
