import { describe, it, expect } from 'vitest'
import {
  isInvitedButJoined,
  excludeJoinedFromInvited,
  toCompletedEmailSet,
} from '@/lib/waitlist/joined'

/**
 * Behavior: Admin → Waitlist → Invited should list only approved/invited people
 * who have NOT yet completed onboarding. The canonical "joined" signal is
 * profiles.profile_complete = true (NOT mere login), matched to waitlist by
 * normalized email. Completed users are removed from Invited by a read-only
 * query filter — no waitlist row is mutated.
 */

const set = (emails: string[]) => toCompletedEmailSet(emails.map(email => ({ email })))

describe('Invited-tab exclusion (canonical signal = profile_complete)', () => {
  it('1. an invited user with NO completed onboarding stays in Invited', () => {
    const rows = [{ status: 'invited', email: 'newbie@x.com' }]
    expect(excludeJoinedFromInvited(rows, set([]))).toEqual(rows)
    expect(isInvitedButJoined(rows[0], set([]))).toBe(false)
  })

  it('2. an invited user who STARTED but did not complete onboarding stays in Invited', () => {
    // profile exists but profile_complete=false → not in the completed set.
    const rows = [{ status: 'invited', email: 'partial@x.com' }]
    const completed = set(['someoneelse@x.com']) // partial@x.com deliberately absent
    expect(excludeJoinedFromInvited(rows, completed)).toEqual(rows)
  })

  it('3. a user who COMPLETED onboarding disappears from Invited', () => {
    const rows = [{ status: 'invited', email: 'joined@x.com' }]
    expect(excludeJoinedFromInvited(rows, set(['joined@x.com']))).toEqual([])
    expect(isInvitedButJoined(rows[0], set(['joined@x.com']))).toBe(true)
  })

  it('3b. matching is case/space-insensitive (email normalization)', () => {
    const rows = [{ status: 'invited', email: '  Joined@X.COM ' }]
    expect(excludeJoinedFromInvited(rows, set(['joined@x.com']))).toEqual([])
  })

  it('5. existing joined users are all excluded; not-yet-joined and other tabs are untouched', () => {
    const rows = [
      { status: 'pending',  email: 'p@x.com' },
      { status: 'approved', email: 'a@x.com' },
      { status: 'invited',  email: 'joined1@x.com' },
      { status: 'invited',  email: 'joined2@x.com' },
      { status: 'invited',  email: 'waiting@x.com' },
      { status: 'declined', email: 'd@x.com' },
    ]
    const out = excludeJoinedFromInvited(rows, set(['joined1@x.com', 'joined2@x.com']))
    expect(out.map(r => r.email)).toEqual(['p@x.com', 'a@x.com', 'waiting@x.com', 'd@x.com'])
    // only one genuinely not-yet-joined invited row remains
    expect(out.filter(r => r.status === 'invited')).toHaveLength(1)
  })

  it('6. a completed profile only affects Invited rows, never Pending/Approved/Declined (history intact — no mutation)', () => {
    const rows = [{ status: 'approved', email: 'joined@x.com' }]
    // Even though this email completed onboarding, it is not 'invited' → untouched.
    expect(excludeJoinedFromInvited(rows, set(['joined@x.com']))).toEqual(rows)
  })

  it('toCompletedEmailSet drops null/blank emails and normalizes', () => {
    const s = toCompletedEmailSet([{ email: '  A@B.com ' }, { email: null }, { email: '' }])
    expect(s.has('a@b.com')).toBe(true)
    expect(s.size).toBe(1)
  })
})
