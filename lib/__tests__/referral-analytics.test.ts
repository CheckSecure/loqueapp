import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Read-only referral-campaign analytics: after-send attribution vs all-time,
 * internal exclusion + toggle, invitation (waitlist.invited_at) & activation
 * derivation, zero-sent safety, median timing, and CSV/toggle parity.
 */
const h = vi.hoisted(() => ({
  profiles: [] as any[],
  referrals: [] as any[],
  waitlist: [] as any[],
  prefs: [] as any[],
  user: { email: 'bizdev91@gmail.com' } as any,
}))

vi.mock('@/lib/supabase/admin', () => {
  const from = (t: string) => {
    const b: any = { _t: t }
    b.select = () => b; b.eq = () => b; b.in = () => b; b.not = () => b; b.is = () => b
    const exec = async () => {
      if (t === 'profiles') return { data: h.profiles, error: null }
      if (t === 'referrals') return { data: h.referrals, error: null }
      if (t === 'waitlist') return { data: h.waitlist, error: null }
      if (t === 'notification_preferences') return { data: h.prefs, error: null }
      return { data: [], error: null }
    }
    b.then = (res: any, rej: any) => exec().then(res, rej)
    return b
  }
  return { createAdminClient: () => ({ from }) }
})

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}))

import { computeCampaignAnalytics } from '@/lib/referralCampaign/analytics'
import { GET } from '@/app/api/admin/referral-campaign/analytics/route'

const SENT = '2026-06-01T00:00:00Z'
const prof = (o: any) => ({
  id: o.id, email: o.email ?? `${o.id}@x.com`, full_name: o.full_name ?? o.id, account_status: 'active',
  is_test_account: !!o.is_test_account, is_admin: !!o.is_admin, profile_complete: true,
  referral_campaign_sent_at: 'sent_at' in o ? o.sent_at : SENT,
})
const ref = (o: any) => ({
  id: o.id ?? Math.random().toString(36).slice(2), referrer_user_id: o.referrer, waitlist_id: o.wl,
  status: o.status ?? 'pending', created_at: o.created, activated_at: o.activated_at ?? null,
})
const wl = (id: string, invited: boolean) => ({ id, invited_at: invited ? '2026-06-30T00:00:00Z' : null })

beforeEach(() => { h.profiles = []; h.referrals = []; h.waitlist = []; h.prefs = []; h.user = { email: 'bizdev91@gmail.com' } })

describe('campaign-attributed vs all-time attribution', () => {
  it('counts only recs AFTER the send date as campaign-attributed; pre-campaign recs count all-time only', async () => {
    h.profiles = [prof({ id: 'm1', sent_at: SENT })]
    h.referrals = [
      ref({ referrer: 'm1', wl: 'wA', created: '2026-06-10T00:00:00Z' }), // after → campaign
      ref({ referrer: 'm1', wl: 'wB', created: '2026-05-01T00:00:00Z' }), // before → all-time only
    ]
    h.waitlist = [wl('wA', true), wl('wB', false)]
    const a = await computeCampaignAnalytics()
    expect(a.summary.campaignAttributedRecommendations).toBe(1)
    expect(a.summary.allTimeRecommendations).toBe(2)
    const m = a.members.find((x) => x.id === 'm1')!
    expect(m.campaignRecCount).toBe(1)
    expect(m.allTimeRecCount).toBe(2)
    expect(m.firstCampaignRecAt).toBe('2026-06-10T00:00:00Z')
    expect(m.latestRecAt).toBe('2026-06-10T00:00:00Z') // latest of both is the June one
  })
})

describe('internal exclusion + toggle', () => {
  const setup = () => {
    h.profiles = [
      prof({ id: 'm1' }),
      prof({ id: 'op', email: 'bizdev91@gmail.com', is_admin: true }),
      prof({ id: 'tst', is_test_account: true }),
    ]
    h.referrals = [
      ref({ referrer: 'm1', wl: 'w1', created: '2026-06-10T00:00:00Z' }),
      ref({ referrer: 'op', wl: 'w2', created: '2026-06-10T00:00:00Z' }),
      ref({ referrer: 'tst', wl: 'w3', created: '2026-06-10T00:00:00Z' }),
    ]
    h.waitlist = [wl('w1', true), wl('w2', true), wl('w3', true)]
  }
  it('excludes operator/admin/test by default', async () => {
    setup()
    const a = await computeCampaignAnalytics()
    expect(a.summary.allTimeRecommendations).toBe(1)
    expect(a.members.map((m) => m.id)).toEqual(['m1'])
  })
  it('includes them when includeInternal is set (diagnostic)', async () => {
    setup()
    const a = await computeCampaignAnalytics({ includeInternal: true })
    expect(a.summary.allTimeRecommendations).toBe(3)
    expect(a.members.map((m) => m.id).sort()).toEqual(['m1', 'op', 'tst'])
  })
})

