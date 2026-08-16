import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Incoming-interest surface + reminder unification.
 *
 * Root cause this fixes: "Someone is waiting on your response" fired on
 * member-initiated `approved` interest, but the Introductions page only rendered
 * incoming interest for admin-initiated rows — so the CTA landed on a page with no
 * actionable item. The fix adds an "Interested in you" surface driven by a single
 * source of truth (fetchActionableIncomingInterest) that the reminder cron shares.
 */

// ── Pure predicate: the exact definition of an actionable incoming item ───────
import { isActionableIncoming, fetchActionableIncomingInterest } from '@/lib/introductions/incomingInterest'

const base = {
  status: 'approved',
  isAdminInitiated: false,
  hasMatch: false,
  requesterActive: true,
  sameCompany: false,
}

describe('isActionableIncoming — the shared definition', () => {
  it('member-initiated approved, unmatched, active, cross-company → actionable', () => {
    expect(isActionableIncoming(base)).toBe(true)
  })

  it('admin-initiated is excluded (it has its own surface + nudge)', () => {
    expect(isActionableIncoming({ ...base, isAdminInitiated: true })).toBe(false)
  })

  it('non-approved (suggested/pending/declined/passed) is not yet/no-longer expressed → excluded', () => {
    for (const status of ['suggested', 'pending', 'declined', 'passed', 'archived', 'expired']) {
      expect(isActionableIncoming({ ...base, status })).toBe(false)
    }
  })

  it('already matched → nothing to respond to → excluded (mutual interest never nags)', () => {
    expect(isActionableIncoming({ ...base, hasMatch: true })).toBe(false)
  })

  it('deactivated expresser → cannot connect → excluded', () => {
    expect(isActionableIncoming({ ...base, requesterActive: false })).toBe(false)
  })

  it('same-company pair → mutual-match path would reject → excluded', () => {
    expect(isActionableIncoming({ ...base, sameCompany: true })).toBe(false)
  })
})

// ── DB fetch: exclusions, dedupe, and the "no reciprocal card" (33-case) proof ─
// A3: incomingInterest now reads the requester profiles separately from the discovery-scoped profile
// source (`.in()` → array) and the viewer's own company (`.eq().maybeSingle()` → single). This mock is
// terminator-aware for that source: provide `requesterProfiles` (array) + `viewerCompany` (string).
function fakeDb(tables: Record<string, any>) {
  const builder = (result: any): any => {
    const p: any = {
      select: () => p, eq: () => p, order: () => p, or: () => p, in: () => p, lte: () => p, is: () => p,
      maybeSingle: () => Promise.resolve(result),
      then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
    }
    return p
  }
  const profileSourceBuilder = (): any => {
    let usedIn = false
    const p: any = {
      select: () => p, eq: () => p,
      in: () => { usedIn = true; return p },
      maybeSingle: () => Promise.resolve({ data: { company: tables.viewerCompany ?? null } }),
      then: (res: any, rej: any) =>
        Promise.resolve({ data: usedIn ? (tables.requesterProfiles ?? []) : [] }).then(res, rej),
    }
    return p
  }
  return {
    from: (t: string) =>
      (t === 'public_profiles' || t === 'profiles') ? profileSourceBuilder() : builder(tables[t] ?? { data: null }),
  }
}

const requester = (id: string, over: any = {}) => ({
  id, full_name: `Member ${id}`, title: 'CxO', exact_job_title: null, company: 'Acme',
  location: null, bio: null, avatar_url: null, seniority: null, role_type: null,
  expertise: null, interests: null, account_status: 'active', ...over,
})

