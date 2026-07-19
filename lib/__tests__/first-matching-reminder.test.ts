import { describe, it, expect, beforeEach, vi } from 'vitest'

// Capture the Resend payload without sending anything.
const state = vi.hoisted(() => ({ captured: null as any, result: { data: { id: 'msg_1' }, error: null } as any }))
vi.mock('resend', () => ({
  Resend: class { emails = { send: async (payload: any) => { state.captured = payload; return state.result } } },
}))
// lib/email imports createAdminClient (used lazily elsewhere); stub so importing is side-effect free.
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))

import { sendFirstMatchingRoundReminderEmail, FIRST_MATCHING_REMINDER_CTA_URL } from '@/lib/email'
import {
  firstNameOrThere,
  isValidEmail,
  selectReminderCohort,
  CAMPAIGN_ID,
  type ReminderWaitlistRow,
} from '@/lib/firstMatchingReminder/eligibility'

const CTA = 'https://www.andrel.app/login'

const row = (o: Partial<ReminderWaitlistRow>): ReminderWaitlistRow => ({
  id: o.id ?? 'r1', email: o.email ?? 'a@x.com', full_name: o.full_name ?? 'Ann Smith',
  status: o.status ?? 'invited', first_matching_reminder_sent_at: o.first_matching_reminder_sent_at ?? null,
})

beforeEach(() => { state.captured = null; state.result = { data: { id: 'msg_1' }, error: null } })

describe('campaign constants', () => {
  it('stable campaign id + canonical CTA to production login', () => {
    expect(CAMPAIGN_ID).toBe('first-matching-round-reminder-2026-07-21')
    expect(FIRST_MATCHING_REMINDER_CTA_URL).toBe(CTA)
  })
})

describe('firstNameOrThere — safe personalization', () => {
  it('uses the first token of a real name', () => {
    expect(firstNameOrThere('Jane Doe')).toBe('Jane')
    expect(firstNameOrThere('Emilia')).toBe('Emilia')
    expect(firstNameOrThere('  Jörg   Müller ')).toBe('Jörg')
  })
  it('falls back to "there" for blank/malformed/missing names', () => {
    for (const v of ['', '   ', null, undefined]) expect(firstNameOrThere(v)).toBe('there')
  })
})

describe('isValidEmail', () => {
  it('accepts normal emails, rejects blanks/malformed', () => {
    expect(isValidEmail('a@b.com')).toBe(true)
    for (const v of ['', 'nope', 'a@b', 'a b@x.com', '@x.com', 'a@.com']) expect(isValidEmail(v)).toBe(false)
  })
})

