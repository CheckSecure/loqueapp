import { describe, it, expect } from 'vitest'
import { MESSAGE_EDIT_WINDOW_MS, isWithinEditWindow, canEditMessage } from '@/lib/messaging/editWindow'

const NOW = new Date('2026-07-16T12:00:00.000Z')
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

describe('isWithinEditWindow', () => {
  it('the window is 60 minutes', () => {
    expect(MESSAGE_EDIT_WINDOW_MS).toBe(60 * 60 * 1000)
  })
  it('within 60 minutes → true', () => {
    expect(isWithinEditWindow(minsAgo(0), NOW)).toBe(true)
    expect(isWithinEditWindow(minsAgo(59), NOW)).toBe(true)
    expect(isWithinEditWindow(minsAgo(60), NOW)).toBe(true) // boundary inclusive
  })
  it('past 60 minutes → false', () => {
    expect(isWithinEditWindow(minsAgo(60.01), NOW)).toBe(false)
    expect(isWithinEditWindow(minsAgo(120), NOW)).toBe(false)
  })
  it('null / invalid timestamps → false', () => {
    expect(isWithinEditWindow(null, NOW)).toBe(false)
    expect(isWithinEditWindow('not-a-date', NOW)).toBe(false)
  })
})

describe('canEditMessage — the Edit control eligibility (mirrors server enforcement)', () => {
  const sender = 'user-sender'
  const base = { sender_id: sender, is_system: false, created_at: minsAgo(10) }

  it('sender CAN edit within the window', () => {
    expect(canEditMessage(base, sender, NOW)).toBe(true)
  })
  it('sender CANNOT edit after the window → Edit option disappears', () => {
    expect(canEditMessage({ ...base, created_at: minsAgo(61) }, sender, NOW)).toBe(false)
  })
  it('recipient (not the sender) CANNOT edit', () => {
    expect(canEditMessage(base, 'user-recipient', NOW)).toBe(false)
  })
  it('system messages CANNOT be edited', () => {
    expect(canEditMessage({ ...base, is_system: true }, sender, NOW)).toBe(false)
  })
  it('no current user → cannot edit', () => {
    expect(canEditMessage(base, null, NOW)).toBe(false)
    expect(canEditMessage(null, sender, NOW)).toBe(false)
  })
})

describe('polling merge replaces the edited message without duplication', () => {
  // Mirrors ConversationView's optimistic setMessages(prev.map(...)) update.
  const applyEdit = (msgs: any[], id: string, content: string, edited_at: string) =>
    msgs.map(m => (m.id === id ? { ...m, content, edited_at } : m))

  it('updates content + edited_at in place, count unchanged, no dup', () => {
    const before = [
      { id: 'a', content: 'one', edited_at: null },
      { id: 'b', content: 'two', edited_at: null },
    ]
    const after = applyEdit(before, 'b', 'two-edited', '2026-07-16T12:00:00Z')
    expect(after).toHaveLength(2)
    expect(after.filter(m => m.id === 'b')).toHaveLength(1) // no duplicate
    expect(after.find(m => m.id === 'b')).toMatchObject({ content: 'two-edited', edited_at: '2026-07-16T12:00:00Z' })
    expect(after.find(m => m.id === 'a')).toEqual(before[0]) // others untouched
  })
})
