import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  decideDiscoverability,
  canViewerDiscoverMember,
  discoverableMemberIds,
  DISCOVERY_GRANT_STATUSES,
  type IntroRow,
} from '@/lib/privacy/canViewerDiscoverMember'
import { PUBLIC_PROFILE_COLUMNS } from '@/lib/privacy/profileColumns'

const V = 'viewer', M = 'member'
const base = { viewerId: V, memberId: M, isBlocked: false, hasActiveMatch: false, introRows: [] as IntroRow[] }
const row = (requester: string, target: string, status: string, admin = false): IntroRow => ({
  requester_id: requester, target_user_id: target, status, is_admin_initiated: admin,
})

// ── Pure decision matrix ─────────────────────────────────────────────────────
describe('decideDiscoverability', () => {
  it('self is always discoverable', () => {
    expect(decideDiscoverability({ ...base, memberId: V })).toBe(true)
  })

  it('an active match grants access', () => {
    expect(decideDiscoverability({ ...base, hasActiveMatch: true })).toBe(true)
  })

  it('a blocked pair is denied even with a match', () => {
    expect(decideDiscoverability({ ...base, isBlocked: true, hasActiveMatch: true })).toBe(false)
  })

  it('a surfaced suggested intro (viewer→member) grants access', () => {
    expect(decideDiscoverability({ ...base, introRows: [row(V, M, 'suggested')] })).toBe(true)
  })

  it('passed / declined historical intros (viewer→member) remain allowed', () => {
    expect(decideDiscoverability({ ...base, introRows: [row(V, M, 'passed')] })).toBe(true)
    expect(decideDiscoverability({ ...base, introRows: [row(V, M, 'declined')] })).toBe(true)
  })

  it('a QUEUED intro does NOT grant access (never surfaced)', () => {
    expect(decideDiscoverability({ ...base, introRows: [row(V, M, 'queued')] })).toBe(false)
  })

  it('a reverse member-initiated row (member→viewer) does NOT grant unless it is live approved interest', () => {
    expect(decideDiscoverability({ ...base, introRows: [row(M, V, 'suggested')] })).toBe(false)
    expect(decideDiscoverability({ ...base, introRows: [row(M, V, 'pending')] })).toBe(false)
    expect(decideDiscoverability({ ...base, introRows: [row(M, V, 'approved')] })).toBe(true) // incoming interest
  })

  it('an admin-initiated intro (either direction) grants access on a surfaced status', () => {
    expect(decideDiscoverability({ ...base, introRows: [row(M, V, 'admin_pending', true)] })).toBe(true)
    expect(decideDiscoverability({ ...base, introRows: [row(V, M, 'approved', true)] })).toBe(true)
    // admin + queued is still not surfaced → no grant
    expect(decideDiscoverability({ ...base, introRows: [row(M, V, 'queued', true)] })).toBe(false)
  })

  it('no relationship → not discoverable', () => {
    expect(decideDiscoverability({ ...base })).toBe(false)
  })

  it('the grant set excludes queued but includes the surfaced statuses', () => {
    expect(DISCOVERY_GRANT_STATUSES).not.toContain('queued')
    for (const s of ['suggested', 'passed', 'declined', 'expired', 'archived', 'admin_pending', 'approved']) {
      expect(DISCOVERY_GRANT_STATUSES).toContain(s)
    }
  })
})

// ── DB wrappers (fake service-role client) ───────────────────────────────────
function fakeDb(tables: Record<string, { data?: any[]; error?: any }>) {
  const builder = (result: any) => {
    const p: any = {
      select: () => p, or: () => p, neq: () => p, limit: () => p, eq: () => p, in: () => p,
      then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
    }
    return p
  }
  return { from: (t: string) => builder(tables[t] ?? { data: [], error: null }) }
}

describe('canViewerDiscoverMember (DB wrapper)', () => {
  it('grants on incoming approved interest', async () => {
    const db = fakeDb({
      blocked_users: { data: [] }, matches: { data: [] },
      intro_requests: { data: [row(M, V, 'approved')] },
    })
    expect(await canViewerDiscoverMember(db as any, V, M)).toBe(true)
  })

  it('denies an unrelated member', async () => {
    const db = fakeDb({ blocked_users: { data: [] }, matches: { data: [] }, intro_requests: { data: [] } })
    expect(await canViewerDiscoverMember(db as any, V, M)).toBe(false)
  })

  it('fails CLOSED on a query error', async () => {
    const db = fakeDb({ blocked_users: { error: { message: 'boom' } }, matches: { data: [] }, intro_requests: { data: [] } })
    expect(await canViewerDiscoverMember(db as any, V, M)).toBe(false)
  })
})

