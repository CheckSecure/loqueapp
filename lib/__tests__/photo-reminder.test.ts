import { describe, it, expect } from 'vitest'
import {
  shouldShowPhotoReminder,
  nextDismissState,
  parseState,
  PhotoReminderState,
} from '@/lib/photoReminder'

const NOW = 1_700_000_000_000 // fixed epoch ms
const DAY = 24 * 60 * 60 * 1000

describe('photo reminder — visibility', () => {
  it('appears when the avatar is missing and never dismissed', () => {
    expect(shouldShowPhotoReminder(false, null, NOW)).toBe(true)
  })

  it('does NOT appear when a photo exists (regardless of stored state)', () => {
    expect(shouldShowPhotoReminder(true, null, NOW)).toBe(false)
    const dismissed: PhotoReminderState = { count: 1, hiddenUntil: NOW + 21 * DAY }
    expect(shouldShowPhotoReminder(true, dismissed, NOW)).toBe(false)
  })
})

describe('photo reminder — escalating dismissal', () => {
  it('first "Maybe later" hides for 21 days', () => {
    const state = nextDismissState(null, NOW)
    expect(state).toEqual({ count: 1, hiddenUntil: NOW + 21 * DAY })
    // hidden during the window...
    expect(shouldShowPhotoReminder(false, state, NOW + 20 * DAY)).toBe(false)
    // ...visible again once 21 days pass
    expect(shouldShowPhotoReminder(false, state, NOW + 21 * DAY)).toBe(true)
  })

  it('second "Maybe later" hides for 45 days', () => {
    const first = nextDismissState(null, NOW)
    const second = nextDismissState(first, NOW + 21 * DAY)
    expect(second).toEqual({ count: 2, hiddenUntil: NOW + 21 * DAY + 45 * DAY })
    expect(shouldShowPhotoReminder(false, second, NOW + 21 * DAY + 44 * DAY)).toBe(false)
    expect(shouldShowPhotoReminder(false, second, NOW + 21 * DAY + 45 * DAY)).toBe(true)
  })

  it('third "Maybe later" hides permanently', () => {
    const first = nextDismissState(null, NOW)
    const second = nextDismissState(first, NOW + 21 * DAY)
    const third = nextDismissState(second, NOW + 100 * DAY)
    expect(third.count).toBe(3)
    // never shows again, even far in the future, while no photo exists
    expect(shouldShowPhotoReminder(false, third, NOW + 100 * DAY)).toBe(false)
    expect(shouldShowPhotoReminder(false, third, NOW + 10_000 * DAY)).toBe(false)
  })
})

describe('photo reminder — upload permanently suppresses', () => {
  it('is suppressed once a photo exists, even mid-snooze', () => {
    const first = nextDismissState(null, NOW)
    // still within the 21-day window, but a photo now exists → suppressed
    expect(shouldShowPhotoReminder(true, first, NOW + 1 * DAY)).toBe(false)
    // and after the window too
    expect(shouldShowPhotoReminder(true, first, NOW + 30 * DAY)).toBe(false)
  })
})

describe('photo reminder — state parsing', () => {
  it('round-trips a dismissal state', () => {
    const state = nextDismissState(null, NOW)
    expect(parseState(JSON.stringify(state))).toEqual(state)
  })
  it('returns null for absent/invalid stored values', () => {
    expect(parseState(null)).toBeNull()
    expect(parseState('')).toBeNull()
    expect(parseState('not json')).toBeNull()
    expect(parseState('{"foo":1}')).toBeNull()
  })
})
