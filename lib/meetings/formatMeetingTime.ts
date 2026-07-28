/**
 * Presentation-only dual-timezone formatting for meeting emails.
 *
 * The canonical meeting time is stored and scheduled in UTC (unchanged — .ics and
 * all backend logic keep using the UTC ISO string). This helper ONLY formats that
 * UTC instant for human display in emails: the recipient's/scheduler's local time
 * AND the canonical UTC time, so a reader immediately sees their local time while
 * still seeing the reference UTC.
 *
 * `timeZone` is an IANA name (e.g. "America/New_York") captured from the same
 * browser that the meeting-request screen used, so the email's local time always
 * matches what the scheduler saw. `timeZoneName: 'short'` yields the real
 * abbreviation when one exists (EDT, PDT, BST, AEST) and a GMT offset otherwise —
 * more informative than a generic "Local Time", and it survives forwarding.
 */
export interface MeetingTimeDisplay {
  /** e.g. "Thursday, July 30" — in the local zone when available, else UTC. */
  dateLabel: string
  /** e.g. "6:00 PM EDT" — null when no usable local zone (or it equals UTC). */
  localLabel: string | null
  /** e.g. "10:00 PM UTC" — always present. */
  utcLabel: string
}

function isUsableZone(tz: string): boolean {
  const z = tz.trim()
  return z !== '' && z.toUpperCase() !== 'UTC' && z.toLowerCase() !== 'etc/utc'
}

/**
 * Validate + normalize an IANA timezone for storage on the meeting record.
 * Returns the trimmed zone when it is a real IANA name (Intl accepts it), or null
 * when blank or invalid — so callers store NULL rather than a bogus value and the
 * email display falls back to UTC-only.
 */
export function normalizeIanaTimeZone(input: string | null | undefined): string | null {
  const tz = (input || '').trim()
  if (!tz) return null
  try {
    // Throws RangeError for an unknown/invalid IANA zone.
    Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return null
  }
}

export function formatMeetingTimes(isoUtc: string, timeZone?: string | null): MeetingTimeDisplay {
  const d = new Date(isoUtc)

  const utcLabel = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  })

  const tz = (timeZone || '').trim()
  let dateLabel: string
  let localLabel: string | null = null

  if (isUsableZone(tz)) {
    try {
      dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz })
      localLabel = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' })
    } catch {
      // Invalid/unknown IANA zone → fall back to UTC date, no local line.
      dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
      localLabel = null
    }
  } else {
    dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
  }

  // If the local rendering is identical to UTC (scheduler already in UTC), don't
  // show two redundant lines.
  if (localLabel && localLabel === utcLabel) localLabel = null

  return { dateLabel, localLabel, utcLabel }
}
