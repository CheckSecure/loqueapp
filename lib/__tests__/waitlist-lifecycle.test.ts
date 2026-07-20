import { describe, it, expect } from 'vitest'
import {
  computeLifecycle,
  isNewlyInvitedNoFollowup,
  lifecycleLabel,
  REMINDER_SCHEDULE,
  type LifecycleInput,
} from '@/lib/waitlist/lifecycle'

const NOW = new Date('2026-07-19T12:00:00Z').getTime()
const hoursAgo = (h: number) => new Date(NOW - h * 3600 * 1000).toISOString()
const base = (o: Partial<LifecycleInput> = {}): LifecycleInput => ({
  status: 'invited', email: 'a@x.com', invited_at: hoursAgo(2),
  invite_reminder_1_sent_at: null, invite_reminder_2_sent_at: null,
  first_matching_reminder_sent_at: null, profileComplete: false, ...o,
})
const lc = (o?: Partial<LifecycleInput>) => computeLifecycle(base(o), NOW)

describe('lifecycle state machine', () => {
  it('1. newly invited, no reminders, before reminder 1 due → invite_sent (cannot send)', () => {
    const r = lc({ invited_at: hoursAgo(2) })
    expect(r.state).toBe('invite_sent')
    expect(r.canSendActivationEmail).toBe(false)
    expect(r.nextEmail).toBe('reminder_1')
    expect(r.lastEmail).toBe('invite')
  })

  it('2. reminder 1 not yet due (just under 24h) → invite_sent', () => {
    expect(lc({ invited_at: hoursAgo(23) }).state).toBe('invite_sent')
  })

  it('3. reminder 1 due (>= 24h, unsent) → reminder_1_due (can send)', () => {
    const r = lc({ invited_at: hoursAgo(30) })
    expect(r.state).toBe('reminder_1_due')
    expect(r.canSendActivationEmail).toBe(true)
    expect(r.nextEmail).toBe('reminder_1')
  })

  it('4. reminder 1 already sent, reminder 2 not due → reminder_1_sent', () => {
    const r = lc({ invited_at: hoursAgo(30), invite_reminder_1_sent_at: hoursAgo(5) })
    expect(r.state).toBe('reminder_1_sent')
    expect(r.canSendActivationEmail).toBe(false)
    expect(r.lastEmail).toBe('reminder_1')
    expect(r.nextEmail).toBe('reminder_2')
  })

  it('5. reminder 2 not due (< 7d since invite) → reminder_1_sent', () => {
    expect(lc({ invited_at: hoursAgo(100), invite_reminder_1_sent_at: hoursAgo(70) }).state).toBe('reminder_1_sent')
  })

  it('6. reminder 2 due ONLY after reminder 1', () => {
    // r1 sent + past 7d → reminder_2_due
    const due = lc({ invited_at: hoursAgo(200), invite_reminder_1_sent_at: hoursAgo(150) })
    expect(due.state).toBe('reminder_2_due')
    expect(due.canSendActivationEmail).toBe(true)
    // past 7d but r1 NEVER sent → stays on reminder_1 track (never jumps to r2)
    const noR1 = lc({ invited_at: hoursAgo(200), invite_reminder_1_sent_at: null })
    expect(noR1.state).toBe('reminder_1_due')
    expect(noR1.nextEmail).toBe('reminder_1')
  })

  it('7. reminder 2 already sent → reminder_2_sent (sequence complete, cannot send)', () => {
    const r = lc({ invited_at: hoursAgo(300), invite_reminder_1_sent_at: hoursAgo(250), invite_reminder_2_sent_at: hoursAgo(100) })
    expect(r.state).toBe('reminder_2_sent')
    expect(r.canSendActivationEmail).toBe(false)
    expect(r.nextEmail).toBeNull()
  })

  it('8. completed profile is excluded from every reminder regardless of timestamps', () => {
    for (const extra of [
      {}, { invited_at: hoursAgo(300) },
      { invite_reminder_1_sent_at: hoursAgo(5) },
      { invited_at: hoursAgo(300), invite_reminder_1_sent_at: hoursAgo(250) },
    ]) {
      const r = lc({ ...extra, profileComplete: true })
      expect(r.state).toBe('completed')
      expect(r.canSendActivationEmail).toBe(false)
      expect(r.excludedReason).toBe('completed')
    }
  })

  it('9. July first-matching does NOT count as reminder 1 or 2', () => {
    const r = lc({ invited_at: hoursAgo(2), first_matching_reminder_sent_at: hoursAgo(1) })
    expect(r.state).toBe('invite_sent')       // unaffected by July
    expect(r.receivedFirstMatching).toBe(true)
    expect(r.lastEmail).toBe('invite')         // NOT reminder_1/2
  })

  it('10. legacy user who received July is still classified by the normal sequence', () => {
    const r = lc({ invited_at: hoursAgo(30), first_matching_reminder_sent_at: hoursAgo(1) })
    expect(r.state).toBe('reminder_1_due')     // July presence irrelevant to state
    expect(r.receivedFirstMatching).toBe(true)
    expect(r.canSendActivationEmail).toBe(true)
  })

  it('11. future invitee does not inherit July (no first_matching timestamp)', () => {
    const r = lc({ invited_at: hoursAgo(2), first_matching_reminder_sent_at: null })
    expect(r.receivedFirstMatching).toBe(false)
    expect(isNewlyInvitedNoFollowup(base({ first_matching_reminder_sent_at: null }))).toBe(true)
  })

  it('12. profileComplete is the caller-supplied normalized-email match (drives completed)', () => {
    expect(lc({ profileComplete: true }).state).toBe('completed')
    expect(lc({ profileComplete: false }).state).not.toBe('completed')
  })

  it('14. missing or invalid email → invalid_email', () => {
    expect(lc({ email: null }).state).toBe('invalid_email')
    expect(lc({ email: '   ' }).state).toBe('invalid_email')
    expect(lc({ email: 'not-an-email' }).state).toBe('invalid_email')
  })

  it('15. missing invited_at → missing_invited_at', () => {
    expect(lc({ invited_at: null }).state).toBe('missing_invited_at')
  })

  it('17. a failed reminder (sent_at still null) remains due/retryable', () => {
    // The error column does not gate eligibility — only sent_at does.
    expect(lc({ invited_at: hoursAgo(30), invite_reminder_1_sent_at: null }).state).toBe('reminder_1_due')
  })

  it('18. a successful reminder (sent_at set) is not re-offered as due', () => {
    expect(lc({ invited_at: hoursAgo(30), invite_reminder_1_sent_at: hoursAgo(1) }).state).not.toBe('reminder_1_due')
  })

  it('20. admin labels + due dates render from the shared module', () => {
    expect(lifecycleLabel('reminder_1_due')).toBe('Reminder 1 due')
    expect(lifecycleLabel('reminder_2_sent')).toBe('Sequence complete')
    const r = lc({ invited_at: hoursAgo(2) })
    // reminder 1 due date = invited_at + 24h
    expect(r.nextDueAt).toBe(new Date(new Date(hoursAgo(2)).getTime() + REMINDER_SCHEDULE.reminder1DelayHours * 3600 * 1000).toISOString())
  })

  it('a non-invited row is defensively classified not_invited', () => {
    expect(lc({ status: 'approved' }).state).toBe('not_invited')
  })
})

describe('isNewlyInvitedNoFollowup', () => {
  it('true when invited, incomplete, has invited_at, neither reminder sent (July irrelevant)', () => {
    expect(isNewlyInvitedNoFollowup(base())).toBe(true)
    expect(isNewlyInvitedNoFollowup(base({ first_matching_reminder_sent_at: hoursAgo(1) }))).toBe(true)
  })
  it('false once any reminder is sent, or completed, or missing invited_at', () => {
    expect(isNewlyInvitedNoFollowup(base({ invite_reminder_1_sent_at: hoursAgo(1) }))).toBe(false)
    expect(isNewlyInvitedNoFollowup(base({ invite_reminder_2_sent_at: hoursAgo(1) }))).toBe(false)
    expect(isNewlyInvitedNoFollowup(base({ profileComplete: true }))).toBe(false)
    expect(isNewlyInvitedNoFollowup(base({ invited_at: null }))).toBe(false)
  })
})