describe('discoverableMemberIds (batch, no N+1)', () => {
  it('returns only the discoverable subset', async () => {
    const db = fakeDb({
      blocked_users: { data: [{ user_id: V, blocked_user_id: 'blk' }] },
      matches: { data: [{ user_a_id: V, user_b_id: 'conn', status: 'active' }] },
      intro_requests: { data: [row(V, 'shown', 'suggested'), row('inc', V, 'approved'), row(V, 'q', 'queued')] },
    })
    const got = await discoverableMemberIds(db as any, V, ['conn', 'shown', 'inc', 'q', 'blk', 'stranger'])
    expect(got.has('conn')).toBe(true)     // match
    expect(got.has('shown')).toBe(true)    // surfaced suggestion
    expect(got.has('inc')).toBe(true)      // incoming approved
    expect(got.has('q')).toBe(false)       // queued
    expect(got.has('blk')).toBe(false)     // blocked
    expect(got.has('stranger')).toBe(false)
    expect(got.size).toBe(3)
  })
})

// ── Safe columns ─────────────────────────────────────────────────────────────
describe('safe profile projection', () => {
  it('excludes sensitive/account columns', () => {
    for (const forbidden of ['email', 'stripe_customer_id', 'subscription_tier', 'is_admin', 'trust_score', 'verification_metadata', 'password_reset_required']) {
      expect(PUBLIC_PROFILE_COLUMNS as readonly string[]).not.toContain(forbidden)
    }
  })
  it('includes the display columns the profile page needs', () => {
    for (const needed of ['full_name', 'avatar_url', 'title', 'company', 'company_id', 'role_type', 'bio', 'expertise', 'current_focus_areas', 'previous_roles']) {
      expect(PUBLIC_PROFILE_COLUMNS as readonly string[]).toContain(needed)
    }
  })
})

// ── Structural wiring ────────────────────────────────────────────────────────
describe('surfaces enforce the rule server-side', () => {
  const profilePage = readFileSync('app/dashboard/profile/[id]/page.tsx', 'utf8')
  const express = readFileSync('app/api/intro-requests/express-interest/route.ts', 'utf8')
  const company = readFileSync('app/company/[slug]/page.tsx', 'utf8')
  const helper = readFileSync('lib/privacy/canViewerDiscoverMember.ts', 'utf8')

  it('profile page gates BEFORE loading data and 404s on undiscoverable', () => {
    expect(profilePage).toContain('canViewerDiscoverMember(admin, user.id, params.id)')
    expect(profilePage).toMatch(/if \(!\(await canViewerDiscoverMember\(admin, user\.id, params\.id\)\)\) notFound\(\)/)
    // gate appears before the profile select and before listRoles
    const gateIdx = profilePage.indexOf('canViewerDiscoverMember(admin')
    expect(gateIdx).toBeLessThan(profilePage.indexOf('.select(PUBLIC_PROFILE_SELECT)'))
    expect(gateIdx).toBeLessThan(profilePage.indexOf('listRoles(admin'))
    expect(profilePage).toContain('PUBLIC_PROFILE_SELECT')
    expect(profilePage).not.toContain(".select('*')")
  })

  it('express-interest verifies the caller is a participant + drops the full-profile joins', () => {
    expect(express).toContain('isParticipant')
    expect(express).not.toContain('requester:profiles!requester_id(*)')
    expect(express).not.toContain('target:profiles!target_user_id(*)')
  })

  it('company page filters named members + shows an aggregate, no hidden payload', () => {
    expect(company).toContain('discoverableMemberIds(admin, user.id')
    expect(company).toContain('People you know through Andrel')
    expect(company).toContain('members work')
    expect(company).toContain('member works')
    expect(company).toContain('hiddenCount')
  })

  it('the privacy helper imports nothing from scoring/queue/credit modules', () => {
    const imports = helper.split('\n').filter((l) => l.trim().startsWith('import')).join('\n')
    expect(imports).not.toMatch(/generate-recommendations|batch-scoring|lib\/scoring|matching\/|introductions\/queue|credit/)
    // its only dependency is the bidirectional filter helper
    expect(imports).toContain("from '@/lib/db/filters'")
  })
})
