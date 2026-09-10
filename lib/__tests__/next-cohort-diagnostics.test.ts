import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * PER-COMMUNITY BATCH DIAGNOSTICS — STEP 3.5.
 *
 * ─── THE FAILURE THIS PREVENTS ────────────────────────────────────────────────────────────────
 * pairsCutByScoreFloor and scoreHistogram were summed across cohorts before they reached the
 * response, while pairComposition and underfillReasons were kept per-cohort. Under that asymmetry a
 * Next cohort whose every pair fell below its floor is INVISIBLE inside a Professional-dominated
 * aggregate — fifty real students, zero suggestions, and nothing in the run report that says so.
 *
 * The distinction that has to survive is:
 *
 *     "there aren't enough members yet"     — a small cohort, expected at launch
 *     "members exist, no pair qualified"    — a product signal, and a different fix
 *
 * These are structural assertions over the route. The route handler cannot be invoked from a test
 * without standing up the whole admin/Supabase surface, so what is pinned here is that the numbers
 * are computed per cohort, reported per cohort, and that the starvation state is loud.
 */

const ROUTE = readFileSync('app/api/admin/generate-batch/route.ts', 'utf8')

describe('1. every number that can hide a starving cohort is computed per cohort', () => {
  it('the cohort function builds its own diagnostics block', () => {
    expect(ROUTE).toMatch(/const cohortDiagnostics = \{\s*\n\s*community: scoringCtx\.semantics,/)
  })

  it.each([
    ['community', /community: scoringCtx\.semantics/],
    ['member count', /members: cohort\.length/],
    ['the floor it was measured against', /relevanceFloor: cohortFloor/],
    ['pairs after hard gates', /pairsPassingHardGates,/],
    ['pairs cut by the floor', /pairsCutByScoreFloor,/],
    ['the score histogram', /scoreHistogram,/],
    ['members with zero edges', /membersWithZeroEdges,/],
    ['suggestions produced', /suggestionsProduced: allSuggestions\.length/],
  ])('reports %s', (_label, pattern) => {
    const block = ROUTE.slice(ROUTE.indexOf('const cohortDiagnostics = {'), ROUTE.indexOf('if (cohortDiagnostics.starved)'))
    expect(block).toMatch(pattern)
  })

  it('membersWithZeroEdges is derived from the SELECTED edges, not from the pair pool', () => {
    // A member can appear in many qualifying pairs and still receive nothing if the solver seated
    // them nowhere. Counting from allPairs would report that member as healthy.
    expect(ROUTE).toMatch(/for \(const e of selectedEdgesRepaired\) \{ withEdges\.add\(e\.userA\.id\); withEdges\.add\(e\.userB\.id\) \}/)
    expect(ROUTE).toMatch(/const membersWithZeroEdges = cohort\.filter\(\(p: any\) => !withEdges\.has\(p\.id\)\)\.length/)
  })

  it('each cohort is reported individually, in MEMBER_TYPES order', () => {
    expect(ROUTE).toMatch(/const cohortDiagnostics = cohortResults\.map\(\(r\) => r\.cohortDiagnostics\)/)
    expect(ROUTE).toMatch(/const cohortResults = MEMBER_TYPES/)
  })

  it('the per-cohort block reaches the response', () => {
    const body = ROUTE.slice(ROUTE.indexOf('qualityMetrics: {') - 900)
    expect(body).toMatch(/\n      cohortDiagnostics,/)
    expect(body).toMatch(/\n      starvedCohorts,/)
  })
})

describe('2. starvation is a distinct, loud state', () => {
  it('starved means members existed and nothing was produced — not "too few members"', () => {
    expect(ROUTE).toMatch(/starved: cohort\.length >= 2 && allSuggestions\.length === 0/)
  })

  it('a starved cohort is logged at ERROR, not swallowed into an info line', () => {
    expect(ROUTE).toMatch(/console\.error\('\[generate-batch\] COHORT STARVED — members exist, no pair qualified:'/)
  })

  it('the log names no member — aggregate only', () => {
    const block = ROUTE.slice(ROUTE.indexOf('COHORT STARVED'), ROUTE.indexOf('COHORT STARVED') + 400)
    expect(block).not.toMatch(/full_name|email|\.id\b|company/)
  })

  it('the response lists which communities starved', () => {
    expect(ROUTE).toMatch(/const starvedCohorts = cohortDiagnostics\.filter\(\(d\) => d\.starved\)\.map\(\(d\) => d\.community\)/)
  })

  it('a cohort of fewer than two members never reaches the starved state', () => {
    // Those cohorts are filtered out before computeCohortSuggestions runs, so "not enough members"
    // and "starved" can never both describe the same run.
    expect(ROUTE).toMatch(/\.filter\(\(cohort\) => cohort\.length >= 2\)/)
  })

  it('NO fallback manufactures matches below the floor', () => {
    // The floor is a hard drop, and nothing added here re-admits a cut pair.
    expect(ROUTE).toMatch(/if \(avgScore < cohortFloor\) \{ pairsCutByScoreFloor\+\+; continue \}/)
    expect(ROUTE).not.toMatch(/if \(allPairs\.length === 0\)[\s\S]{0,200}floor/i)
    expect(ROUTE).not.toMatch(/relaxFloor|lowerFloor|fallbackFloor|minRelevanceFallback/)
  })
})

describe('3. the existing aggregate diagnostics are preserved', () => {
  it.each(['pairsPassingHardGates', 'pairsCutByScoreFloor', 'scoreHistogram', 'pairComposition', 'underfillReasons'])(
    '%s is still aggregated for callers that already read it', (name) => {
      expect(ROUTE).toMatch(new RegExp(`const ${name} = cohortResults\\.`))
    })

  it('the top-level relevanceThreshold keeps its original meaning and key', () => {
    // Existing readers see the Professional floor exactly as before; the per-community floors are
    // reported separately rather than by changing what this number means.
    expect(ROUTE).toMatch(/relevanceThreshold: MIN_RELEVANCE_SCORE,/)
    expect(ROUTE).toMatch(/relevanceThresholdByCommunity: Object\.fromEntries\(/)
  })

  it('the partition summary still reports skipped unknown-community members', () => {
    expect(ROUTE).toMatch(/membersSkippedUnknownCommunity,/)
  })
})
