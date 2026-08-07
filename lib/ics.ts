// Shared ICS (RFC 5545) generation for Andrel meetings.
//
// SINGLE source of truth for both the browser "Add to calendar" download AND the
// emailed calendar invitation, so the two can never diverge. The pure builder runs in
// any environment (no Blob/document); only downloadMeetingICS touches the browser.
//
// The same STABLE UID is used for a meeting's entire lifecycle (initial REQUEST →
// reschedule REQUEST → CANCEL), so calendar clients update/cancel the one logical event
// rather than creating duplicates. Do NOT put internal notes, tokens, or sensitive URLs
// in the event — only participant-facing meeting details.

export interface ICSMeeting {
  id: string
  title: string
  scheduled_at: string
  duration_minutes: number
  meeting_type?: string
  location?: string | null
  zoom_link?: string | null
  notes?: string | null
  /** Public Andrel URL for the meeting (optional). */
  url?: string | null
}

export type ICSMethod = 'PUBLISH' | 'REQUEST' | 'CANCEL'
export type ICSStatus = 'CONFIRMED' | 'CANCELLED' | 'TENTATIVE'

export interface ICSParticipant {
  email: string
  name?: string | null
}

export interface ICSOptions {
  method?: ICSMethod
  sequence?: number
  status?: ICSStatus
  organizer?: ICSParticipant
  attendees?: ICSParticipant[]
}

/** Stable, lifecycle-wide event identity for an Andrel meeting. */
export function meetingUID(meetingId: string): string {
  return `andrel-meeting-${meetingId}@andrel.app`
}

// RFC 5545 §3.3.11 TEXT escaping (backslash first, then ; , and newlines).
export function escapeICSText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

// Escape only \n / \ / , for parameter values (CN=...), and drop characters that would
// break the param syntax.
function escapeParam(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/"/g, '').replace(/[;:,]/g, ' ').trim()
}

// UTC basic format, e.g. 20260712T143000Z.
function toICSDate(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

// RFC 5545 §3.1 line folding: no content line may exceed 75 octets; continuations
// begin with a single space. Keeps ORGANIZER/ATTENDEE lines standards-compliant.
function foldLine(line: string): string {
  if (line.length <= 75) return line
  const parts: string[] = []
  let rest = line
  parts.push(rest.slice(0, 75))
  rest = rest.slice(75)
  while (rest.length > 74) {
    parts.push(' ' + rest.slice(0, 74))
    rest = rest.slice(74)
  }
  if (rest.length) parts.push(' ' + rest)
  return parts.join('\r\n')
}

function participantLine(kind: 'ORGANIZER' | 'ATTENDEE', p: ICSParticipant): string {
  const cn = p.name ? `;CN=${escapeParam(p.name)}` : ''
  const extra = kind === 'ATTENDEE' ? ';ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE' : ''
  return `${kind}${cn}${extra}:mailto:${p.email}`
}

/**
 * Build an RFC 5545 VCALENDAR string for a meeting. `opts.method` defaults to PUBLISH
 * (the plain download); pass REQUEST for an invite/update and CANCEL to cancel — both
 * with the SAME stable UID and a monotonically increasing SEQUENCE.
 */
export function buildMeetingICS(m: ICSMeeting, opts: ICSOptions = {}): string {
  const method: ICSMethod = opts.method ?? 'PUBLISH'
  const sequence = opts.sequence ?? 0
  const status: ICSStatus = opts.status ?? (method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED')

  const start = new Date(m.scheduled_at)
  const end = new Date(start.getTime() + m.duration_minutes * 60000)
  const now = new Date()

  const description = [
    m.notes || '',
    m.zoom_link ? `Meeting link: ${m.zoom_link}` : '',
  ].filter(Boolean).map(escapeICSText).join('\\n')

  const physicalLocation = (m.location || '').trim()
  const locationValue = physicalLocation || (m.zoom_link || '').trim()

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Andrel//Andrel Meetings//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${meetingUID(m.id)}`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${toICSDate(now.toISOString())}`,
    `DTSTART:${toICSDate(start.toISOString())}`,
    `DTEND:${toICSDate(end.toISOString())}`,
    `SUMMARY:${escapeICSText(m.title)}`,
    `STATUS:${status}`,
    opts.organizer ? participantLine('ORGANIZER', opts.organizer) : '',
    ...(opts.attendees ?? []).map((a) => participantLine('ATTENDEE', a)),
    locationValue ? `LOCATION:${escapeICSText(locationValue)}` : '',
    description ? `DESCRIPTION:${description}` : '',
    (m.url || m.zoom_link) ? `URL:${m.url || m.zoom_link}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean) as string[]

  return lines.map(foldLine).join('\r\n')
}

export function downloadMeetingICS(m: ICSMeeting): void {
  const ics = buildMeetingICS(m) // PUBLISH — a plain personal add-to-calendar
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${m.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.ics`
  a.click()
  URL.revokeObjectURL(url)
}