describe('fetchActionableIncomingInterest — surface source of truth', () => {
  it('returns member-initiated approved interest even when the viewer has NO reciprocal recommendation (the 33-case)', async () => {
    // Note: the fetch never queries the viewer's reverse rows — actionability is
    // built purely from the expresser's row, so members who never received a
    // reciprocal card still get an actionable item.
    const db = fakeDb({
      intro_requests: { data: [
        { id: 'ir1', requester_id: 'A', target_user_id: 'V', status: 'approved', is_admin_initiated: false, created_at: '2026-07-30T00:00:00Z', match_reason: 'why' },
      ] },
      matches: { data: [] },
      requesterProfiles: [requester('A', { company: 'Acme' })],
      viewerCompany: 'Globex', // cross-company
    })
    const items = await fetchActionableIncomingInterest(db, 'V')
    expect(items).toHaveLength(1)
    expect(items[0].requesterId).toBe('A')
    expect(items[0].introRequestId).toBe('ir1')
  })

  it('excludes matched, same-company, and deactivated-expresser rows', async () => {
    const db = fakeDb({
      intro_requests: { data: [
        { id: 'm1', requester_id: 'MATCHED', target_user_id: 'V', status: 'approved', is_admin_initiated: false, created_at: '2026-07-30T00:00:00Z', match_reason: null },
        { id: 's1', requester_id: 'SAMECO', target_user_id: 'V', status: 'approved', is_admin_initiated: false, created_at: '2026-07-30T00:00:00Z', match_reason: null },
        { id: 'd1', requester_id: 'GONE', target_user_id: 'V', status: 'approved', is_admin_initiated: false, created_at: '2026-07-30T00:00:00Z', match_reason: null },
        { id: 'ok', requester_id: 'GOOD', target_user_id: 'V', status: 'approved', is_admin_initiated: false, created_at: '2026-07-30T00:00:00Z', match_reason: null },
      ] },
      matches: { data: [{ user_a_id: 'V', user_b_id: 'MATCHED' }] },
      requesterProfiles: [
        requester('MATCHED', { company: 'Globex' }),
        requester('SAMECO', { company: 'Acme' }),
        requester('GONE', { company: 'Globex', account_status: 'deactivated' }),
        requester('GOOD', { company: 'Initech' }),
      ],
      viewerCompany: 'Acme', // viewer at Acme → SAMECO excluded
    })
    const items = await fetchActionableIncomingInterest(db, 'V')
    expect(items.map((i) => i.requesterId)).toEqual(['GOOD'])
  })

  it('de-dupes multiple approved rows from the same expresser into one card', async () => {
    const db = fakeDb({
      intro_requests: { data: [
        { id: 'newer', requester_id: 'A', target_user_id: 'V', status: 'approved', is_admin_initiated: false, created_at: '2026-07-31T00:00:00Z', match_reason: null },
        { id: 'older', requester_id: 'A', target_user_id: 'V', status: 'approved', is_admin_initiated: false, created_at: '2026-07-01T00:00:00Z', match_reason: null },
      ] },
      matches: { data: [] },
      requesterProfiles: [requester('A', { company: 'Globex' })],
      viewerCompany: 'Acme',
    })
    const items = await fetchActionableIncomingInterest(db, 'V')
    expect(items).toHaveLength(1)
    expect(items[0].introRequestId).toBe('newer') // most recent kept
  })
})

// ── Behavioral: decline resolves WITHOUT creating reciprocal interest ─────────
const h = vi.hoisted(() => ({
  user: { id: 'V' } as any,
  incoming: null as any,
  calls: [] as Array<{ table: string; method: string; payload?: any }>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      const b: any = {
        select: () => b, eq: () => b, is: () => b,
        update: (payload: any) => { h.calls.push({ table, method: 'update', payload }); return b },
        insert: (payload: any) => { h.calls.push({ table, method: 'insert', payload }); return Promise.resolve({ error: null }) },
        maybeSingle: () => Promise.resolve({ data: h.incoming }),
        then: (res: any, rej: any) => Promise.resolve({ error: null }).then(res, rej),
      }
      return b
    },
  }),
}))

import { POST as DECLINE } from '@/app/api/intro-requests/decline-incoming/route'

