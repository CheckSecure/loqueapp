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
    const fn = gen.slice(gen.indexOf('export async function generateReciprocalBatchForMember'))
    expect(fn).toContain('selectFairCounterparts')
    expect(fn).toContain('createReciprocalSuggestion')
    expect(fn).toMatch(/return \{ count: 0, considered: 0 \}/) // honest empty state
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
  it('the admin generate-batch route still uses the reciprocal-graph engine', () => {
    const admin = readFileSync('app/api/admin/generate-batch/route.ts', 'utf8')
    expect(admin).toContain('selectReciprocalGraph')
  })
  it('createAdminIntroPair (admin-created intros) is untouched by this change', () => {
    const src = readFileSync('lib/introRequests/createAdminIntroPair.ts', 'utf8')
    expect(src).toContain('admin_pending') // admin path keeps its own semantics
  })
})
