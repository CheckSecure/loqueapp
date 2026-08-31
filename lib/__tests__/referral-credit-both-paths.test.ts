import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const ACTIONS = readFileSync('app/actions.ts', 'utf8')
const ROUTE = readFileSync('app/api/profile/complete/route.ts', 'utf8')
const HELPER = readFileSync('lib/referrals/awardReferralCredit.ts', 'utf8')

describe('the referral credit hook runs on BOTH completion paths', () => {
  // Migration 084 names both writers of profile_complete. The hook lived in only one of them,
  // which is why nine activated nominees left their referrers uncredited.
  it('completeOnboarding calls it — the path that previously skipped it entirely', () => {
    expect(ACTIONS).toContain('awardReferralCreditOnCompletion(user.id, user.email)')
  })

  it('POST /api/profile/complete calls it', () => {
    expect(ROUTE).toContain('awardReferralCreditOnCompletion(user.id, user.email)')
  })

  it('neither path keeps an inline copy — one implementation, not two', () => {
    // A second copy is how the two would drift back apart.
    for (const src of [ACTIONS, ROUTE]) {
      expect(src).not.toContain('awarded_credit: true')
      expect(src).not.toContain("eq('status', 'invited')")
    }
  })
})

describe('the helper preserves the original contract', () => {
  it('never throws — both callers are fire-and-forget', () => {
    expect(HELPER).toContain('catch (err: any)')
    expect(HELPER).toContain("return 'error'")
  })

  it('marks the relationship activated even when the credit is withheld', () => {
    const activate = HELPER.indexOf("status: 'activated'")
    const inactiveCheck = HELPER.indexOf("referrerProfile?.account_status !== 'active'")
    expect(activate).toBeGreaterThan(-1)
    expect(activate).toBeLessThan(inactiveCheck) // activated BEFORE the credit decision
  })

  it('keeps the monthly cap', () => {
    expect(HELPER).toContain('REFERRAL_CREDIT_MONTHLY_CAP = 5')
    expect(HELPER).toContain("return 'cap_reached'")
  })

  it('keeps the credit in the purchased bucket and checks the write error', () => {
    expect(HELPER).toContain('premium_credits: currentPremium + 1')
    expect(HELPER).toContain('const { error: creditError }')
    expect(HELPER).toContain("return 'credit_write_failed'")
  })

  it('only marks awarded_credit after a successful write', () => {
    const write = HELPER.indexOf('const { error: creditError }')
    const mark = HELPER.indexOf('awarded_credit: true')
    const fail = HELPER.indexOf("return 'credit_write_failed'")
    expect(mark).toBeGreaterThan(write)
    expect(mark).toBeGreaterThan(fail) // the failure path returns before the marker
  })

  it('notifies only on a confirmed award', () => {
    const mark = HELPER.indexOf('awarded_credit: true')
    const notify = HELPER.indexOf("type: 'referral_credit_awarded'")
    expect(notify).toBeGreaterThan(mark)
    expect(HELPER).toContain('dedupeKey: referralRow.id')
  })
})
