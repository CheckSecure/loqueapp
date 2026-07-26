import { classifyIntroHistory, exhaustionThreshold } from '@/lib/introRequests/history'
import { isSameCompany } from '@/lib/matching/same-company'
import { parseExpertise } from '@/lib/parseExpertise'

// Lightweight, READ-ONLY monitoring for the tiered introduction-history model.
// Surfaces each member's fresh candidate-pool size and exclusion breakdown so we
// can watch for approaching exhaustion BEFORE enabling the safety valve.

export interface MemberPool {
  memberId: string
  name?: string | null
  pool: number // fresh candidates after HARD + SOFT + same-company (what generation sees)
  hard: number // permanent exclusions (active window + engagement + matched/blocked)
  soft: number // releasable exclusions (passed/expired/archived-shown)
  artifacts: number // archived+null-batch rows ignored (never history)
  valveActive: boolean // would the exhaustion valve engage for this member
}

export interface PoolHealthReport {
  networkSize: number
  valve: { enabled: boolean; threshold: number; activatedMembers: number }
  pool: { avg: number; min: number; max: number }
  exclusions: { avgHard: number; avgSoft: number; avgArtifactsIgnored: number }
  membersBelowThreshold: { 20: number; 15: number; 10: number; 5: number }
  smallestPools: Array<{ name?: string | null; pool: number; hard: number; soft: number }>
}

/** Pure aggregation of per-member pool stats into the monitoring report. */
export function summarizePoolHealth(members: MemberPool[], threshold: number): PoolHealthReport {
  const n = members.length
  const avg = (xs: number[]) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : 0)
  const pools = members.map((m) => m.pool)
  const below = (t: number) => members.filter((m) => m.pool < t).length
  return {
    networkSize: n,
    valve: { enabled: threshold > 0, threshold, activatedMembers: members.filter((m) => m.valveActive).length },
    pool: { avg: avg(pools), min: n ? Math.min(...pools) : 0, max: n ? Math.max(...pools) : 0 },
    exclusions: {
      avgHard: avg(members.map((m) => m.hard)),
      avgSoft: avg(members.map((m) => m.soft)),
      avgArtifactsIgnored: avg(members.map((m) => m.artifacts)),
    },
    membersBelowThreshold: { 20: below(20), 15: below(15), 10: below(10), 5: below(5) },
    smallestPools: [...members]
      .sort((a, b) => a.pool - b.pool)
      .slice(0, 10)
      .map((m) => ({ name: m.name, pool: m.pool, hard: m.hard, soft: m.soft })),
  }
}

async function pageAll(admin: any, table: string, cols: string): Promise<any[]> {
  const out: any[] = []
  let from = 0
  const size = 1000
  for (;;) {
    const { data, error } = await admin.from(table).select(cols).range(from, from + size - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data ?? []))
    if (!data || data.length < size) break
    from += size
  }
  return out
}

/**
 * DB-backed pool-health loader. Read-only. Mirrors rankCandidatesForUser's
 * exclusions (tiered intro history + matches + blocked + same-company) to gauge
 * each member's fresh candidate pool. Referral exclusions (small, per-member) are
 * omitted for cost — this is a gauge, so the true pool is at most a hair smaller.
 */
export async function loadPoolHealth(admin: any): Promise<PoolHealthReport> {
  const profiles = await pageAll(admin, 'profiles', 'id, full_name, role_type, expertise, company, account_status, profile_complete, is_test_account')
  const daniel = profiles.find((p: any) => (p.full_name || '').trim().toLowerCase() === 'daniel abramoff')
  const eligible = profiles.filter(
    (p: any) => p.account_status === 'active' && p.profile_complete && !p.is_test_account && p.full_name && p.role_type && parseExpertise(p.expertise).length > 0 && p.id !== daniel?.id,
  )
  const eligibleIds = new Set(eligible.map((p: any) => p.id))

  const ir = await pageAll(admin, 'intro_requests', 'requester_id, target_user_id, status, batch_id')
  const irByUser = new Map<string, any[]>()
  for (const r of ir) for (const uid of [r.requester_id, r.target_user_id]) {
    if (!irByUser.has(uid)) irByUser.set(uid, [])
    irByUser.get(uid)!.push(r)
  }
  const matchedByUser = new Map<string, Set<string>>()
  for (const m of await pageAll(admin, 'matches', 'user_a_id, user_b_id')) {
    for (const [a, b] of [[m.user_a_id, m.user_b_id], [m.user_b_id, m.user_a_id]]) {
      if (!matchedByUser.has(a)) matchedByUser.set(a, new Set())
      matchedByUser.get(a)!.add(b)
    }
  }
  const blockedByUser = new Map<string, Set<string>>()
  for (const b of (await admin.from('blocked_users').select('user_id, blocked_user_id')).data ?? []) {
    for (const [a, o] of [[b.user_id, b.blocked_user_id], [b.blocked_user_id, b.user_id]]) {
      if (!blockedByUser.has(a)) blockedByUser.set(a, new Set())
      blockedByUser.get(a)!.add(o)
    }
  }

  const threshold = exhaustionThreshold()
  const members: MemberPool[] = eligible.map((m: any) => {
    const rows = (irByUser.get(m.id) ?? []).filter((r: any) => eligibleIds.has(r.requester_id === m.id ? r.target_user_id : r.requester_id))
    const { hardExcluded, softExcluded } = classifyIntroHistory(m.id, rows)
    for (const id of Array.from(matchedByUser.get(m.id) ?? [])) if (eligibleIds.has(id)) hardExcluded.add(id)
    for (const id of Array.from(blockedByUser.get(m.id) ?? [])) if (eligibleIds.has(id)) hardExcluded.add(id)
    for (const id of Array.from(softExcluded)) if (hardExcluded.has(id)) softExcluded.delete(id)

    let artifacts = 0
    for (const r of rows) {
      const o = r.requester_id === m.id ? r.target_user_id : r.requester_id
      if (r.status === 'archived' && !r.batch_id && !hardExcluded.has(o) && !softExcluded.has(o)) artifacts++
    }

    let poolAfterSoft = 0
    for (const o of eligible) {
      if (o.id === m.id) continue
      if (isSameCompany(m, o)) continue
      if (hardExcluded.has(o.id) || softExcluded.has(o.id)) continue
      poolAfterSoft++
    }
    return {
      memberId: m.id,
      name: m.full_name,
      pool: poolAfterSoft,
      hard: Array.from(hardExcluded).filter((x) => eligibleIds.has(x)).length,
      soft: Array.from(softExcluded).filter((x) => eligibleIds.has(x)).length,
      artifacts,
      valveActive: threshold > 0 && poolAfterSoft < threshold,
    }
  })

  return summarizePoolHealth(members, threshold)
}
