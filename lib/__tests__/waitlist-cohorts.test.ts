import { describe, it, expect } from 'vitest'
import {
  reminder1DueCohort,
  reminder2DueCohort,
  newlyInvitedNoFollowupCohort,
  incompleteReceivedFirstMatchingCohort,
  incompleteNotReceivedFirstMatchingCohort,
  type WaitlistLifecycleRow,
} from '@/lib/waitlist/cohorts'

const NOW = new Date('2026-07-19T12:00:00Z').getTime()
const hoursAgo = (h: number) => new Date(NOW - h * 3600 * 1000).toISOString()
const row = (o: Partial<WaitlistLifecycleRow>): WaitlistLifecycleRow => ({
  id: o.id ?? 'r', email: o.email ?? 'a@x.com', full_name: o.full_name ?? 'Ann Lee',
  status: o.status ?? 'invited', invited_at: o.invited_at ?? hoursAgo(2),
  invite_reminder_1_sent_at: o.invite_reminder_1_sent_at ?? null,
  invite_reminder_2_sent_at: o.invite_reminder_2_sent_at ?? null,
  first_matching_reminder_sent_at: o.first_matching_reminder_sent_at ?? null,
})
const opts = (extra: Partial<Parameters<typeof reminder1DueCohort>[1]> = {}) => ({
  completedEmails: new Set<string>(), nowMs: NOW, ...extra,
})

describe('reminder1DueCohort', () => {
  it('selects only reminder_1_due rows; excludes not-due, sent, and completed', () => {
    const rows = [
      row({ id: 'due', email: 'due@x.com', invited_at: hoursAgo(30) }),          // due
      row({ id: 'early', email: 'early@x.com', invited_at: hoursAgo(2) }),        // not due
      row({ id: 'sent', email: 'sent@x.com', invited_at: hoursAgo(30), invite_reminder_1_sent_at: hoursAgo(1) }), // already sent
      row({ id: 'done', email: 'done@x.com', invited_at: hoursAgo(30) }),         // completed
    ]
    const { recipients, stats } = reminder1DueCohort(rows, opts({ completedEmails: new Set(['done@x.com']) }))
    expect(recipients.map(r => r.id)).toEqual(['due'])
    expect(stats.excludedCompleted).toBe(1)
    expect(recipients[0].firstName).toBe('Ann') // 19. first-name fallback / extraction
  })

  it('16. respects a provided suppression set', () => {
    const rows = [
      row({ id: 'a', email: 'a@x.com', invited_at: hoursAgo(30) }),
      row({ id: 'b', email: 'b@x.com', invited_at: hoursAgo(30) }),
    ]
    const { recipients, stats } = reminder1DueCohort(rows, opts({ suppressedEmails: new Set(['a@x.com']) }))
    expect(recipients.map(r => r.id)).toEqual(['b'])
    expect(stats.excludedSuppressed).toBe(1)
  })

  it('12/13. normalized-email matching for completion + de-duplication', () => {
    const rows = [
      row({ id: 'dup1', email: 'Dup@X.com', invited_at: hoursAgo(30) }),
      row({ id: 'dup2', email: ' dup@x.com ', invited_at: hoursAgo(30) }),        // duplicate of dup1
      row({ id: 'done', email: 'DONE@x.com', invited_at: hoursAgo(30) }),         // completed via mixed case
    ]
    const { recipients, stats } = reminder1DueCohort(rows, opts({ completedEmails: new Set(['done@x.com']) }))
    expect(recipients.map(r => r.email)).toEqual(['dup@x.com'])
    expect(stats.removedDuplicates).toBe(1)
    expect(stats.excludedCompleted).toBe(1)
  })

  it('18. successful reminder is idempotently skipped', () => {
    const rows = [row({ id: 'sent', invited_at: hoursAgo(30), invite_reminder_1_sent_at: hoursAgo(1) })]
    expect(reminder1DueCohort(rows, opts()).recipients).toHaveLength(0)
  })
})

describe('reminder2DueCohort', () => {
  it('selects reminder_2_due (r1 sent + past 7d); never before reminder 1', () => {
    const rows = [
      row({ id: 'r2due', email: 'r2@x.com', invited_at: hoursAgo(200), invite_reminder_1_sent_at: hoursAgo(150) }),
      row({ id: 'nor1', email: 'nor1@x.com', invited_at: hoursAgo(200) }),        // past 7d but no r1 → NOT r2
      row({ id: 'r2sent', email: 'done@x.com', invited_at: hoursAgo(300), invite_reminder_1_sent_at: hoursAgo(250), invite_reminder_2_sent_at: hoursAgo(50) }),
    ]
    expect(reminder2DueCohort(rows, opts()).recipients.map(r => r.id)).toEqual(['r2due'])
  })
})

describe('newlyInvitedNoFollowupCohort', () => {
  it('includes no-follow-up invitees (July does NOT disqualify); excludes any-reminder-sent', () => {
    const rows = [
      row({ id: 'new', email: 'new@x.com' }),
      row({ id: 'july', email: 'july@x.com', first_matching_reminder_sent_at: hoursAgo(1) }), // still newly invited
      row({ id: 'r1', email: 'r1@x.com', invite_reminder_1_sent_at: hoursAgo(1) }),           // excluded
    ]
    expect(newlyInvitedNoFollowupCohort(rows, opts()).recipients.map(r => r.id).sort()).toEqual(['july', 'new'])
  })
})

describe('first-matching segmentation cohorts', () => {
  const rows = [
    row({ id: 'j1', email: 'j1@x.com', first_matching_reminder_sent_at: hoursAgo(1) }),
    row({ id: 'j2', email: 'j2@x.com', first_matching_reminder_sent_at: hoursAgo(2) }),
    row({ id: 'n1', email: 'n1@x.com' }),
    row({ id: 'done', email: 'done@x.com', first_matching_reminder_sent_at: hoursAgo(1) }), // completed → excluded from both
  ]
  const o = opts({ completedEmails: new Set(['done@x.com']) })

  it('received-July cohort = incomplete invited with the July timestamp', () => {
    expect(incompleteReceivedFirstMatchingCohort(rows, o).recipients.map(r => r.id).sort()).toEqual(['j1', 'j2'])
  })
  it('not-received-July cohort = incomplete invited without the July timestamp', () => {
    expect(incompleteNotReceivedFirstMatchingCohort(rows, o).recipients.map(r => r.id)).toEqual(['n1'])
  })
})
