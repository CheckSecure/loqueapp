// Shared ICS (RFC 5545) generation for meeting calendar downloads.
//
// Both meeting download surfaces (MeetingDetailModal + MeetingsClient) import
// from here so the two paths can never drift. Runs in the browser (uses Blob /
// document) — invoked from client components on user click.

export interface ICSMeeting {
  id: string
  title: string
  scheduled_at: string
  duration_minutes: number
  meeting_type?: string
  location?: string | null
  zoom_link?: string | null
  notes?: string | null
}

// RFC 5545 §3.3.11 TEXT escaping. Order matters: escape the backslash first,
// then semicolons, commas, and embedded newlines. Applied to TEXT-typed values
// (SUMMARY, LOCATION, DESCRIPTION) — never to URI-typed values (URL).
export function escapeICSText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

// UTC basic format, e.g. 20260712T143000Z — unchanged from the prior inline
// helper (the trailing no-op Z replace was dropped; output is identical).
function toICSDate(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

export function buildMeetingICS(m: ICSMeeting): string {
  const start = new Date(m.scheduled_at)
  const end = new Date(start.getTime() + m.duration_minutes * 60000)
  const now = new Date()

  // DESCRIPTION: escape each part's own content, then join with the literal ICS
  // newline separator (\n) so the separators themselves are not re-escaped.
  const description = [
    m.notes || '',
    m.zoom_link ? `Meeting link: ${m.zoom_link}` : '',
  ]
    .filter(Boolean)
    .map(escapeICSText)
    .join('\\n')

  // LOCATION: physical venue for in-person meetings; fall back to the meeting
  // URL for virtual meetings that have no physical location. The URL stays in
  // DESCRIPTION too (above) for client compatibility.
  const physicalLocation = (m.location || '').trim()
  const locationValue = physicalLocation || (m.zoom_link || '').trim()

  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Loque//Loque Networking//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:loque-meeting-${m.id}@loque.app`,
    `DTSTAMP:${toICSDate(now.toISOString())}`,
    `DTSTART:${toICSDate(start.toISOString())}`,
    `DTEND:${toICSDate(end.toISOString())}`,
    `SUMMARY:${escapeICSText(m.title)}`,
    locationValue ? `LOCATION:${escapeICSText(locationValue)}` : '',
    description ? `DESCRIPTION:${description}` : '',
    m.zoom_link ? `URL:${m.zoom_link}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n')
}

export function downloadMeetingICS(m: ICSMeeting): void {
  const ics = buildMeetingICS(m)
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${m.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.ics`
  a.click()
  URL.revokeObjectURL(url)
}
