import { buildMeetingICS, meetingUID, type ICSMethod } from '@/lib/ics'

/**
 * Server-side calendar-invitation orchestration for confirmed Andrel meetings.
 *
 * Idempotency: a durable meeting_calendar_invites row (UNIQUE meeting_id, method,
 * sequence, recipient_email) is claimed INSERT-first before each send, so a double-click,
 * server retry, or replay never double-sends. A 'sent' row is never re-sent; a 'failed'
 * row (or a stale in-flight 'claimed') stays retryable. The event uses the meeting's
 * STABLE UID for its whole lifecycle and a monotonic SEQUENCE. One stable Andrel
 * organizer is used for both attendees, so there are never two competing invitations.
 */

export const ANDREL_ORGANIZER = { email: 'hello@andrel.app', name: 'Andrel' }
export const ANDREL_MEETINGS_URL = 'https://andrel.app/dashboard/meetings'

export function isValidEmail(email: string | null | undefined): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((email ?? '').trim())
}

export interface CalendarParticipant {
  email?: string | null
  full_name?: string | null
}

export interface CalendarMeetingInput {
  id: string
  purpose?: string | null
  scheduled_at: string
  duration_minutes?: number | null
  location?: string | null
  zoom_link?: string | null
  notes?: string | null
  scheduled_timezone?: string | null
  requester: CalendarParticipant
  recipient: CalendarParticipant
}

export interface CalendarInvitePayload {
  ics: string
  uid: string
  method: ICSMethod
  sequence: number
  /** de-duplicated, valid recipient emails (lowercased) with their display names. */
  recipients: Array<{ email: string; name: string }>
}

/** PURE: build the ICS + attendee list for a meeting invite/cancel (no I/O). */
export function buildMeetingCalendarPayload(
  m: CalendarMeetingInput,
  method: 'REQUEST' | 'CANCEL',
  sequence: number,
): CalendarInvitePayload {
  const valid = [m.requester, m.recipient].filter((p) => isValidEmail(p?.email))
  const attendees = valid.map((p) => ({ email: (p.email as string).trim(), name: p.full_name || undefined }))
  const ics = buildMeetingICS(
    {
      id: m.id,
      title: (m.purpose || '').trim() || 'Andrel meeting',
      scheduled_at: m.scheduled_at,
      duration_minutes: m.duration_minutes || 30,
      location: m.location,
      zoom_link: m.zoom_link,
      notes: m.notes,
      url: ANDREL_MEETINGS_URL,
    },
    {
      method,
      sequence,
      status: method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED',
      organizer: ANDREL_ORGANIZER,
      attendees,
    },
  )
  // De-duplicate recipients by lowercased email (both participants could share one).
  const seen = new Set<string>()
  const recipients: Array<{ email: string; name: string }> = []
  for (const p of valid) {
    const email = (p.email as string).trim().toLowerCase()
    if (seen.has(email)) continue
    seen.add(email)
    recipients.push({ email, name: p.full_name || 'there' })
  }
  return { ics, uid: meetingUID(m.id), method, sequence, recipients }
}

export interface CalendarEmailArgs {
  to: string
  toName: string
  summary: string
  method: 'REQUEST' | 'CANCEL'
  scheduledAt: string
  scheduledTimezone?: string | null
  ics: string
  /** Aligned to the durable invite identity so a provider retry is de-duplicated. */
  idempotencyKey?: string
}

export type CalendarEmailSender = (args: CalendarEmailArgs) => Promise<void>

const STALE_CLAIM_MS = 10 * 60 * 1000

/** The Resend/provider idempotency key — derived from the durable DB identity, NOT random. */
function inviteIdempotencyKey(uid: string, method: string, sequence: number, email: string): string {
  return `${uid}:${method}:${sequence}:${email}`
}

/**
 * Atomic-ish idempotency claim. Returns 'claim' if this caller should send, else 'skip'.
 * On claim, the fully-rendered `payload` (email + ICS args) is persisted so a failed send
 * can be retried later WITHOUT the meeting row — see deliverPendingInvites().
 */
