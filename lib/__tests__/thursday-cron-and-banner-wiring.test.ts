import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const VERCEL = JSON.parse(readFileSync('vercel.json', 'utf8'))
const ROUTE = readFileSync('app/api/cron/weekly-refresh/route.ts', 'utf8')
const BANNER = readFileSync('components/ThursdayCountdownBanner.tsx', 'utf8')
const PAGE = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
const SCHED = readFileSync('lib/introductions/thursdaySchedule.ts', 'utf8')
const RESOLVER = readFileSync('lib/introductions/thursdayBanner.ts', 'utf8')

describe('vercel.json — Hobby-compatible SINGLE weekly Thursday invocation', () => {
  const weekly = VERCEL.crons.find((c: any) => c.path === '/api/cron/weekly-refresh')
  it('is exactly one Thursday invocation at 14:00 UTC', () => {
    expect(weekly.schedule).toBe('0 14 * * 4')
  })
  it('is NOT the rejected multi-window expression and NOT the old Monday schedule', () => {
    expect(weekly.schedule).not.toBe('0 13,14 * * 4') // Hobby disallows >1 run/day
    expect(weekly.schedule).not.toBe('0 9 * * 1')
  })
  it('appears only once (no duplicate cron entry for the path)', () => {
    expect(VERCEL.crons.filter((c: any) => c.path === '/api/cron/weekly-refresh').length).toBe(1)
  })
})

describe('weekly-refresh route — no NY-hour guard, no exactly-once claim, behavior preserved', () => {
  it('does NOT import or call the removed NY-hour guard', () => {
    expect(ROUTE).not.toMatch(/mayCronExecute/)
  })
  it('has no skip/guard early-return, and runKey never gates execution', () => {
    expect(ROUTE).not.toMatch(/outside_ny_thursday|skipped: true/)
    expect(ROUTE).not.toMatch(/if\s*\([^)]*runKey/) // runKey is not used as an execution gate
  })
  it('treats weeklyRunKey as a log label only — no durable run table / lease write', () => {
    expect(ROUTE).toMatch(/weeklyRunKey/)
    expect(ROUTE).not.toMatch(/weekly_run|cron_run|run_lock|acquireLease/i)
    expect(ROUTE).not.toMatch(/\.(insert|upsert)\([^)]*run/i)
  })
  it('preserves CRON_SECRET authorization', () => {
    expect(ROUTE).toMatch(/authHeader !== `Bearer \$\{process\.env\.CRON_SECRET\}`/)
  })
  it('preserves the generation gate, coverage, rotation, reciprocal path, reminder key, privacy logging', () => {
    expect(ROUTE).toMatch(/WEEKLY_REFRESH_GENERATION/)
    expect(ROUTE).toMatch(/coverageEnabled\(\)/)
    expect(ROUTE).toMatch(/expireStaleReciprocalPairs/)
    expect(ROUTE).toMatch(/generateReciprocalBatchForMember/)
    expect(ROUTE).toMatch(/isoWeekKey\(new Date\(\)\)/) // reminder dedupe unchanged (shared w/ approve-batch)
    expect(ROUTE).toMatch(/member error \(class\)/)
  })
})

describe('no migration added for the banner (UI-only feature)', () => {
  it('the schedule + resolver helpers are pure (no supabase / DB imports)', () => {
    for (const src of [SCHED, RESOLVER]) {
      expect(src).not.toMatch(/supabase|createClient|createAdminClient|@\/lib\/supabase/)
    }
  })
  it('no durable weekly-run table is introduced by this feature', () => {
    expect(SCHED + RESOLVER + ROUTE).not.toMatch(/CREATE TABLE|weekly_run|cron_run/i)
  })
})

describe('ThursdayCountdownBanner — client-side countdown, NEVER polls the database', () => {
  it('is a client component', () => {
    expect(BANNER.trimStart().startsWith("'use client'")).toBe(true)
  })
  it('does not import or call any data layer', () => {
    expect(BANNER).not.toMatch(/supabase/i)
    expect(BANNER).not.toMatch(/\bfetch\s*\(/)
    expect(BANNER).not.toMatch(/createClient|createAdminClient|from\(['"]/)
  })
  it('computes purely from the absolute targetIso prop', () => {
    expect(BANNER).toMatch(/countdownState|formatCountdown/)
    expect(BANNER).toMatch(/new Date\(targetIso\)/)
  })
  it('pauses on tab-hidden and resumes on visibility', () => {
    expect(BANNER).toMatch(/visibilitychange/)
    expect(BANNER).toMatch(/visibilityState/)
    expect(BANNER).toMatch(/clearInterval/)
  })
  it('renders the server-provided initial text first (hydration-safe)', () => {
    expect(BANNER).toMatch(/useState\(initialCountdownText\)/)
  })
  it('is accessible (status role + screen-reader text, not color alone)', () => {
    expect(BANNER).toMatch(/role="status"/)
    expect(BANNER).toMatch(/sr-only/)
    expect(BANNER).toMatch(/Icon/)
  })
})

describe('introductions page — server-gated banner, admin schedule-only, privacy-preserving props', () => {
  it('reads all visibility columns server-side, including is_admin', () => {
    for (const col of ['account_status', 'profile_complete', 'is_test_account', 'matching_paused', 'is_admin']) {
      expect(PAGE).toMatch(new RegExp(col))
    }
    expect(PAGE).toMatch(/isAdmin:\s*\(profileRow as any\)\?\.is_admin/)
  })
  it('gates visibility on canViewThursdayBanner (NOT isEligibleForMatching) and renders only a resolved banner', () => {
    expect(PAGE).toMatch(/canViewThursdayBanner\(bannerFacts\)/)
    expect(PAGE).not.toMatch(/isEligibleForMatching\(/) // matching-eligibility helper is not reused for visibility
    expect(PAGE).toMatch(/thursdayBanner &&/)
  })
  it('admins get a schedule-only view — no suggestion query, forced neutral (scheduleOnly: true)', () => {
    expect(PAGE).toMatch(/isAdminViewer/)
    expect(PAGE).toMatch(/scheduleOnly: true/)
    // the admin branch must NOT run the intro_requests evidence query
    const adminBranch = (PAGE.match(/if \(isAdminViewer\) \{[\s\S]*?\} else \{/) || [''])[0]
    expect(adminBranch).toBeTruthy()
    expect(adminBranch).not.toMatch(/from\('intro_requests'\)/)
  })
  it('ordinary members: reads evidence via service_role, query error → null (neutral, never false negative)', () => {
    expect(PAGE).toMatch(/receivedThisCycle = evErr \? null :/)
    expect(PAGE).toMatch(/createAdminClient\(\)\s*\n\s*\.from\('intro_requests'\)/)
  })
  it('passes ONLY non-identifying view fields to the client', () => {
    const propBlock = (PAGE.match(/<ThursdayCountdownBanner[\s\S]*?\/>/) || [''])[0]
    expect(propBlock).toBeTruthy()
    expect(propBlock).toMatch(/kind=\{thursdayBanner\.kind\}/)
    expect(propBlock).not.toMatch(/score|reason|pair|created_at|target_user|requester/i)
  })
})

describe('introductions page — empty-state copy makes no notification promise', () => {
  it('the "notify you when a strong match is ready" promise is gone', () => {
    expect(PAGE).not.toMatch(/notify you when a strong match/i)
    expect(PAGE).not.toMatch(/notify you/i)
  })
  it('uses the neutral Thursday check-back copy instead', () => {
    expect(PAGE).toMatch(/Check back Thursday for the next curated introduction batch\./)
  })
})
