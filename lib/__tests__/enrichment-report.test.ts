import { describe, it, expect } from 'vitest'
import { buildEnrichmentReport } from '@/lib/company/enrichment/report'
import { ENRICHMENT_VERSION } from '@/lib/company/enrichment/version'

const DAY = 24 * 60 * 60 * 1000
const now = 1_000_000_000_000
const old = new Date(now - 10 * DAY).toISOString()
const V = ENRICHMENT_VERSION

describe('buildEnrichmentReport', () => {
  // network of 7 companies; one network slug ("gamma") has no row (missing).
  const network = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta']
  const rows = {
    alpha: { enrichment_status: 'enriched', enrichment_version: V }, // up to date
    beta: { enrichment_status: 'enriched', enrichment_version: V - 1 }, // outdated
    delta: { enrichment_status: 'not_found', enrichment_attempted_at: old }, // not found (retryable)
    epsilon: { enrichment_status: 'failed', enrichment_attempted_at: old }, // failed
    zeta: { enrichment_status: 'partial', enrichment_attempted_at: old }, // partial
    eta: { enrichment_status: null }, // never enriched
    orphan: { enrichment_status: 'enriched', enrichment_version: V }, // not in network
  }
  const totalRows = Object.keys(rows).length // 7 rows (6 network-present + 1 orphan)

  it('buckets every network company exactly once and counts orphans', () => {
    const r = buildEnrichmentReport(network, rows, totalRows, { now })
    expect(r.version).toBe(V)
    expect(r.total).toBe(7)
    expect(r.upToDate).toBe(1) // alpha
    expect(r.outdatedVersion).toBe(1) // beta
    expect(r.notFound).toBe(1) // delta
    expect(r.failed).toBe(1) // epsilon
    expect(r.partial).toBe(1) // zeta
    expect(r.newlyCreatedNotEnriched).toBe(2) // gamma (missing) + eta (never)
    expect(r.pending).toBe(0)
    // buckets partition the network
    expect(r.upToDate + r.outdatedVersion + r.notFound + r.failed + r.partial + r.pending + r.newlyCreatedNotEnriched).toBe(r.total)
    expect(r.orphanRows).toBe(1) // orphan row not in network
  })

  it('needsWork counts exactly the rows an incremental run would process', () => {
    const r = buildEnrichmentReport(network, rows, totalRows, { now })
    // gamma(missing) + beta(outdated) + delta(not_found past retry) +
    // epsilon(failed past retry) + zeta(partial past retry) + eta(never) = 6
    expect(r.needsWork).toBe(6)
  })

  it('respects the retry cooldown (fresh not_found is not counted as needing work)', () => {
    const fresh = new Date(now - DAY).toISOString()
    const r = buildEnrichmentReport(['a'], { a: { enrichment_status: 'not_found', enrichment_attempted_at: fresh } }, 1, { now })
    expect(r.notFound).toBe(1)
    expect(r.needsWork).toBe(0)
  })

  it('versioning disabled: outdated stamps are treated as up to date', () => {
    const r = buildEnrichmentReport(['a'], { a: { enrichment_status: 'enriched', enrichment_version: null } }, 1, { now, versioningEnabled: false })
    expect(r.upToDate).toBe(1)
    expect(r.outdatedVersion).toBe(0)
    expect(r.needsWork).toBe(0)
  })
})
