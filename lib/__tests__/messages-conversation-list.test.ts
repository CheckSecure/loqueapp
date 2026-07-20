import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  pickLatestPerConversation,
  countUnreadByConversation,
  assembleConversationList,
  type MessageRow,
  type ConversationRow,
  type MatchRow,
} from '@/lib/messages/conversationList'

const msg = (o: Partial<MessageRow>): MessageRow => ({
  id: o.id ?? 'm', conversation_id: o.conversation_id ?? 'c1', content: o.content ?? 'hi',
  sender_id: o.sender_id ?? 'u2', is_system: o.is_system ?? false, created_at: o.created_at ?? '2026-07-01T00:00:00Z',
})

describe('pickLatestPerConversation (order-independent, one per conversation)', () => {
  it('keeps the newest message per conversation regardless of input order', () => {
    const rows = [
      msg({ id: 'a', conversation_id: 'c1', created_at: '2026-07-01T00:00:00Z' }),
      msg({ id: 'b', conversation_id: 'c1', created_at: '2026-07-05T00:00:00Z' }), // newest for c1
      msg({ id: 'c', conversation_id: 'c1', created_at: '2026-07-03T00:00:00Z' }),
      msg({ id: 'd', conversation_id: 'c2', created_at: '2026-07-02T00:00:00Z' }),
    ]
    const map = pickLatestPerConversation(rows)
    expect(map.size).toBe(2)          // no duplicates — one per conversation
    expect(map.get('c1')!.id).toBe('b')
    expect(map.get('c2')!.id).toBe('d')
  })
  it('empty/undefined input → empty map', () => {
    expect(pickLatestPerConversation([]).size).toBe(0)
    expect(pickLatestPerConversation(undefined).size).toBe(0)
  })
})

describe('countUnreadByConversation', () => {
  it('counts unread rows per conversation', () => {
    const m = countUnreadByConversation([{ conversation_id: 'c1' }, { conversation_id: 'c1' }, { conversation_id: 'c2' }])
    expect(m.get('c1')).toBe(2)
    expect(m.get('c2')).toBe(1)
    expect(m.get('c3')).toBeUndefined()
  })
  it('no unread rows → all zero (empty map)', () => {
    expect(countUnreadByConversation([]).size).toBe(0)
  })
})

describe('assembleConversationList', () => {
  const conv = (o: Partial<ConversationRow>): ConversationRow => ({
    id: o.id ?? 'c1', match_id: o.match_id ?? 'mA', first_message_sent_at: o.first_message_sent_at ?? null,
    last_message_at: o.last_message_at ?? null, message_count: o.message_count ?? 0, created_at: o.created_at ?? '2026-07-01T00:00:00Z',
  })
  const match = (o: Partial<MatchRow>): MatchRow => ({ id: o.id ?? 'mA', user_a_id: o.user_a_id ?? 'me', user_b_id: o.user_b_id ?? 'other', ...o })

  it('preserves input order and resolves the OTHER user (a vs b)', () => {
    const conversations = [conv({ id: 'c1', match_id: 'mA' }), conv({ id: 'c2', match_id: 'mB' })]
    const matchById = new Map<string, MatchRow>([
      ['mA', match({ id: 'mA', user_a_id: 'me', user_b_id: 'alice' })],
      ['mB', match({ id: 'mB', user_a_id: 'bob', user_b_id: 'me' })], // me is user_b here
    ])
    const out = assembleConversationList({
      conversations, matchById, userId: 'me',
      profileById: new Map([['alice', { id: 'alice', full_name: 'Alice' }], ['bob', { id: 'bob', full_name: 'Bob' }]]),
      lastByConv: new Map(), unreadByConv: new Map(), oppTitleById: new Map(),
    })
    expect(out.map(o => o.id)).toEqual(['c1', 'c2'])           // order preserved
    expect(out[0].otherUser.full_name).toBe('Alice')
    expect(out[1].otherUser.full_name).toBe('Bob')             // resolved from user_a side
  })

  it('attaches unread counts, last message (5-field shape), and opportunity title', () => {
    const out = assembleConversationList({
      conversations: [conv({ id: 'c1', match_id: 'mA' })],
      matchById: new Map([['mA', match({ id: 'mA', is_opportunity_initiated: true, opportunity_id: 'op1' })]]),
      userId: 'me',
      profileById: new Map([['other', { id: 'other', full_name: 'O' }]]),
      lastByConv: pickLatestPerConversation([msg({ id: 'x', conversation_id: 'c1', content: 'yo', created_at: '2026-07-09T00:00:00Z' })]),
      unreadByConv: countUnreadByConversation([{ conversation_id: 'c1' }, { conversation_id: 'c1' }]),
      oppTitleById: new Map([['op1', 'Senior Counsel role']]),
    })
    expect(out[0].unreadCount).toBe(2)
    expect(out[0].lastMessage).toEqual({ id: 'x', content: 'yo', sender_id: 'u2', is_system: false, created_at: '2026-07-09T00:00:00Z' })
    expect(out[0].isOpportunityInitiated).toBe(true)
    expect(out[0].opportunityTitle).toBe('Senior Counsel role')
  })

  it('null last message and zero unread by default; empty conversations → []', () => {
    const out = assembleConversationList({
      conversations: [conv({ id: 'c1', match_id: 'mA' })], matchById: new Map([['mA', match({})]]),
      userId: 'me', profileById: new Map(), lastByConv: new Map(), unreadByConv: new Map(), oppTitleById: new Map(),
    })
    expect(out[0].lastMessage).toBeNull()
    expect(out[0].unreadCount).toBe(0)
    expect(out[0].otherUser).toBeNull()
    expect(assembleConversationList({ conversations: [], matchById: new Map(), userId: 'me', profileById: new Map(), lastByConv: new Map(), unreadByConv: new Map(), oppTitleById: new Map() })).toEqual([])
  })

  it('drops conversations whose match was filtered out (blocked/removed → not in matchById)', () => {
    const out = assembleConversationList({
      conversations: [conv({ id: 'c1', match_id: 'mA' }), conv({ id: 'c2', match_id: 'blocked' })],
      matchById: new Map([['mA', match({})]]), // 'blocked' intentionally absent
      userId: 'me', profileById: new Map(), lastByConv: new Map(), unreadByConv: new Map(), oppTitleById: new Map(),
    })
    expect(out.map(o => o.id)).toEqual(['c1'])
  })
})

describe('route no longer does N+1 (structural)', () => {
  const route = readFileSync('app/api/messages/conversations/route.ts', 'utf8')
  it('uses batched .in() lookups + shared assembler, not per-conversation single queries', () => {
    expect(route).toContain('assembleConversationList')
    expect(route).toContain(".in('id', otherIds)")          // one profiles query
    expect(route).toContain(".in('conversation_id', convIds)") // batched unread + messages
    expect(route).toContain('getLatestMessages')
    // the old N+1 shape (a per-conversation single profile fetch) is gone
    expect(route).not.toContain(".eq('id', otherUserId)")
  })
  it('prefers the DISTINCT ON RPC with a safe fallback', () => {
    expect(route).toContain("rpc('latest_messages_for_conversations'")
  })
})
