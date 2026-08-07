import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildMeetingICS, meetingUID } from '@/lib/ics'
import {
  buildMeetingCalendarPayload,
  sendMeetingCalendarInvites,
  deliverPendingInvites,
  isValidEmail,
  ANDREL_ORGANIZER,
  type CalendarMeetingInput,
} from '@/lib/meetings/calendarInvite'

const meeting = (over: Partial<CalendarMeetingInput> = {}): CalendarMeetingInput => ({
  id: 'M1',
  purpose: 'Coffee chat',
  scheduled_at: '2026-08-12T15:00:00Z',
  duration_minutes: 30,
  location: null,
  zoom_link: 'https://zoom.us/j/123',
  notes: 'Looking forward',
  scheduled_timezone: 'America/New_York',
  requester: { email: 'a@b.co', full_name: 'Ada' },
  recipient: { email: 'c@d.co', full_name: 'Cid' },
  ...over,
})

// In-memory fake of meeting_calendar_invites (models INSERT-first idempotency, updates, and
// the durable-retry read: .select().eq().in(status,[...]) returning an array).
function fakeAdmin() {
  const rows = new Map<string, any>()
  const key = (r: any) => `${r.meeting_id}|${r.method}|${r.sequence}|${r.recipient_email}`
  const from = () => {
    let op: 'insert' | 'select' | 'update' = 'select'
    let updatePayload: any = null
    const eqs: [string, any][] = []
    const ins: [string, any[]][] = []
    const filt = (r: any) => eqs.every(([c, v]) => r[c] === v) && ins.every(([c, arr]) => arr.includes(r[c]))
    const matchAll = () => Array.from(rows.values()).filter(filt)
    const match = () => matchAll()[0]
    const b: any = {
      insert(row: any) {
        const k = key(row)
        const exists = rows.has(k)
        if (!exists) rows.set(k, { ...row })
        return Promise.resolve({ error: exists ? { code: '23505' } : null })
      },
      select() { op = 'select'; return b },
      update(p: any) { op = 'update'; updatePayload = p; return b },
      eq(c: string, v: any) { eqs.push([c, v]); return b },
      in(c: string, arr: any[]) { ins.push([c, arr]); return b },
      maybeSingle() { return Promise.resolve({ data: match() ?? null, error: null }) },
      then(res: any, rej: any) {
        if (op === 'update') { const m = match(); if (m) Object.assign(m, updatePayload) }
        const data = op === 'select' ? matchAll() : null
        return Promise.resolve({ data, error: null }).then(res, rej)
      },
    }
    return b
  }
  return { from, _rows: rows }
}

describe('buildMeetingICS — RFC 5545 fields', () => {
  it('REQUEST carries stable UID, SEQUENCE, STATUS:CONFIRMED, organizer + both attendees', () => {
    const raw = buildMeetingICS(
      { id: 'M1', title: 'Coffee chat', scheduled_at: '2026-08-12T15:00:00Z', duration_minutes: 30, zoom_link: 'https://zoom.us/j/123', url: 'https://andrel.app/dashboard/meetings' },
      { method: 'REQUEST', sequence: 0, status: 'CONFIRMED', organizer: ANDREL_ORGANIZER, attendees: [{ email: 'a@b.co', name: 'Ada' }, { email: 'c@d.co', name: 'Cid' }] },
    )
    const ics = raw.replace(/\r\n /g, '') // un-fold RFC 5545 continuation lines for assertions
    expect(ics).toContain('METHOD:REQUEST')
    expect(ics).toContain(`UID:${meetingUID('M1')}`)
    expect(ics).toContain('UID:andrel-meeting-M1@andrel.app')
    expect(ics).toContain('SEQUENCE:0')
    expect(ics).toContain('STATUS:CONFIRMED')
    expect(ics).toContain('ORGANIZER;CN=Andrel:mailto:hello@andrel.app')
    expect(ics).toContain('mailto:a@b.co')
    expect(ics).toContain('mailto:c@d.co')
    expect(ics).toContain('DTSTART:20260812T150000Z')
    expect(ics).toContain('DTEND:20260812T153000Z')
    expect(ics).toContain('SUMMARY:Coffee chat')
  })

  it('CANCEL carries the SAME UID, an incremented SEQUENCE, and STATUS:CANCELLED', () => {
    const ics = buildMeetingICS({ id: 'M1', title: 'Coffee chat', scheduled_at: '2026-08-12T15:00:00Z', duration_minutes: 30 }, { method: 'CANCEL', sequence: 1 })
    expect(ics).toContain('METHOD:CANCEL')
    expect(ics).toContain('UID:andrel-meeting-M1@andrel.app') // same identity
    expect(ics).toContain('SEQUENCE:1')
    expect(ics).toContain('STATUS:CANCELLED')
  })

  it('never contains tokens / internal / service-role data', () => {
    const ics = buildMeetingICS({ id: 'M1', title: 'Chat', scheduled_at: '2026-08-12T15:00:00Z', duration_minutes: 30, notes: 'notes' }, { method: 'REQUEST' })
    expect(ics).not.toMatch(/token|password|service_role|SUPABASE|Bearer|secret/i)
  })
})