describe('selectReminderCohort — same canonical cohort as Waitlist → Invited', () => {
  it('includes only invited, not-completed, valid, not-already-sent', () => {
    const rows = [row({ id: 'keep', email: 'keep@x.com', full_name: 'Kay Lee' })]
    const { recipients, stats } = selectReminderCohort(rows, new Set())
    expect(recipients).toEqual([{ id: 'keep', email: 'keep@x.com', firstName: 'Kay' }])
    expect(stats.finalCount).toBe(1)
  })

  it('EXCLUDES people who completed onboarding (matched by normalized email)', () => {
    const rows = [row({ id: 'done', email: '  Joined@X.COM ' })]
    const { recipients, stats } = selectReminderCohort(rows, new Set(['joined@x.com']))
    expect(recipients).toHaveLength(0)
    expect(stats.excludedCompleted).toBe(1)
  })

  it('EXCLUDES already-sent recipients (idempotency — no re-send on retry)', () => {
    const rows = [row({ id: 'sent', first_matching_reminder_sent_at: '2026-07-19T00:00:00Z' })]
    const { recipients, stats } = selectReminderCohort(rows, new Set())
    expect(recipients).toHaveLength(0)
    expect(stats.excludedAlreadySent).toBe(1)
  })

  it('EXCLUDES invalid/blank emails', () => {
    const rows = [row({ id: 'bad', email: 'not-an-email' }), row({ id: 'blank', email: '   ' })]
    const { recipients, stats } = selectReminderCohort(rows, new Set())
    expect(recipients).toHaveLength(0)
    expect(stats.excludedInvalidEmail).toBe(2)
  })

  it('DEDUPLICATES by normalized email (one send per address)', () => {
    const rows = [
      row({ id: 'a', email: 'Dup@X.com' }),
      row({ id: 'b', email: ' dup@x.com ' }),
      row({ id: 'c', email: 'unique@x.com' }),
    ]
    const { recipients, stats } = selectReminderCohort(rows, new Set())
    expect(recipients.map(r => r.email).sort()).toEqual(['dup@x.com', 'unique@x.com'])
    expect(stats.removedDuplicates).toBe(1)
    expect(stats.finalCount).toBe(2)
  })

  it('produces a complete exclusion breakdown', () => {
    const rows = [
      row({ id: '1', email: 'a@x.com', full_name: 'Al' }),          // keep
      row({ id: '2', email: 'done@x.com' }),                        // completed
      row({ id: '3', email: 'bad' }),                               // invalid
      row({ id: '4', email: 'a@x.com' }),                           // dup of #1
      row({ id: '5', first_matching_reminder_sent_at: 'x' }),       // already sent
    ]
    const { stats } = selectReminderCohort(rows, new Set(['done@x.com']))
    expect(stats).toEqual({
      rawInvited: 5, excludedCompleted: 1, excludedInvalidEmail: 1,
      excludedAlreadySent: 1, removedDuplicates: 1, finalCount: 1,
    })
  })
})

describe('email template — CTA, personalization, plain-text fallback, safety', () => {
  it('sends with the correct subject, CTA button + URL, preview text, and plain-text fallback', async () => {
    const res = await sendFirstMatchingRoundReminderEmail('someone@example.com', 'Jane')
    expect(res).toEqual({ success: true })
    const p = state.captured
    expect(p.from).toBe('Andrel <hello@andrel.app>')
    expect(p.subject).toBe('Your first introductions go out Tuesday')
    // Preview / preheader text
    expect(p.html).toContain('Complete your Andrel profile to be considered for the first round of matching.')
    // Branded button with exact visible text + canonical production URL
    expect(p.html).toContain('Complete Your Profile →')
    expect(p.html).toContain(`href="${CTA}"`)
    // Plain-text fallback URL is present in BOTH html and the text part
    expect(p.html).toMatch(/copy and paste this link[\s\S]*www\.andrel\.app\/login/)
    expect(p.text).toContain(CTA)
    // Personalized greeting
    expect(p.html).toContain('Hi Jane,')
    expect(p.text.startsWith('Hi Jane,')).toBe(true)
    // Inline CSS, no JavaScript dependency
    expect(p.html).toContain('style=')
    expect(p.html).not.toMatch(/<script/i)
  })

  it('falls back to "Hi there," when the name is blank', async () => {
    await sendFirstMatchingRoundReminderEmail('someone@example.com', '')
    expect(state.captured.html).toContain('Hi there,')
    expect(state.captured.text.startsWith('Hi there,')).toBe(true)
  })

  it('does NOT claim a guaranteed introduction or use "hand-curated"', async () => {
    await sendFirstMatchingRoundReminderEmail('someone@example.com', 'Jane')
    const all = state.captured.html + state.captured.text
    expect(all.toLowerCase()).not.toContain('hand-curated')
    expect(all.toLowerCase()).not.toMatch(/guarantee/)
  })

  it('surfaces a provider error as a failure result (no throw, no false success)', async () => {
    state.result = { data: null, error: { message: 'rate limited' } }
    const res = await sendFirstMatchingRoundReminderEmail('someone@example.com', 'Jane')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/rate limited/)
  })
})