async function claimInvite(admin: any, meetingId: string, method: string, sequence: number, email: string, payload: CalendarEmailArgs): Promise<'claim' | 'skip'> {
  const key = { meeting_id: meetingId, method, sequence, recipient_email: email }
  let { error } = await admin.from('meeting_calendar_invites').insert({ ...key, status: 'claimed', payload, updated_at: new Date().toISOString() })
  // Fail-open if migration 047 (payload column) lags 045: retry the claim without payload so
  // the initial send still works (durable retry is simply unavailable until 047 is applied).
  if ((error as any)?.code === '42703') {
    ;({ error } = await admin.from('meeting_calendar_invites').insert({ ...key, status: 'claimed', updated_at: new Date().toISOString() }))
  }
  if (!error) return 'claim'
  if ((error as any)?.code !== '23505') { console.error('[calendar-invite] claim failed (non-conflict)'); return 'skip' }
  const { data: existing } = await admin
    .from('meeting_calendar_invites')
    .select('status, updated_at')
    .eq('meeting_id', meetingId).eq('method', method).eq('sequence', sequence).eq('recipient_email', email)
    .maybeSingle()
  if (!existing || existing.status === 'sent') return 'skip'
  const stale = existing.status === 'claimed' && Date.now() - new Date(existing.updated_at).getTime() > STALE_CLAIM_MS
  if (existing.status === 'failed' || stale) {
    await admin.from('meeting_calendar_invites').update({ status: 'claimed', payload, updated_at: new Date().toISOString() })
      .eq('meeting_id', meetingId).eq('method', method).eq('sequence', sequence).eq('recipient_email', email)
    return 'claim'
  }
  return 'skip'
}

async function markInvite(admin: any, meetingId: string, method: string, sequence: number, email: string, status: 'sent' | 'failed', error?: string) {
  await admin.from('meeting_calendar_invites').update({ status, error: error ?? null, updated_at: new Date().toISOString() })
    .eq('meeting_id', meetingId).eq('method', method).eq('sequence', sequence).eq('recipient_email', email)
}

/**
 * Send (idempotently) a calendar invitation/cancellation to both participants. NEVER
 * throws — a provider failure records a retryable 'failed' row and is reported, but the
 * (already-committed) confirmed meeting is untouched. `sendEmail` is injectable so tests
 * use a mock and send no real email.
 */
export async function sendMeetingCalendarInvites(
  admin: any,
  m: CalendarMeetingInput,
  method: 'REQUEST' | 'CANCEL',
  sequence: number,
  sendEmail: CalendarEmailSender,
): Promise<{ sent: string[]; skipped: string[]; failed: string[] }> {
  const result = { sent: [] as string[], skipped: [] as string[], failed: [] as string[] }
  const payload = buildMeetingCalendarPayload(m, method, sequence)
  const summary = (m.purpose || '').trim() || 'Andrel meeting'
  for (const r of payload.recipients) {
    const emailArgs: CalendarEmailArgs = {
      to: r.email,
      toName: r.name,
      summary,
      method,
      scheduledAt: m.scheduled_at,
      scheduledTimezone: m.scheduled_timezone ?? null,
      ics: payload.ics,
      idempotencyKey: inviteIdempotencyKey(payload.uid, method, sequence, r.email),
    }
    let claim: 'claim' | 'skip' = 'skip'
    try { claim = await claimInvite(admin, m.id, method, sequence, r.email, emailArgs) } catch { claim = 'skip' }
    if (claim === 'skip') { result.skipped.push(r.email); continue }
    try {
      await sendEmail(emailArgs)
      await markInvite(admin, m.id, method, sequence, r.email, 'sent')
      result.sent.push(r.email)
    } catch (e: any) {
      await markInvite(admin, m.id, method, sequence, r.email, 'failed', e?.message)
      result.failed.push(r.email)
    }
  }
  return result
}

/**
 * Durable retry for a meeting's not-yet-delivered invites (status 'claimed' or 'failed').
 * Reads ONLY meeting_calendar_invites and re-sends from the persisted `payload`, so it works
 * even after the meeting row was hard-deleted (the cancellation case). A 'sent' row is never
 * re-sent. NEVER throws. Use this to drain a transient provider outage — e.g. from a small
 * cron/retry sweep — without re-querying (the possibly gone) meeting.
 */
export async function deliverPendingInvites(
  admin: any,
  meetingId: string,
  sendEmail: CalendarEmailSender,
): Promise<{ sent: string[]; failed: string[]; skipped: string[] }> {
  const result = { sent: [] as string[], failed: [] as string[], skipped: [] as string[] }
  const { data: rows } = await admin
    .from('meeting_calendar_invites')
    .select('meeting_id, method, sequence, recipient_email, status, payload')
    .eq('meeting_id', meetingId)
    .in('status', ['claimed', 'failed'])
  for (const row of (rows as any[]) || []) {
    if (!row.payload) { result.skipped.push(row.recipient_email); continue }
    try {
      await sendEmail(row.payload as CalendarEmailArgs)
      await markInvite(admin, row.meeting_id, row.method, row.sequence, row.recipient_email, 'sent')
      result.sent.push(row.recipient_email)
    } catch (e: any) {
      await markInvite(admin, row.meeting_id, row.method, row.sequence, row.recipient_email, 'failed', e?.message)
      result.failed.push(row.recipient_email)
    }
  }
  return result
}