describe('buildMeetingCalendarPayload', () => {
  it('includes both valid attendees, excludes an invalid email, de-dupes recipients', () => {
    const p = buildMeetingCalendarPayload(meeting(), 'REQUEST', 0)
    expect(p.recipients.map((r) => r.email)).toEqual(['a@b.co', 'c@d.co'])
    expect(p.uid).toBe('andrel-meeting-M1@andrel.app')

    const invalid = buildMeetingCalendarPayload(meeting({ recipient: { email: 'not-an-email', full_name: 'X' } }), 'REQUEST', 0)
    expect(invalid.recipients.map((r) => r.email)).toEqual(['a@b.co']) // invalid dropped
    expect(invalid.ics).not.toContain('not-an-email')
  })
  it('isValidEmail', () => {
    expect(isValidEmail('a@b.co')).toBe(true)
    expect(isValidEmail('nope')).toBe(false)
    expect(isValidEmail('')).toBe(false)
    expect(isValidEmail(null)).toBe(false)
  })
})

describe('sendMeetingCalendarInvites — idempotency + delivery (mocked email, NO real send)', () => {
  it('confirming sends to BOTH participants once; a repeat send is de-duplicated', async () => {
    const admin = fakeAdmin()
    const sent: string[] = []
    const send = async (a: any) => { sent.push(a.to) }

    const r1 = await sendMeetingCalendarInvites(admin as any, meeting(), 'REQUEST', 0, send)
    expect(r1.sent.sort()).toEqual(['a@b.co', 'c@d.co'])
    expect(sent.sort()).toEqual(['a@b.co', 'c@d.co'])

    const r2 = await sendMeetingCalendarInvites(admin as any, meeting(), 'REQUEST', 0, send) // retry / double-click
    expect(r2.skipped.sort()).toEqual(['a@b.co', 'c@d.co'])
    expect(sent.sort()).toEqual(['a@b.co', 'c@d.co']) // no additional sends
  })

  it('a failed delivery stays retryable; a successful one is never retried', async () => {
    const admin = fakeAdmin()
    let failFor: string | null = 'c@d.co'
    const attempts: string[] = []
    const send = async (a: any) => { attempts.push(a.to); if (a.to === failFor) throw new Error('provider down') }

    const r1 = await sendMeetingCalendarInvites(admin as any, meeting(), 'REQUEST', 0, send)
    expect(r1.sent).toEqual(['a@b.co'])
    expect(r1.failed).toEqual(['c@d.co'])

    failFor = null // provider recovers
    const r2 = await sendMeetingCalendarInvites(admin as any, meeting(), 'REQUEST', 0, send)
    expect(r2.sent).toEqual(['c@d.co'])   // failed one retried
    expect(r2.skipped).toEqual(['a@b.co']) // successful one NOT retried
  })

  it('one invalid recipient does not prevent delivery to the valid participant', async () => {
    const admin = fakeAdmin()
    const sent: string[] = []
    const r = await sendMeetingCalendarInvites(admin as any, meeting({ recipient: { email: 'bad', full_name: 'X' } }), 'REQUEST', 0, async (a: any) => { sent.push(a.to) })
    expect(r.sent).toEqual(['a@b.co'])
    expect(sent).toEqual(['a@b.co'])
  })

  it('reschedule uses the same UID with an incremented sequence (own dedupe key)', async () => {
    const admin = fakeAdmin()
    const send = async () => {}
    await sendMeetingCalendarInvites(admin as any, meeting(), 'REQUEST', 0, send)
    const r = await sendMeetingCalendarInvites(admin as any, meeting({ scheduled_at: '2026-08-13T16:00:00Z' }), 'REQUEST', 1, send)
    expect(r.sent.sort()).toEqual(['a@b.co', 'c@d.co']) // seq 1 is a distinct claim → sends again
  })

  it('each send carries a Resend idempotency key derived from the durable DB identity', async () => {
    const admin = fakeAdmin()
    const keys: Record<string, string | undefined> = {}
    await sendMeetingCalendarInvites(admin as any, meeting(), 'REQUEST', 0, async (a: any) => { keys[a.to] = a.idempotencyKey })
    // uid:method:sequence:recipient — NOT random, so a provider retry is de-duplicated.
    expect(keys['a@b.co']).toBe('andrel-meeting-M1@andrel.app:REQUEST:0:a@b.co')
    expect(keys['c@d.co']).toBe('andrel-meeting-M1@andrel.app:REQUEST:0:c@d.co')
  })
})

