import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Item 10/11: onboarding + weekly must route through the ONE reciprocal path (not the legacy
// one-sided enqueue); the scoring boundary must use the typed snake_case mapper; admin-created
// introductions + the admin reciprocal-graph batch remain unchanged.

const gen = readFileSync('lib/generate-recommendations.ts', 'utf8')
const weekly = readFileSync('app/api/cron/weekly-refresh/route.ts', 'utf8')

describe('automatic generators route through the reciprocal path', () => {
  it('onboarding calls generateReciprocalBatchForMember, NOT the one-sided generateBatchForMember', () => {
    const fn = gen.slice(gen.indexOf('export async function generateOnboardingRecommendations'), gen.indexOf('const RECIPROCAL_BATCH_SIZE'))
    expect(fn).toContain('generateReciprocalBatchForMember')
    expect(fn).not.toContain('generateBatchForMember')
  })
  it('the weekly cron uses generateReciprocalBatchForMember, not generateBatchForMember', () => {
    expect(weekly).toContain('generateReciprocalBatchForMember')
    expect(weekly).not.toContain('generateBatchForMember')
  })
  it('the reciprocal batch fn creates canonical pairs via createReciprocalSuggestion + fair selection', () => {
    // Reciprocal-generation logic (classify + attempt + generator) that the entry point drives.
    const fn = gen.slice(gen.indexOf('export function classifyGenerationOutcome'))
    expect(fn).toContain('selectFairCounterparts')
    expect(fn).toContain('createReciprocalSuggestion')
    expect(fn).toContain("'empty_pool'")           // honest empty state (no forced/one-sided match)
    expect(fn).toContain('candidatesEmpty')        // empty pool detected structurally
    expect(fn).toContain('getActiveInboundExposure') // live exposure feeds fair selection
  })
})

describe('scoring field-name bug fixed at the DB boundary', () => {
  it('uses the typed snake_case mapper, not the broken camelCase reads', () => {
    expect(gen).toContain('readScoringSignals(candidate)')
    expect(gen).not.toMatch(/candidate\.networkValueScore/)
    expect(gen).not.toMatch(/candidate\.responsivenessScore/)
  })
})

describe('admin introductions + admin reciprocal-graph batch remain unchanged', () => {
  it('the admin generate-batch route selects with the GLOBAL b-matching optimizer', () => {
    // Was selectReciprocalGraph (greedy + coverage fills + a repair pass limited to members at
    // exactly one card). That chain provably stranded members at ZERO, which the repair pass never
    // examined. Selection is now a lexicographic b-matching over the whole eligible graph.
    const admin = readFileSync('app/api/admin/generate-batch/route.ts', 'utf8')
    expect(admin).toContain('solveGlobalBMatching')
    expect(admin).not.toContain('selectReciprocalGraph')
    // The edge remains the unit of selection, so reciprocity stays structural.
    expect(admin).toMatch(/for \(const e of selectedEdgesRepaired\)/)
  })
  it('createAdminIntroPair (admin-created intros) is untouched by this change', () => {
    const src = readFileSync('lib/introRequests/createAdminIntroPair.ts', 'utf8')
    expect(src).toContain('admin_pending') // admin path keeps its own semantics
  })
})
