import { describe, it, expect } from 'vitest'
import {
  formatMessageTime,
  localDayKey,
  isSameLocalDay,
  formatDaySeparator,
  shouldShowDaySeparator,
} from '@/lib/messageTime'

// Local constructor so day keys are deterministic regardless of the test
// machine's timezone (these mirror how the browser computes the viewer's day).
const local = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo, d, h, mi)

describe('formatMessageTime', () => {
  it('renders a concise local time for valid input', () => {
    const t = formatMessageTime(local(2026, 6, 15, 15, 42).toISOString())
    expect(t).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)$/i)
  })
  it('returns empty string for null / undefined / invalid', () => {
    expect(formatMessageTime(null)).toBe('')
    expect(formatMessageTime(undefined)).toBe('')
    expect(formatMessageTime('not-a-date')).toBe('')
    expect(formatMessageTime('')).toBe('')
  })
})

describe('local day grouping', () => {
  it('same local day → same key; different day → different key', () => {
    expect(localDayKey(local(2026, 6, 15, 9, 18))).toBe(localDayKey(local(2026, 6, 15, 23, 59)))
    expect(localDayKey(local(2026, 6, 15))).not.toBe(localDayKey(local(2026, 6, 16)))
  })
  it('isSameLocalDay handles the midnight boundary by local calendar date', () => {
    expect(isSameLocalDay(local(2026, 6, 15, 0, 1), local(2026, 6, 15, 23, 59))).toBe(true)
    expect(isSameLocalDay(local(2026, 6, 15, 23, 59), local(2026, 6, 16, 0, 1))).toBe(false)
  })
  it('invalid timestamps are never "same day"', () => {
    expect(isSameLocalDay('bad', local(2026, 6, 15))).toBe(false)
    expect(localDayKey('bad')).toBeNull()
  })
})

describe('shouldShowDaySeparator', () => {
  const msgs = [
    { created_at: local(2026, 6, 14, 9, 18).toISOString() },
    { created_at: local(2026, 6, 14, 9, 24).toISOString() }, // same day → no separator
    { created_at: local(2026, 6, 15, 8, 3).toISOString() },  // new day → separator
  ]
  it('always shows before the first message', () => {
    expect(shouldShowDaySeparator(msgs, 0)).toBe(true)
  })
  it('hides for a later message on the same local day', () => {
    expect(shouldShowDaySeparator(msgs, 1)).toBe(false)
  })
  it('shows again when the local day changes', () => {
    expect(shouldShowDaySeparator(msgs, 2)).toBe(true)
  })
})

describe('formatDaySeparator labels', () => {
  const now = local(2026, 6, 15, 10, 0) // July 15, 2026, local noon-ish
  it('labels the current local day "Today"', () => {
    expect(formatDaySeparator(local(2026, 6, 15, 8, 3).toISOString(), now)).toBe('Today')
  })
  it('labels the previous local day "Yesterday"', () => {
    expect(formatDaySeparator(local(2026, 6, 14, 21, 0).toISOString(), now)).toBe('Yesterday')
  })
  it('labels older days with a full readable date (not Today/Yesterday)', () => {
    const label = formatDaySeparator(local(2026, 6, 10, 9, 0).toISOString(), now)
    expect(label).toBeTruthy()
    expect(label).not.toBe('Today')
    expect(label).not.toBe('Yesterday')
    expect(label).toMatch(/2026/) // e.g. "July 10, 2026"
  })
  it('returns null for invalid input (caller renders no separator)', () => {
    expect(formatDaySeparator('bad', now)).toBeNull()
    expect(formatDaySeparator(null, now)).toBeNull()
  })
  it('handles a message just after midnight as its own new day', () => {
    const now2 = local(2026, 6, 16, 0, 5)
    expect(formatDaySeparator(local(2026, 6, 16, 0, 1).toISOString(), now2)).toBe('Today')
    expect(formatDaySeparator(local(2026, 6, 15, 23, 59).toISOString(), now2)).toBe('Yesterday')
  })
})
