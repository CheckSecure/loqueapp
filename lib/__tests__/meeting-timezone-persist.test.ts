import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { normalizeIanaTimeZone, formatMeetingTimes } from '@/lib/meetings/formatMeetingTime'
import { isMissingColumnError } from '@/lib/db/isMissingColumn'

// Modern Node's Intl inserts a narrow no-break space (U+202F) before AM/PM.
const norm = (s: string | null) => (s == null ? s : s.replace(/ /g, ' '))

describe('normalizeIanaTimeZone — validated before storage', () => {
  it('passes through real IANA zones (what gets stored on create/reschedule)', () => {
    for (const tz of ['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Australia/Sydney', 'UTC']) {
      expect(normalizeIanaTimeZone(tz)).toBe(tz)
    }
  })
  it('trims surrounding whitespace', () => {
    expect(normalizeIanaTimeZone('  America/New_York  ')).toBe('America/New_York')
  })
  it('returns null for blank/missing → store NULL', () => {
    expect(normalizeIanaTimeZone('')).toBeNull()
    expect(normalizeIanaTimeZone('   ')).toBeNull()
    expect(normalizeIanaTimeZone(null)).toBeNull()
    expect(normalizeIanaTimeZone(undefined)).toBeNull()
  })
  it('returns null for an invalid zone → store NULL (create) / preserve prior (reschedule)', () => {
    expect(normalizeIanaTimeZone('Not/AZone')).toBeNull()
    expect(normalizeIanaTimeZone('Mars/Phobos')).toBeNull()
    expect(normalizeIanaTimeZone('America/Nowhere')).toBeNull()
  })
})

describe('isMissingColumnError — enables the pre-migration write fallback', () => {
  it('detects PostgREST / Postgres missing-column signatures', () => {
    expect(isMissingColumnError({ code: 'PGRST204', message: "Could not find the 'scheduled_timezone' column" })).toBe(true)
    expect(isMissingColumnError({ code: '42703', message: 'column "scheduled_timezone" does not exist' })).toBe(true)
    expect(isMissingColumnError({ message: 'schema cache reload' })).toBe(true)
  })
  it('is false for null and unrelated errors', () => {
    expect(isMissingColumnError(null)).toBe(false)
    expect(isMissingColumnError(undefined)).toBe(false)
    expect(isMissingColumnError({ code: '23505', message: 'duplicate key value' })).toBe(false)
  })
})

describe('acceptance email formatting uses the STORED timezone', () => {
  const iso = '2026-07-30T22:00:00.000Z' // canonical UTC on the record

  it('stored America/New_York → local EDT + UTC', () => {
    const { dateLabel, localLabel, utcLabel } = formatMeetingTimes(iso, 'America/New_York')
    expect(norm(localLabel)).toBe('6:00 PM EDT')
    expect(norm(utcLabel)).toBe('10:00 PM UTC')
    expect(norm(dateLabel)).toContain('July 30')
  })
  it('legacy meeting with NULL stored timezone → UTC only', () => {
    const { localLabel, utcLabel } = formatMeetingTimes(iso, null)
    expect(localLabel).toBeNull()
    expect(norm(utcLabel)).toBe('10:00 PM UTC')
  })
})

describe('write/read sites + UTC & .ics invariants (source guards)', () => {
  const actions = readFileSync('app/actions.ts', 'utf8')
  const ics = readFileSync('lib/ics.ts', 'utf8')

  it('meeting creation stores a validated scheduled_timezone', () => {
    expect(actions).toContain("normalizeIanaTimeZone(formData.get('timezone')")
    expect(actions).toMatch(/scheduled_timezone:\s*scheduledTimezone/)
  })
  it('reschedule sets scheduled_timezone only when valid (preserves prior otherwise)', () => {
    expect(actions).toMatch(/if \(rescheduleTimezone\) rescheduleUpdate\.scheduled_timezone = rescheduleTimezone/)
  })
  it('acceptance reads scheduled_timezone and passes it to formatMeetingTimes', () => {
    expect(actions).toMatch(/select\('scheduled_at, scheduled_timezone'\)/)
    expect(actions).toMatch(/formatMeetingTimes\(\s*updatedMeeting\.scheduled_at,\s*updatedMeeting\.scheduled_timezone/)
  })
  it('scheduled_at is still computed and stored as UTC (unchanged)', () => {
    expect(actions).toMatch(/scheduled_at = new Date\(localDate\.getTime\(\) \+ timezoneOffset \* 60000\)\.toISOString\(\)/)
  })
  it('.ics generation is unchanged and never references the stored timezone', () => {
    expect(ics).not.toMatch(/scheduled_timezone/)
    expect(ics).toMatch(/DTSTART:/)
    expect(ics).toMatch(/toISOString\(\)/) // still derived from the UTC instant
  })
})
