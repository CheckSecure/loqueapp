import { describe, it, expect } from 'vitest'
import {
  resolveThursdayBanner, isEligibleForMatching, type ThursdayBannerView,
} from '@/lib/introductions/thursdayBanner'

const RUN_UP = new Date('2026-08-18T12:00:00Z')     // Tue, before the Thu window
const IN_WINDOW = new Date('2026-08-20T14:30:00Z')  // Thu, mid invocation window
const AFTER_WINDOW = new Date('2026-08-20T16:00:00Z') // Thu, after the window

const OK = { accountStatus: 'active', profileComplete: true, isTestAccount: false, matchingPaused: false, isAdmin: false }

describe('isEligibleForMatching — mirrors the matching gate + explicit admin exclusion', () => {
  it('eligible when active + complete + not test + not paused + not admin', () => {
    expect(isEligibleForMatching(OK)).toBe(true)
  })
  it('HIDDEN for a paused member', () => {
    expect(isEligibleForMatching({ ...OK, matchingPaused: true })).toBe(false)
  })
  it('HIDDEN for an inactive/deactivated account', () => {
    expect(isEligibleForMatching({ ...OK, accountStatus: 'inactive' })).toBe(false)
    expect(isEligibleForMatching({ ...OK, accountStatus: 'deactivated' })).toBe(false)
  })
  it('HIDDEN for an incomplete profile', () => {
    expect(isEligibleForMatching({ ...OK, profileComplete: false })).toBe(false)
  })
  it('HIDDEN for a test account', () => {
    expect(isEligibleForMatching({ ...OK, isTestAccount: true })).toBe(false)
  })
  it('HIDDEN for an admin account (is_admin = true)', () => {
    expect(isEligibleForMatching({ ...OK, isAdmin: true })).toBe(false)
  })
  it('fails closed on missing fields', () => {
    expect(isEligibleForMatching({})).toBe(false)
  })
})

describe('resolveThursdayBanner — ineligible members (incl. admins) get NO banner', () => {
  it('returns null when ineligible', () => {
    expect(resolveThursdayBanner({ now: RUN_UP, eligible: false, receivedThisCycle: true })).toBeNull()
  })
  it('an admin (server-decided ineligible) never sees the banner', () => {
    const eligible = isEligibleForMatching({ ...OK, isAdmin: true })
    expect(resolveThursdayBanner({ now: IN_WINDOW, eligible, receivedThisCycle: true })).toBeNull()
  })
})

describe('resolveThursdayBanner — before / neutral Thursday countdown', () => {
  it('run-up shows the countdown to the actual Thursday 14:00 UTC window', () => {
    const v = resolveThursdayBanner({ now: RUN_UP, eligible: true, receivedThisCycle: null }) as ThursdayBannerView
    expect(v.kind).toBe('before')
    expect(v.title).toBe('Next introduction batch: Thursday')
    expect(v.subtitle).toBe('The next curated introduction batch is being prepared.')
    expect(v.showCountdown).toBe(true)
    expect(v.targetIso).toBe('2026-08-20T14:00:00.000Z')
    expect(v.initialCountdownText).toMatch(/remaining$/)
  })
  it('after the window passes, the countdown rolls to the FOLLOWING Thursday', () => {
    const v = resolveThursdayBanner({ now: AFTER_WINDOW, eligible: true, receivedThisCycle: false })!
    expect(v.kind).toBe('before')
    expect(v.targetIso).toBe('2026-08-27T14:00:00.000Z')
  })
})

describe('resolveThursdayBanner — "New introductions are here" ONLY on proven evidence', () => {
  it('receivedThisCycle === true → after_received', () => {
    const v = resolveThursdayBanner({ now: IN_WINDOW, eligible: true, receivedThisCycle: true })!
    expect(v.kind).toBe('after_received')
    expect(v.title).toBe('New introductions are here')
    expect(v.subtitle).toBe('Review your latest curated connections.')
    expect(v.showCountdown).toBe(false)
  })
})

describe('NO false negative — "still looking" / after_none is NEVER produced', () => {
  it('receivedThisCycle === false → neutral before-countdown, NOT a negative outcome', () => {
    const v = resolveThursdayBanner({ now: IN_WINDOW, eligible: true, receivedThisCycle: false })!
    expect(v.kind).toBe('before')
    expect(`${v.title} ${v.subtitle}`).not.toMatch(/still looking|couldn|no introduction|not matched|nothing/i)
  })
  it('receivedThisCycle === null (unprovable) → neutral before-countdown', () => {
    const v = resolveThursdayBanner({ now: IN_WINDOW, eligible: true, receivedThisCycle: null })!
    expect(v.kind).toBe('before')
  })
  it('the resolver can only ever return before | after_received (no after_none/neutral kinds)', () => {
    for (const ev of [true, false, null] as const) {
      const v = resolveThursdayBanner({ now: IN_WINDOW, eligible: true, receivedThisCycle: ev })!
      expect(['before', 'after_received']).toContain(v.kind)
    }
  })
})

describe('copy safety — no guaranteed match, no exact-hour claim', () => {
  const banned = /guarantee|every member|will (be matched|receive|get)|assured|9\s*(:00)?\s*(am)?\s*(et|est|edt|eastern)|exactly at/i
  it('no state promises a match or an exact release time', () => {
    for (const now of [RUN_UP, IN_WINDOW, AFTER_WINDOW]) {
      for (const ev of [true, false, null] as const) {
        const v = resolveThursdayBanner({ now, eligible: true, receivedThisCycle: ev })
        if (!v) continue
        expect(`${v.title} ${v.subtitle ?? ''}`).not.toMatch(banned)
      }
    }
  })
})