function req(body: any) {
  return new Request('http://t/api/intro-requests/decline-incoming', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

beforeEach(() => {
  h.user = { id: 'V' }
  h.incoming = { id: 'ir1', requester_id: 'A', target_user_id: 'V', status: 'approved', is_admin_initiated: false }
  h.calls = []
})

describe('decline-incoming — resolves without reciprocal interest or credit', () => {
  it('sets the expresser row to declined and NEVER inserts a reciprocal row', async () => {
    const res = await DECLINE(req({ introRequestId: 'ir1' }))
    expect(res.status).toBe(200)
    const introUpdate = h.calls.find((c) => c.table === 'intro_requests' && c.method === 'update')
    expect(introUpdate?.payload?.status).toBe('declined')
    expect(h.calls.some((c) => c.method === 'insert')).toBe(false) // no reciprocal expression
  })

  it('rejects unauthenticated callers', async () => {
    h.user = null
    expect((await DECLINE(req({ introRequestId: 'ir1' }))).status).toBe(401)
  })

  it('only the target may decline (not the expresser)', async () => {
    h.user = { id: 'A' } // the expresser, not the target
    expect((await DECLINE(req({ introRequestId: 'ir1' }))).status).toBe(403)
  })

  it('refuses admin-initiated rows (they have their own decline path)', async () => {
    h.incoming = { ...h.incoming, is_admin_initiated: true }
    expect((await DECLINE(req({ introRequestId: 'ir1' }))).status).toBe(400)
  })
})

// ── Structural: the whole path is wired to ONE source of truth ────────────────
describe('wiring — page, routes, and cron share the surface definition', () => {
  const page = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
  const cron = readFileSync('app/api/cron/engagement-reminders/route.ts', 'utf8')
  const accept = readFileSync('app/api/intro-requests/accept-incoming/route.ts', 'utf8')
  const express = readFileSync('app/api/intro-requests/express-interest/route.ts', 'utf8')
  const card = readFileSync('components/IncomingInterestCard.tsx', 'utf8')
  const finalize = readFileSync('lib/introductions/finalizeMutualMatch.ts', 'utf8')

  it('the page renders an "Interested in you" surface from the shared fetch', () => {
    expect(page).toContain('fetchActionableIncomingInterest')
    expect(page).toContain('<IncomingInterestCard')
    expect(page).toContain('Interested in you')
  })

  it('the page shows an incoming requester in exactly one place (excluded from suggestions/pending)', () => {
    expect(page).toContain('incomingRequesterIds')
    expect(page).toMatch(/!incomingRequesterIds\.has\(intro\.target\.id\)/) // suggestions
    expect(page).toMatch(/incomingRequesterIds\.has\(t\.id\)/) // pending
  })

  it('the reminder cron gates on the SAME fetch, so reminder and UI cannot drift', () => {
    expect(cron).toContain('fetchActionableIncomingInterest')
    expect(cron).toMatch(/actionable\.has\(row\.id\)/)
    expect(cron).toContain("eq('is_admin_initiated', false)") // never nudges on admin rows
  })

  it('accept-incoming is two-step-safe: gated by the shared fetch, reuses-or-creates the reciprocal, then finalizes', () => {
    expect(accept).toContain('fetchActionableIncomingInterest')
    expect(accept).toContain('finalizeMutualMatch')
    expect(accept).toMatch(/reusable|reverseRows/) // reuse existing reverse row when present
    expect(accept).toContain("status: 'approved'") // creates reciprocal expression on the fly
  })

  it('express-interest reuses the shared finalizer (no duplicated match logic)', () => {
    expect(express).toContain('finalizeMutualMatch')
    expect(express).not.toContain('consume_credits_and_create_match') // moved into the finalizer
  })

  it('finalizing a match retires outstanding waiting reminders for the pair', () => {
    expect(finalize).toContain('retireWaitingResponseForPair')
    expect(finalize).toContain("type', 'waiting_response'")
  })

  it('the card first click only reviews (no mutation); only the confirm CTA connects and uses a credit', () => {
    expect(card).toContain("setState('review')") // Accept → review, no fetch
    expect(card).toContain('Connect and use 1 credit')
    expect(card).toContain('/api/intro-requests/accept-incoming')
    expect(card).toContain('/api/intro-requests/decline-incoming')
    expect(card).toContain('Not now')
  })
})
