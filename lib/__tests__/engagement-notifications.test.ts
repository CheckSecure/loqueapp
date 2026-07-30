import { describe, it, expect } from 'vitest'
import {
  shouldNotifyVisibleBatch,
  shouldEmailNewMessage,
  shouldRemindWaiting,
  shouldSendIntroReminder,
  classifyIntroReminder,
  introReminderCopy,
  INTRO_REMINDER_STALE_MS,
  MESSAGE_EMAIL_ACTIVE_WINDOW_MS,
  WAITING_RESPONSE_THRESHOLD_MS,
} from '@/lib/notifications/engagement'

// ── PART 1: New introduction emails — only for VISIBLE (active) batches ───────
describe('shouldNotifyVisibleBatch', () => {
  it('emails when a batch is placed as the active (visible) batch', () => {
    expect(shouldNotifyVisibleBatch({ placed: true, state: 'active' })).toBe(true)
  })

  it('does NOT email for a hidden queued batch', () => {
    expect(shouldNotifyVisibleBatch({ placed: true, state: 'queued' })).toBe(false)
  })

  it('does NOT email when nothing was placed (empty / duplicate / slot full)', () => {
    expect(shouldNotifyVisibleBatch({ placed: false, reason: 'empty' } as any)).toBe(false)
    expect(shouldNotifyVisibleBatch({ placed: false, reason: 'all_duplicates' } as any)).toBe(false)
    expect(shouldNotifyVisibleBatch(null)).toBe(false)
    expect(shouldNotifyVisibleBatch(undefined)).toBe(false)
  })
})

// ── PART 2: New message emails — throttled by activity + unread state ─────────
describe('shouldEmailNewMessage', () => {
  const now = 1_000_000_000_000

  it('emails when the recipient is away and has no other unread nudge (first message)', () => {
    expect(shouldEmailNewMessage({
      recipientLastActiveAt: new Date(now - MESSAGE_EMAIL_ACTIVE_WINDOW_MS - 1).toISOString(),
      hasOtherUnreadInConversation: false,
      now,
    })).toBe(true)
  })

  it('emails when the recipient has never been active', () => {
    expect(shouldEmailNewMessage({ recipientLastActiveAt: null, hasOtherUnreadInConversation: false, now })).toBe(true)
  })

  it('does NOT email when the recipient is currently active (within the window)', () => {
    expect(shouldEmailNewMessage({
      recipientLastActiveAt: new Date(now - 60_000).toISOString(), // 1 min ago
      hasOtherUnreadInConversation: false,
      now,
    })).toBe(false)
  })

  it('does NOT email again while an earlier unread nudge for the conversation exists (no spam)', () => {
    expect(shouldEmailNewMessage({
      recipientLastActiveAt: null, // away
      hasOtherUnreadInConversation: true,
      now,
    })).toBe(false)
  })
})

// ── PART 4: "Someone is waiting on your response" — 48h, right statuses only ──
describe('shouldRemindWaiting', () => {
  const now = 1_000_000_000_000
  const hoursAgo = (h: number) => new Date(now - h * 60 * 60 * 1000).toISOString()

  it('reminds once interest is 48h+ old and still approved (unanswered)', () => {
    expect(shouldRemindWaiting({ status: 'approved', createdAt: hoursAgo(48), now })).toBe(true)
    expect(shouldRemindWaiting({ status: 'approved', createdAt: hoursAgo(72), now })).toBe(true)
  })

  it('does NOT remind before the 48h threshold', () => {
    expect(shouldRemindWaiting({ status: 'approved', createdAt: hoursAgo(47), now })).toBe(false)
  })

  it('does NOT remind once the pair is matched', () => {
    expect(shouldRemindWaiting({ status: 'approved', createdAt: hoursAgo(72), alreadyMatched: true, now })).toBe(false)
  })

  it('does NOT remind for declined/passed/expired/other statuses', () => {
    for (const status of ['declined', 'passed', 'expired', 'hidden', 'pending', 'suggested']) {
      expect(shouldRemindWaiting({ status, createdAt: hoursAgo(72), now })).toBe(false)
    }
  })

  it('threshold constant is 48 hours', () => {
    expect(WAITING_RESPONSE_THRESHOLD_MS).toBe(48 * 60 * 60 * 1000)
  })
})

// ── PART 3: weekly introduction reminder — unresolved & not-yet-reminded ──────
describe('shouldSendIntroReminder', () => {
  it('reminds when there are unresolved introductions and no prior reminder', () => {
    expect(shouldSendIntroReminder(3, false)).toBe(true)
    expect(shouldSendIntroReminder(1, false)).toBe(true)
  })

  it('does NOT remind when everything is resolved', () => {
    expect(shouldSendIntroReminder(0, false)).toBe(false)
  })

  it('does NOT remind twice for the same batch (already reminded)', () => {
    expect(shouldSendIntroReminder(3, true)).toBe(false)
  })
})

describe('classifyIntroReminder — no_action / partial / none', () => {
  it('none when nothing is unresolved (resolved batch → no reminder)', () => {
    expect(classifyIntroReminder({ unresolvedCount: 0, hasTakenAnyAction: false })).toBe('none')
    expect(classifyIntroReminder({ unresolvedCount: 0, hasTakenAnyAction: true })).toBe('none')
  })
  it('no_action when unresolved and the member has taken no action (highest priority)', () => {
    expect(classifyIntroReminder({ unresolvedCount: 2, hasTakenAnyAction: false })).toBe('no_action')
    expect(classifyIntroReminder({ unresolvedCount: 1, hasTakenAnyAction: false })).toBe('no_action')
  })
  it('partial when unresolved but the member has acted on some', () => {
    expect(classifyIntroReminder({ unresolvedCount: 1, hasTakenAnyAction: true })).toBe('partial')
  })
  it('the 7-day staleness constant is 7 days', () => {
    expect(INTRO_REMINDER_STALE_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

describe('introReminderCopy — category-specific copy', () => {
  it('no_action copy (highest priority)', () => {
    const c = introReminderCopy('no_action', 2)
    expect(c.subject).toBe('Your Andrel introductions are waiting — take 2 minutes')
    expect(c.cta).toBe('Review Introductions')
    expect(c.body).toContain('2 curated introductions')
  })
  it('partial copy', () => {
    const c = introReminderCopy('partial', 3)
    expect(c.subject).toBe("You're almost there — 3 introductions left to review")
    expect(c.cta).toBe('Finish reviewing')
    expect(c.body).toContain('3 left to review')
  })
  it('singular/plural noun agreement', () => {
    expect(introReminderCopy('partial', 1).subject).toBe("You're almost there — 1 introduction left to review")
    expect(introReminderCopy('no_action', 1).body).toContain('1 curated introduction ')
  })
})
