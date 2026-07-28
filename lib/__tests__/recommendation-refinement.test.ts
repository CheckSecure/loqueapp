import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildRecommendationIntroEmail, firstNameOf } from '@/lib/email/recommendationIntro'
import { checkNomineeDuplicates } from '@/lib/referrals/duplicateCheck'
import { makeManageToken, verifyManageToken } from '@/lib/referrals/manageToken'

// ── Delete-route mock (hoisted) ───────────────────────────────────────────────
const h = vi.hoisted(() => ({ deletes: [] as { table: string; col: string; val: string }[], failTable: '' as string }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      delete: () => ({
        eq: async (col: string, val: string) => {
          h.deletes.push({ table, col, val })
          return { error: h.failTable === table ? { message: 'fail' } : null }
        },
      }),
    }),
  }),
}))
import { POST as manageDeletePOST } from '@/app/api/manage-information/delete/route'

beforeEach(() => { h.deletes.length = 0; h.failTable = ''; process.env.MANAGE_INFO_SECRET = 'test-secret' })

// ==============================================================================
// 1. Email
// ==============================================================================
describe('recommendation introduction email', () => {
  const email = buildRecommendationIntroEmail({
    recommenderName: 'Jane Chen',
    nomineeName: 'Sarah Okafor',
    manageUrl: 'https://www.andrel.app/manage-information?token=abc',
  })

  it('subject uses the recommender name dynamically', () => {
    expect(email.subject).toBe('Jane Chen recommended you')
  })
  it('greets the nominee by first name', () => {
    expect(email.text).toContain('Hello Sarah,')
    expect(firstNameOf('Sarah Okafor')).toBe('Sarah')
    expect(firstNameOf('')).toBe('there')
  })
  it('names the recommender in the body', () => {
    expect(email.text).toContain('Jane Chen, a founding member of Andrel')
  })
  it('contains NO password / login / credentials / signup / button content', () => {
    const t = email.text.toLowerCase()
    expect(t).not.toContain('password')
    expect(t).not.toContain('log in')
    expect(t).not.toContain('login')
    expect(t).not.toContain('sign up')
    expect(t).not.toContain('signup')
    expect(t).not.toContain('button')
    expect(t).not.toContain('temporary')
  })
  it('has a reply-based CTA', () => {
    expect(email.text.toLowerCase()).toContain('reply to this email')
  })
  it('includes the privacy manage-information link', () => {
    expect(email.text).toContain('Manage your information here:')
    expect(email.text).toContain('https://www.andrel.app/manage-information?token=abc')
  })
  it('falls back gracefully when the recommender name is blank', () => {
    const e = buildRecommendationIntroEmail({ recommenderName: '', nomineeName: 'Sarah', manageUrl: 'x' })
    expect(e.subject).toBe('A founding member recommended you')
  })
})

// ==============================================================================
// 2. Duplicate handling
// ==============================================================================
function mockAdmin(cfg: any) {
  return {
    auth: { admin: { listUsers: async () => ({ data: { users: cfg.authUsers ?? [] } }) } },
    from(table: string) {
      const b: any = {
        select: () => b, ilike: () => b, neq: () => b, in: () => b, eq: () => b,
        maybeSingle: async () => ({ data: cfg[table]?.single ?? null }),
        then: (res: any) => Promise.resolve({ data: cfg[table]?.list ?? [] }).then(res),
      }
      return b
    },
  }
}

