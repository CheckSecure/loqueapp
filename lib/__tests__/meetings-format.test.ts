import { describe, it, expect } from 'vitest'
import { sortContactsByName } from '@/lib/meetings/sortContacts'
import { formatMeetingTimes } from '@/lib/meetings/formatMeetingTime'

// Modern Node's Intl inserts a narrow no-break space (U+202F) before AM/PM.
const norm = (s: string | null) => (s == null ? s : s.replace(/ /g, ' '))

describe('sortContactsByName — alphabetical, case-insensitive, email tie-break', () => {
  it('sorts A→Z by display name', () => {
    const out = sortContactsByName([
      { full_name: 'Carol', email: 'c@x.com' },
      { full_name: 'Alice', email: 'a@x.com' },
      { full_name: 'Bob', email: 'b@x.com' },
    ])
    expect(out.map((c) => c.full_name)).toEqual(['Alice', 'Bob', 'Carol'])
  })

  it('ignores case when sorting', () => {
    const out = sortContactsByName([
      { full_name: 'bob', email: 'b@x.com' },
      { full_name: 'Alice', email: 'a@x.com' },
      { full_name: 'Zoe', email: 'z@x.com' },
    ])
    expect(out.map((c) => c.full_name)).toEqual(['Alice', 'bob', 'Zoe'])
  })

  it('breaks ties on identical names using email', () => {
    const out = sortContactsByName([
      { full_name: 'Alex Kim', email: 'zed@x.com' },
      { full_name: 'Alex Kim', email: 'amy@x.com' },
      { full_name: 'alex kim', email: 'mid@x.com' },
    ])
    expect(out.map((c) => c.email)).toEqual(['amy@x.com', 'mid@x.com', 'zed@x.com'])
  })

  it('does not mutate the input array', () => {
    const input = [{ full_name: 'B' }, { full_name: 'A' }]
    const copy = [...input]
    sortContactsByName(input)
    expect(input).toEqual(copy)
  })

  it('handles missing / blank names safely', () => {
    const out = sortContactsByName([
      { full_name: 'Bob', email: 'b@x.com' },
      { full_name: null, email: 'a@x.com' },
      { email: 'z@x.com' },
    ])
    // Blank names sort first; among blanks, email tie-break applies.
    expect(out.map((c) => c.email)).toEqual(['a@x.com', 'z@x.com', 'b@x.com'])
  })
})

describe('formatMeetingTimes — local + UTC, real abbreviations, UTC canonical', () => {
  const iso = '2026-07-30T22:00:00.000Z' // 10:00 PM UTC

  it('shows local time with a real abbreviation AND UTC (America/New_York → EDT)', () => {
    const { dateLabel, localLabel, utcLabel } = formatMeetingTimes(iso, 'America/New_York')
    expect(norm(localLabel)).toBe('6:00 PM EDT')
    expect(norm(utcLabel)).toBe('10:00 PM UTC')
    expect(norm(dateLabel)).toContain('July 30')
  })

  it('uses the real Pacific abbreviation (America/Los_Angeles → PDT)', () => {
    const { localLabel, utcLabel } = formatMeetingTimes(iso, 'America/Los_Angeles')
    expect(norm(localLabel)).toBe('3:00 PM PDT')
    expect(norm(utcLabel)).toBe('10:00 PM UTC')
  })

  it('computes the DATE in the local zone (cross-midnight): UTC 31st is still the 30th in New York', () => {
    const { dateLabel, localLabel, utcLabel } = formatMeetingTimes('2026-07-31T01:00:00.000Z', 'America/New_York')
    expect(norm(localLabel)).toBe('9:00 PM EDT')
    expect(norm(utcLabel)).toBe('1:00 AM UTC')
    expect(norm(dateLabel)).toContain('July 30') // local date, not the UTC 31st
  })

  it('falls back to UTC-only when no timezone is provided', () => {
    const { localLabel, utcLabel, dateLabel } = formatMeetingTimes(iso, null)
    expect(localLabel).toBeNull()
    expect(norm(utcLabel)).toBe('10:00 PM UTC')
    expect(norm(dateLabel)).toContain('July 30')
  })

  it('does not show a redundant local line when the zone IS UTC', () => {
    expect(formatMeetingTimes(iso, 'UTC').localLabel).toBeNull()
    expect(formatMeetingTimes(iso, 'Etc/UTC').localLabel).toBeNull()
  })

  it('fails safe on an invalid IANA zone (UTC-only, no throw)', () => {
    const { localLabel, utcLabel } = formatMeetingTimes(iso, 'Not/AZone')
    expect(localLabel).toBeNull()
    expect(norm(utcLabel)).toBe('10:00 PM UTC')
  })
})