describe('invitation & activation derivation', () => {
  it('invitation is derived from waitlist.invited_at, NOT referral.status', async () => {
    h.profiles = [prof({ id: 'm1' })]
    h.referrals = [
      ref({ referrer: 'm1', wl: 'wInvitedStatusOnly', status: 'invited', created: '2026-06-10T00:00:00Z' }),
      ref({ referrer: 'm1', wl: 'wPendingButInvited', status: 'pending', created: '2026-06-11T00:00:00Z' }),
    ]
    h.waitlist = [wl('wInvitedStatusOnly', false), wl('wPendingButInvited', true)]
    const a = await computeCampaignAnalytics()
    // Only the row whose waitlist.invited_at is set counts — the status='invited' row does NOT.
    expect(a.summary.invitationsFromCampaign).toBe(1)
    expect(a.members[0].campaignInvitations).toBe(1)
  })

  it('activation counts status=activated OR activated_at set', async () => {
    h.profiles = [prof({ id: 'm1' })]
    h.referrals = [
      ref({ referrer: 'm1', wl: 'wA', status: 'activated', created: '2026-06-10T00:00:00Z' }),                    // status path
      ref({ referrer: 'm1', wl: 'wB', status: 'invited', activated_at: '2026-06-15T00:00:00Z', created: '2026-06-11T00:00:00Z' }), // activated_at path
      ref({ referrer: 'm1', wl: 'wC', status: 'invited', created: '2026-06-12T00:00:00Z' }),                      // neither
    ]
    h.waitlist = [wl('wA', true), wl('wB', true), wl('wC', true)]
    const a = await computeCampaignAnalytics()
    expect(a.summary.activatedFromCampaign).toBe(2)
    expect(a.members[0].campaignActivations).toBe(2)
  })
})

describe('zero-sent state', () => {
  it('renders n/a (null) safely, never 0% or NaN — all-time still counts', async () => {
    h.profiles = [prof({ id: 'm1', sent_at: null })]
    h.referrals = [ref({ referrer: 'm1', wl: 'wA', created: '2026-06-10T00:00:00Z' })]
    h.waitlist = [wl('wA', true)]
    const a = await computeCampaignAnalytics()
    expect(a.funnel.available).toBe(false)
    expect(a.funnel.pct).toEqual({ recommended: null, invited: null, joined: null })
    expect(a.derived.participationRate).toBeNull()
    expect(a.derived.avgCampaignRecsPerParticipant).toBeNull()
    expect(a.derived.medianDaysToFirstRec).toBeNull()
    expect(a.summary.allTimeRecommendations).toBe(1) // all-time unaffected
  })
})

describe('derived metrics', () => {
  it('median days from campaign email to first recommendation (even count → average of middle two)', async () => {
    h.profiles = [prof({ id: 'm1', sent_at: SENT }), prof({ id: 'm2', sent_at: SENT })]
    h.referrals = [
      ref({ referrer: 'm1', wl: 'wA', created: '2026-06-05T00:00:00Z' }), // 4 days
      ref({ referrer: 'm2', wl: 'wB', created: '2026-06-11T00:00:00Z' }), // 10 days
    ]
    h.waitlist = [wl('wA', true), wl('wB', true)]
    const a = await computeCampaignAnalytics()
    expect(a.derived.medianDaysToFirstRec).toBe(7) // (4 + 10) / 2
    expect(a.summary.campaignParticipants).toBe(2)
    expect(a.derived.avgCampaignRecsPerParticipant).toBe(1)
  })

  it('counts members with multiple (≥2) recommendations', async () => {
    h.profiles = [prof({ id: 'm1' }), prof({ id: 'm2' })]
    h.referrals = [
      ref({ referrer: 'm1', wl: 'wA', created: '2026-06-05T00:00:00Z' }),
      ref({ referrer: 'm1', wl: 'wB', created: '2026-06-06T00:00:00Z' }),
      ref({ referrer: 'm2', wl: 'wC', created: '2026-06-05T00:00:00Z' }),
    ]
    h.waitlist = [wl('wA', true), wl('wB', true), wl('wC', true)]
    const a = await computeCampaignAnalytics()
    expect(a.summary.membersWithMultipleRecommendations).toBe(1) // m1 only
  })
})

describe('CSV export matches the active internal/test filter', () => {
  beforeEach(() => {
    h.profiles = [prof({ id: 'm1', email: 'alice@x.com', full_name: 'Alice' }), prof({ id: 'op', email: 'bizdev91@gmail.com', is_admin: true })]
    h.referrals = [ref({ referrer: 'm1', wl: 'wA', created: '2026-06-10T00:00:00Z' }), ref({ referrer: 'op', wl: 'wB', created: '2026-06-10T00:00:00Z' })]
    h.waitlist = [wl('wA', true), wl('wB', true)]
  })
  it('default CSV excludes internal accounts', async () => {
    const res = await GET(new Request('http://x/api/admin/referral-campaign/analytics?format=csv'))
    const csv = await res.text()
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(csv).toContain('alice@x.com')
    expect(csv).not.toContain('bizdev91@gmail.com')
  })
  it('include=internal CSV includes internal accounts', async () => {
    const res = await GET(new Request('http://x/api/admin/referral-campaign/analytics?format=csv&include=internal'))
    const csv = await res.text()
    expect(csv).toContain('alice@x.com')
    expect(csv).toContain('bizdev91@gmail.com')
  })
  it('rejects non-operator callers', async () => {
    h.user = { email: 'nope@x.com' }
    expect((await GET(new Request('http://x/api/admin/referral-campaign/analytics'))).status).toBe(401)
  })
})