describe('checkNomineeDuplicates', () => {
  it('blocks an existing active member (not overridable)', async () => {
    const r = await checkNomineeDuplicates(mockAdmin({ profiles: { single: { id: 'm1' } } }), 'x@y.com', 'self')
    expect(r.blocked).toBe(true)
    expect(r.code).toBe('ALREADY_MEMBER')
    expect(r.overridable).toBe(false)
  })

  it('blocks an already-invited nominee (overridable, stale outreach)', async () => {
    const r = await checkNomineeDuplicates(
      mockAdmin({ waitlist: { list: [{ id: 'other', status: 'invited', invited_at: '2026-03-12T12:00:00Z' }] } }),
      'x@y.com', 'self',
    )
    expect(r.code).toBe('ALREADY_INVITED')
    expect(r.overridable).toBe(true)
    expect(r.reason).toMatch(/Already invited on March 12, 2026/)
  })

  it('detects a duplicate recommendation by another member', async () => {
    const r = await checkNomineeDuplicates(
      mockAdmin({
        waitlist: { list: [{ id: 'w2', status: 'pending' }] },
        referrals: { list: [{ status: 'pending', referrer: { full_name: 'John Smith' } }] },
      }),
      'x@y.com', 'self',
    )
    expect(r.code).toBe('DUPLICATE_RECOMMENDATION')
    expect(r.reason).toBe('Previously recommended by John Smith')
    expect(r.overridable).toBe(true)
  })

  it('flags a previously-declined nominee as override-with-reason', async () => {
    const r = await checkNomineeDuplicates(
      mockAdmin({
        waitlist: { list: [{ id: 'w2', status: 'declined' }] },
        referrals: { list: [{ status: 'rejected', rejected_at: '2026-02-01T00:00:00Z' }] },
      }),
      'x@y.com', 'self',
    )
    expect(r.code).toBe('PREVIOUSLY_DECLINED')
    expect(r.overridable).toBe(true)
    expect(r.requiresReason).toBe(true)
  })

  it('ignores the nominee\'s own waitlist row and returns clear when no conflicts', async () => {
    const r = await checkNomineeDuplicates(
      mockAdmin({ waitlist: { list: [{ id: 'self', status: 'approved' }] } }),
      'x@y.com', 'self',
    )
    expect(r.blocked).toBe(false)
  })
})

// ==============================================================================
// 3. Privacy — token + POST-only deletion
// ==============================================================================
describe('manage-information token', () => {
  it('round-trips a waitlist id', () => {
    const tok = makeManageToken('abc-123')
    expect(verifyManageToken(tok)).toBe('abc-123')
  })
  it('rejects a tampered / malformed token', () => {
    const tok = makeManageToken('abc-123')
    expect(verifyManageToken(tok.slice(0, -3) + 'zzz')).toBeNull()
    expect(verifyManageToken('garbage')).toBeNull()
    expect(verifyManageToken('')).toBeNull()
    expect(verifyManageToken(null)).toBeNull()
  })
})

describe('nominee removal is POST-only and actually deletes', () => {
  it('POST with a valid token deletes referrals then the waitlist row', async () => {
    const token = makeManageToken('wl-9')
    const res = await manageDeletePOST(new Request('http://x/api/manage-information/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    }))
    expect(res.status).toBe(200)
    expect(h.deletes).toEqual([
      { table: 'referrals', col: 'waitlist_id', val: 'wl-9' },
      { table: 'waitlist', col: 'id', val: 'wl-9' },
    ])
  })

  it('POST with an invalid token deletes nothing (400)', async () => {
    const res = await manageDeletePOST(new Request('http://x/api/manage-information/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'bad' }),
    }))
    expect(res.status).toBe(400)
    expect(h.deletes).toHaveLength(0)
  })

  it('the manage page (GET) contains no deletion — deletion lives only in the POST route', () => {
    const page = readFileSync('app/manage-information/page.tsx', 'utf8')
    expect(page).not.toMatch(/\.delete\(\)/)
    expect(page).not.toMatch(/manage-information\/delete/) // GET never calls the delete endpoint
    const route = readFileSync('app/api/manage-information/delete/route.ts', 'utf8')
    expect(route).toMatch(/export async function POST/)
    expect(route).not.toMatch(/export async function GET/)
  })
})

// ==============================================================================
// 4. Status flow: Pending → Approved → Contacted → Invited → Activated
// ==============================================================================
describe('status pipeline stages exist across the flow', () => {
  it('approve sets approved', () => {
    expect(readFileSync('app/api/admin/waitlist/approve/route.ts', 'utf8')).toMatch(/status:\s*'approved'/)
  })
  it('send-recommendation-email sets contacted (+ timestamps)', () => {
    const r = readFileSync('app/api/admin/send-recommendation-email/route.ts', 'utf8')
    expect(r).toMatch(/status:\s*'contacted'/)
    expect(r).toMatch(/recommendation_email_sent_at/)
  })
  it('send-invite sets invited', () => {
    expect(readFileSync('app/api/admin/send-invite/route.ts', 'utf8')).toMatch(/status:\s*'invited'/)
  })
  it('profile complete sets activated', () => {
    expect(readFileSync('app/api/profile/complete/route.ts', 'utf8')).toMatch(/status:\s*'activated'/)
  })
  it('admin UI exposes a Contacted tab between Approved and Invited', () => {
    const ui = readFileSync('components/AdminWaitlistClient.tsx', 'utf8')
    expect(ui).toMatch(/Contacted \(\{counts\.contacted\}\)/)
    expect(ui).toContain("setActiveTab('contacted')")
  })
})