describe('cancellation durability — survives a hard-deleted meeting (mocked email)', () => {
  it('a failed cancellation is queued with a self-contained payload and retries after deletion', async () => {
    const admin = fakeAdmin()

    // 1) Confirm-time cancel is CLAIMED (durably recorded) then the provider is down for BOTH.
    //    This all happens BEFORE the meeting row is hard-deleted in deleteMeeting().
    const down = async () => { throw new Error('provider down') }
    const r1 = await sendMeetingCalendarInvites(admin as any, meeting(), 'CANCEL', 1, down)
    expect(r1.failed.sort()).toEqual(['a@b.co', 'c@d.co'])

    // 2) The meeting row is now GONE. Every queued row must be self-contained: the retry
    //    reads ONLY meeting_calendar_invites, never the meeting.
    const stored = Array.from(admin._rows.values())
    expect(stored.length).toBe(2)
    for (const row of stored) {
      expect(row.status).toBe('failed')
      expect(row.payload.method).toBe('CANCEL')
      expect(row.payload.ics).toContain('METHOD:CANCEL')
      expect(row.payload.ics).toContain('UID:andrel-meeting-M1@andrel.app') // same stable UID
      expect(row.payload.idempotencyKey).toContain(':CANCEL:1:')             // incremented sequence
    }

    // 3) Provider recovers — drain the queue with NO meeting object in hand.
    const delivered: string[] = []
    const r2 = await deliverPendingInvites(admin as any, 'M1', async (a: any) => { delivered.push(a.to) })
    expect(r2.sent.sort()).toEqual(['a@b.co', 'c@d.co'])
    expect(delivered.sort()).toEqual(['a@b.co', 'c@d.co'])

    // 4) Re-draining is a no-op (rows are 'sent') — repeated requests never double-cancel.
    const r3 = await deliverPendingInvites(admin as any, 'M1', async (a: any) => { delivered.push(a.to) })
    expect(r3.sent).toEqual([])
    expect(delivered.sort()).toEqual(['a@b.co', 'c@d.co'])
  })
})

describe('calendar-invite email semantics (structural)', () => {
  const email = readFileSync('lib/email.ts', 'utf8')
  const fn = email.slice(
    email.indexOf('export async function sendCalendarInviteEmail'),
    email.indexOf('export async function sendDigestEmail'),
  )
  it('is NOT gated by email_meeting_updates — a calendar invite is a transactional artifact', () => {
    expect(fn).not.toContain("isPrefEnabled(args.to, 'email_meeting_updates')")
    expect(fn).not.toMatch(/isPrefEnabled\([^)]*\)\)\s*return/) // no opt-out early-return at all
  })
  it('uses a proper text/calendar MIME part (method + .ics filename) and forwards the idempotency key', () => {
    expect(fn).toMatch(/text\/calendar; charset=utf-8; method=\$\{args\.method\}/)
    expect(fn).toMatch(/filename: cancelled \? 'cancel\.ics' : 'invite\.ics'/)
    expect(fn).toContain('idempotencyKey')
  })
})

describe('lifecycle wiring (structural)', () => {
  const actions = readFileSync('app/actions.ts', 'utf8')
  const ics = readFileSync('lib/ics.ts', 'utf8')

  it('confirmation (acceptMeeting) sends a REQUEST invite from the server', () => {
    const accept = actions.slice(actions.indexOf('export async function acceptMeeting'), actions.indexOf('export async function declineMeeting'))
    expect(accept).toContain("sendMeetingCalendarInvites(")
    expect(accept).toContain("'REQUEST'")
  })
  it('cancellation (deleteMeeting) sends a CANCEL before deleting', () => {
    const del = actions.slice(actions.indexOf('export async function deleteMeeting'))
    expect(del).toContain("'CANCEL'")
    expect(del).toContain('sendMeetingCalendarInvites(')
  })
  it('proposal creation (scheduleMeeting) sends NO calendar invite', () => {
    const create = actions.slice(actions.indexOf('export async function scheduleMeeting'), actions.indexOf('export async function acceptMeeting'))
    expect(create).not.toContain('sendMeetingCalendarInvites')
  })
  it('the download button uses the SAME shared builder as the email', () => {
    expect(ics).toContain('export function downloadMeetingICS')
    const dl = ics.slice(ics.indexOf('export function downloadMeetingICS'))
    expect(dl).toContain('buildMeetingICS(m)') // shared generator, cannot diverge
  })
})
