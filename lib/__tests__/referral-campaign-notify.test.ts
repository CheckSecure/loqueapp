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
    // TOP-LEVEL param, not a data field: only that selects the exact-once duplicate check.
    // Passing it inside `data` populates the column but leaves the check on its legacy 24h path.
    expect(ROUTE).toContain('dedupeKey: CAMPAIGN_KEY,')
    expect(ROUTE).not.toContain('data: { dedupeKey')
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

describe('internal-account override is confined to explicitly named ids', () => {
  it('a broadcast passes an EMPTY override — internal accounts can never leak in', () => {
    // This is the whole safety property. `only` is null unless userIds were supplied, so a
    // broadcast run resolves alwaysInclude to [].
    expect(ROUTE).toContain('alwaysInclude: only ? Array.from(only) : []')
  })

  it('the override waives ONLY the internal markers', () => {
    // Deactivated, incomplete profile, invalid email and the opt-out must still exclude a named
    // account — none of those are about being internal, and each would make the send wrong.
    expect(ELIG).toContain('const internalOverride = alwaysInclude.has(m.id)')
    expect(ELIG).toContain('if (isInternal && internalOverride) {')
    for (const stillApplies of [
      "if (m.profile_complete !== true) { breakdown.excludedOnboarding++; continue }",
      "if (!email || !EMAIL_REGEX.test(email)) { breakdown.excludedInvalidEmail++; continue }",
      "if (m.account_status !== 'active') { breakdown.excludedDeactivated++; continue }",
    ]) {
      expect(ELIG).toContain(stillApplies)
    }
  })

  it('the override is counted and reported, not silent', () => {
    expect(ELIG).toContain('breakdown.internalOverridden++')
    expect(ROUTE).toContain('internalOverridden: breakdown.internalOverridden')
    expect(ROUTE).toContain('targetedByExplicitIds')
  })

  it('defaults to no override when the option is omitted', () => {
    expect(ELIG).toContain('const alwaysInclude = new Set(opts.alwaysInclude ?? [])')
  })
})

describe('referral_credit_awarded notification', () => {
  const COMPLETE = readFileSync('app/api/profile/complete/route.ts', 'utf8')

  it('exists as a type, with fallback copy and a link', () => {
    expect(NOTIF).toContain("| 'referral_credit_awarded'")
    expect(NOTIF).toContain("referral_credit_awarded: '/dashboard/network'")
    expect(NOTIF).toContain("title: 'Someone you recommended just joined'")
  })

  it('fires ONLY inside the confirmed-award branch', () => {
    // A notification saying "your credit has been added" must never outlive the credit. It has to
    // sit after the success log, not beside the write.
    const award = COMPLETE.indexOf("console.log('[profile/complete] referral credit awarded'")
    const notify = COMPLETE.indexOf("type: 'referral_credit_awarded'")
    const failBranch = COMPLETE.indexOf('REFERRAL_CREDIT_WRITE_FAILED')
    expect(award).toBeGreaterThan(-1)
    expect(notify).toBeGreaterThan(award)
    expect(notify).toBeGreaterThan(failBranch)
  })

  it('is exact-once per NOMINATION, not per member', () => {
    // Someone who recommends five people who all join should hear five times.
    expect(COMPLETE).toContain('dedupeKey: referralRow.id')
  })

  it('names the nominee, and degrades to the static copy without a name', () => {
    expect(COMPLETE).toContain('just joined — you earned a credit')
    expect(COMPLETE).toContain('Thanks for recommending')
    expect(COMPLETE).toContain('nomineeFirst')
    expect(COMPLETE).toContain('...(nomineeFirst')
  })

  it('reads the nominee name from the row it already queried', () => {
    expect(COMPLETE).toContain(".select('id, full_name')")
  })
})
