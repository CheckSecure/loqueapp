import { describe, it, expect } from 'vitest'
import {
  shouldNotifyVisibleBatch,
  shouldEmailNewMessage,
  shouldRemindWaiting,
  shouldSendIntroReminder,
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
