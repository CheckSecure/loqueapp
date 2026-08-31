import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const ROUTE = readFileSync('app/api/admin/referral-campaign/notify/route.ts', 'utf8')
const NOTIF = readFileSync('lib/notifications/index.ts', 'utf8')
const ELIG = readFileSync('lib/referralCampaign/eligibility.ts', 'utf8')

describe('referral_campaign notification type', () => {
  it('is a real type with copy and a link', () => {
    expect(NOTIF).toContain("| 'referral_campaign'")
    expect(NOTIF).toContain("referral_campaign: '/dashboard/referrals'")
  })

  it('carries the approved copy verbatim', () => {
    expect(NOTIF).toContain("title: 'Who else belongs here?'")
    expect(NOTIF).toContain("Recommend 3-5 people who'd fit — in-house counsel, law firm attorneys, government affairs, or executives.")
    expect(NOTIF).toContain('you earn 1 credit for every nominee who joins, up to 5 a month.')
  })

  it('states the cap, because the promise is false without it', () => {
    // /api/profile/complete caps awards at 5 per referrer per calendar month. "1 credit for each
    // person who joins" is literally untrue for anyone whose sixth nominee joins that month.
    expect(NOTIF).toContain('up to 5 a month')
  })

  it('does not imply an instant reward', () => {
    // A nomination only earns a credit once the nominee is INVITED, and referrals.status='invited'
    // is written exclusively by admin invite paths — the reward waits on the review queue.
    expect(NOTIF).toContain('Each one is personally reviewed')
  })
})

describe('broadcast route', () => {
  it('dry run is the default — only the literal string executes', () => {
    expect(ROUTE).toContain("const execute = body.action === 'execute'")
    const guard = ROUTE.indexOf('if (!execute) {')
    const write = ROUTE.indexOf('await createNotificationSafe(')
    expect(guard).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(guard) // the early return precedes any write
  })

  it('every notification carries the campaign dedupeKey', () => {
    expect(ROUTE).toContain("data: { dedupeKey: CAMPAIGN_KEY }")
    expect(ROUTE).toMatch(/const CAMPAIGN_KEY = '[a-z0-9_]+'/)
  })

  it('refuses to execute without the dedupe migration', () => {
    // Without the unique index the dedupeKey guarantees nothing and a re-run notifies everyone
    // again — refusing is the only safe behaviour.
    expect(ROUTE).toContain('if (!migrations.ok)')
    expect(ROUTE).toContain('status: 409')
  })

  it('caps a single run', () => {
    expect(ROUTE).toMatch(/const MAX_PER_RUN = \d+/)
    expect(ROUTE).toContain('Math.min(\n    MAX_PER_RUN,')
  })

  it('shows the exact copy in the dry run', () => {
    expect(ROUTE).toContain('preview: {')
    expect(ROUTE).toContain("title: 'Who else belongs here?'")
  })

  it('ignores the EMAIL channel sent-stamp but honours the opt-out', () => {
    expect(ROUTE).toContain('respectEmailSentStamp: false')
    expect(ROUTE).toContain('respectEmailOptOut: true')
  })
})

describe('eligibility options do not change the email campaign', () => {
  it('both flags default to the previous behaviour', () => {
    expect(ELIG).toContain('const respectEmailSentStamp = opts.respectEmailSentStamp !== false')
    expect(ELIG).toContain('const respectEmailOptOut = opts.respectEmailOptOut !== false')
  })

  it('the email send route still calls it with no options', () => {
    const send = readFileSync('app/api/admin/referral-campaign/send/route.ts', 'utf8')
    expect(send).toContain('computeReferralCampaignEligibility()')
  })
})
