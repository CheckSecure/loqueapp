import { describe, it, expect } from 'vitest'
import {
  resolveThursdayBanner, isEligibleForMatching, canViewThursdayBanner, type ThursdayBannerView,
} from '@/lib/introductions/thursdayBanner'

const RUN_UP = new Date('2026-08-18T12:00:00Z')     // Tue, before the Thu window
const IN_WINDOW = new Date('2026-08-20T14:30:00Z')  // Thu, mid invocation window
const AFTER_WINDOW = new Date('2026-08-20T16:00:00Z') // Thu, after the window

const OK = { accountStatus: 'active', profileComplete: true, isTestAccount: false, matchingPaused: false, isAdmin: false }

describe('isEligibleForMatching — matching gate: admins are NEVER matching-eligible', () => {
  it('eligible for an ordinary active/complete/unpaused/non-test member', () => {
    expect(isEligibleForMatching(OK)).toBe(true)
  })
  it('an admin is ineligible for matching even when active/complete/unpaused', () => {
    expect(isEligibleForMatching({ ...OK, isAdmin: true })).toBe(false)
  })
  it('hidden for paused / inactive / incomplete / test', () => {
    expect(isEligibleForMatching({ ...OK, matchingPaused: true })).toBe(false)
    expect(isEligibleForMatching({ ...OK, accountStatus: 'inactive' })).toBe(false)
    expect(isEligibleForMatching({ ...OK, profileComplete: false })).toBe(false)
    expect(isEligibleForMatching({ ...OK, isTestAccount: true })).toBe(false)
  })
})

describe('canViewThursdayBanner — visibility is SEPARATE from matching eligibility', () => {
  it('ordinary members: identical to matching eligibility', () => {
    expect(canViewThursdayBanner(OK)).toBe(true)
    expect(canViewThursdayBanner({ ...OK, isTestAccount: true })).toBe(false) // ordinary test → hidden
    expect(canViewThursdayBanner({ ...OK, matchingPaused: true })).toBe(false)
  })
  it('an active/complete/unpaused ADMIN may view — even if flagged as a test account', () => {
    expect(canViewThursdayBanner({ ...OK, isAdmin: true })).toBe(true)
    expect(canViewThursdayBanner({ ...OK, isAdmin: true, isTestAccount: true })).toBe(true)
  })
  it('inactive / incomplete / paused ADMIN remains hidden', () => {
    expect(canViewThursdayBanner({ ...OK, isAdmin: true, accountStatus: 'inactive' })).toBe(false)
    expect(canViewThursdayBanner({ ...OK, isAdmin: true, profileComplete: false })).toBe(false)
    expect(canViewThursdayBanner({ ...OK, isAdmin: true, matchingPaused: true })).toBe(false)
  })
  it('viewing the banner never implies matching eligibility (admin can view but is not eligible)', () => {
    const admin = { ...OK, isAdmin: true }
    expect(canViewThursdayBanner(admin)).toBe(true)
    expect(isEligibleForMatching(admin)).toBe(false)
  })
})

describe('resolveThursdayBanner — hidden when canView is false', () => {
  it('returns null when the viewer cannot see the banner', () => {
    expect(resolveThursdayBanner({ now: RUN_UP, canView: false, receivedThisCycle: true, releasedThisCycle: true })).toBeNull()
  })
})

describe('resolveThursdayBanner — ordinary member: post_release / after_received', () => {
  it('run-up shows the neutral countdown to the Thursday 14:00 UTC window', () => {
    const v = resolveThursdayBanner({ now: RUN_UP, canView: true, receivedThisCycle: null, releasedThisCycle: true }) as ThursdayBannerView
    expect(v.kind).toBe('post_release')
    expect(v.title).toBe('Next introduction batch: Thursday')
    expect(v.subtitle).toBe('The next curated introduction batch is being prepared.')
    expect(v.showCountdown).toBe(true)
    expect(v.targetIso).toBe('2026-08-20T14:00:00.000Z')
    expect(v.initialCountdownText).toMatch(/remaining$/)
  })
  it('after the window passes, rolls forward to the following Thursday', () => {
    const v = resolveThursdayBanner({ now: AFTER_WINDOW, canView: true, receivedThisCycle: false, releasedThisCycle: true })!
    expect(v.kind).toBe('post_release')
    expect(v.targetIso).toBe('2026-08-27T14:00:00.000Z')
  })
  it('proven new suggestion → after_received', () => {
    const v = resolveThursdayBanner({ now: IN_WINDOW, canView: true, receivedThisCycle: true, releasedThisCycle: true })!
    expect(v.kind).toBe('after_received')
    expect(v.title).toBe('New introductions are here')
    expect(v.showCountdown).toBe(false)
  })
})

describe('resolveThursdayBanner — ADMIN schedule-only view', () => {
  it('active/complete/unpaused admin sees the NEUTRAL countdown', () => {
    const v = resolveThursdayBanner({ now: RUN_UP, canView: true, receivedThisCycle: false, releasedThisCycle: true, scheduleOnly: true })!
    expect(v.kind).toBe('post_release')
    expect(v.title).toBe('Next introduction batch: Thursday')
    expect(v.subtitle).toBe('The next curated introduction batch is being prepared.')
    expect(v.showCountdown).toBe(true)
  })
  it('admin NEVER gets after_received — even if evidence somehow says true', () => {
    const v = resolveThursdayBanner({ now: IN_WINDOW, canView: true, receivedThisCycle: true, releasedThisCycle: true, scheduleOnly: true })!
    expect(v.kind).toBe('post_release')
    expect(v.title).not.toBe('New introductions are here')
  })
})

describe('NO false negative — "still looking" / after_none is NEVER produced', () => {
  it('false and null both yield the neutral before-countdown', () => {
    expect(resolveThursdayBanner({ now: IN_WINDOW, canView: true, receivedThisCycle: false, releasedThisCycle: true })!.kind).toBe('post_release')
    expect(resolveThursdayBanner({ now: IN_WINDOW, canView: true, receivedThisCycle: null, releasedThisCycle: true })!.kind).toBe('post_release')
  })
  it('the resolver can only ever return before | after_received', () => {
    for (const ev of [true, false, null] as const) {
      for (const so of [true, false]) {
        const v = resolveThursdayBanner({ now: IN_WINDOW, canView: true, receivedThisCycle: ev, releasedThisCycle: true, scheduleOnly: so })!
        expect(['post_release', 'after_received']).toContain(v.kind)
      }
    }
  })
})

describe('copy safety — no guaranteed match, no exact-hour claim, no notification promise', () => {
  const banned = /guarantee|every member|will (be matched|receive|get)|assured|9\s*(:00)?\s*(am)?\s*(et|est|edt|eastern)|exactly at|notify you/i
  it('no state promises a match, an exact time, or a notification', () => {
    for (const now of [RUN_UP, IN_WINDOW, AFTER_WINDOW]) {
      for (const ev of [true, false, null] as const) {
        for (const so of [true, false]) {
          const v = resolveThursdayBanner({ now, canView: true, receivedThisCycle: ev, releasedThisCycle: true, scheduleOnly: so })
          if (!v) continue
          expect(`${v.title} ${v.subtitle ?? ''}`).not.toMatch(banned)
        }
      }
    }
  })
})
