import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { assembleMeetings, meetingParticipantIds, type MeetingRow } from '@/lib/meetings/assemble'

const NOW = new Date('2026-07-20T12:00:00Z').getTime()
const row = (o: Partial<MeetingRow>): MeetingRow => ({
  id: o.id ?? 'm', purpose: o.purpose ?? 'Intro chat', purpose_category: o.purpose_category ?? null,
  format: o.format ?? 'zoom', status: o.status ?? 'booked', scheduled_at: o.scheduled_at ?? '2026-08-01T00:00:00Z',
  duration_minutes: o.duration_minutes ?? 30, location: o.location ?? null, zoom_link: o.zoom_link ?? null, notes: o.notes ?? null,
  requester_id: o.requester_id ?? 'me', recipient_id: o.recipient_id ?? 'alice',
  proposed_scheduled_at: o.proposed_scheduled_at ?? null, proposed_duration_minutes: o.proposed_duration_minutes ?? null,
  proposed_format: o.proposed_format ?? null, proposed_location: o.proposed_location ?? null,
  proposed_zoom_link: o.proposed_zoom_link ?? null, proposed_notes: o.proposed_notes ?? null, updated_at: null,
})
const profiles = new Map<string, any>([
  ['alice', { id: 'alice', full_name: 'Alice', title: 'GC', company: 'Acme', avatar_url: null }],
  ['bob', { id: 'bob', full_name: 'Bob', title: 'CFO', company: 'Beta', avatar_url: null }],
])

describe('meetingParticipantIds', () => {
  it('resolves the OTHER participant and de-duplicates', () => {
    const ids = meetingParticipantIds([
      row({ requester_id: 'me', recipient_id: 'alice' }),
      row({ requester_id: 'bob', recipient_id: 'me' }), // me is recipient → other = bob
      row({ requester_id: 'me', recipient_id: 'alice' }), // dup alice
    ], 'me')
    expect(ids.sort()).toEqual(['alice', 'bob'])
  })
  it('empty input → []', () => { expect(meetingParticipantIds([], 'me')).toEqual([]) })
})

describe('assembleMeetings', () => {
  it('resolves participant from either side + attaches profile context', () => {
    const { upcoming } = assembleMeetings([
      row({ id: 'a', requester_id: 'me', recipient_id: 'alice' }),
      row({ id: 'b', requester_id: 'bob', recipient_id: 'me' }),
    ], profiles, 'me', NOW)
    const byId = Object.fromEntries(upcoming.map(m => [m.id, m]))
    expect(byId.a.other.full_name).toBe('Alice'); expect(byId.a.isOrganizer).toBe(true)
    expect(byId.b.other.full_name).toBe('Bob');   expect(byId.b.isOrganizer).toBe(false)
  })

  it('other is null when the profile is missing (no crash)', () => {
    const { upcoming } = assembleMeetings([row({ recipient_id: 'ghost' })], profiles, 'me', NOW)
    expect(upcoming[0].other).toBeNull()
  })

  it('preserves ordering: upcoming ascending, past most-recent-first; no duplicates', () => {
    const rows = [
      row({ id: 'p_old', scheduled_at: '2026-06-01T00:00:00Z' }),
      row({ id: 'p_recent', scheduled_at: '2026-07-10T00:00:00Z' }),
      row({ id: 'u_soon', scheduled_at: '2026-07-25T00:00:00Z' }),
      row({ id: 'u_late', scheduled_at: '2026-09-01T00:00:00Z' }),
    ]
    const { upcoming, past } = assembleMeetings(rows, profiles, 'me', NOW)
    expect(upcoming.map(m => m.id)).toEqual(['u_soon', 'u_late'])   // ascending
    expect(past.map(m => m.id)).toEqual(['p_recent', 'p_old'])       // reversed (most recent first)
    expect(upcoming.length + past.length).toBe(rows.length)          // no dropped/duplicated meetings
  })

  it('preserves EVERY status verbatim (draft/proposed/pending/booked/completed/cancelled/…)', () => {
    for (const status of ['draft', 'proposed', 'pending', 'booked', 'completed', 'cancelled', 'requested', 'reschedule_requested']) {
      const { upcoming } = assembleMeetings([row({ status })], profiles, 'me', NOW)
      expect(upcoming[0].status).toBe(status)
    }
  })

  it('isNew only when incoming request/reschedule to the recipient (not the organizer)', () => {
    const incoming = assembleMeetings([row({ status: 'requested', requester_id: 'alice', recipient_id: 'me' })], profiles, 'me', NOW)
    expect(incoming.upcoming[0].isNew).toBe(true)
    const mine = assembleMeetings([row({ status: 'requested', requester_id: 'me', recipient_id: 'alice' })], profiles, 'me', NOW)
    expect(mine.upcoming[0].isNew).toBe(false)
    const booked = assembleMeetings([row({ status: 'booked', requester_id: 'alice', recipient_id: 'me' })], profiles, 'me', NOW)
    expect(booked.upcoming[0].isNew).toBe(false)
  })

  it('carries proposed times/details through for proposed/reschedule states', () => {
    const { upcoming } = assembleMeetings([row({ status: 'proposed', proposed_scheduled_at: '2026-08-05T00:00:00Z', proposed_notes: 'How about Fri?' })], profiles, 'me', NOW)
    expect(upcoming[0].proposed_scheduled_at).toBe('2026-08-05T00:00:00Z')
    expect(upcoming[0].proposed_notes).toBe('How about Fri?')
  })

  it('empty state → no meetings', () => {
    expect(assembleMeetings([], profiles, 'me', NOW)).toEqual({ upcoming: [], past: [] })
    expect(assembleMeetings(null, profiles, 'me', NOW)).toEqual({ upcoming: [], past: [] })
  })
})

describe('meetings page: no redundant/dead/N+1 queries (structural)', () => {
  const page = readFileSync('app/dashboard/meetings/page.tsx', 'utf8')
  it('uses the shared assembler + a single batched profiles query', () => {
    expect(page).toContain('assembleMeetings')
    expect(page).toContain('meetingParticipantIds')
    expect(page).toContain(".in('id', profileIds)")
  })
  it('dropped the redundant join-meetings query and the dead unread-notif SELECT', () => {
    expect(page).not.toContain('profiles!requester_id')   // no second meetings query just for joins
    expect(page).not.toContain('unreadMeetingNotifs')     // dead query removed
    expect(page).not.toContain('hasUnreadNotif')          // dead variable removed
  })
  it('keeps authorization (own meetings only) and the mark-read unread semantics', () => {
    expect(page).toContain('requester_id.eq.${user.id},recipient_id.eq.${user.id}')
    expect(page).toMatch(/\.update\(\{ read_at[\s\S]*meeting_request/)
  })
  it('removed noisy per-item debug logging', () => {
    expect(page).not.toContain("console.log('[Meetings]")
  })
})
