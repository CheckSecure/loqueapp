import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Covers the one-time referral campaign end to end against a mocked profiles store:
 *   • eligibility filtering (active/onboarding/email/test-demo/admin-operator/opted-out/already-sent)
 *   • idempotent dedupe + resume via profiles.referral_campaign_sent_at
 *   • the send route marks a member sent ONLY after a provider-accepted send
 *   • a failed send leaves the member un-stamped (retried on the next run)
 *   • auth + confirmation gates, and the refuse-until-ALL-required-migrations stop (035 AND 037)
 *   • unsubscribe: opted-out (email_product_updates=false) members are excluded
 * The real eligibility + migration-probe helpers run inside the route (via the mocked
 * admin client), so this is an integration test of the whole path, not just the route.
 */
const h = vi.hoisted(() => ({
  profiles: [] as any[],
  prefs: [] as any[],              // notification_preferences rows
  migration035Missing: false,      // profiles.referral_campaign_sent_at absent
  migration037Missing: false,      // referrals.referrer_consent_to_share absent
  updates: [] as { id: string; payload: any }[],
  emailResults: new Map<string, { success: boolean; error?: string }>(),
  user: { email: 'bizdev91@gmail.com' } as any,
}))

const ABSENT = { data: null, error: { code: '42703', message: 'column does not exist (schema cache)' } }

vi.mock('@/lib/supabase/admin', () => {
  const from = (table: string) => {
    const b: any = { _table: table, _op: 'select', _cols: '', _payload: null, _eqs: [] as any[], _limited: false }
    b.select = (cols: string) => { b._op = 'select'; b._cols = cols || ''; return b }
    b.update = (p: any) => { b._op = 'update'; b._payload = p; return b }
    b.eq = (c: string, v: any) => { b._eqs.push([c, v]); return b }
    b.limit = () => { b._limited = true; return b }
    const exec = async () => {
      if (b._table === 'profiles' && b._op === 'select') {
        const wantsDedupe = b._cols.includes('referral_campaign_sent_at')
        if (b._limited) return (wantsDedupe && h.migration035Missing) ? ABSENT : { data: [], error: null } // 035 probe
        if (wantsDedupe && h.migration035Missing) return ABSENT                                             // eligibility read
        return { data: h.profiles, error: null }
      }
      if (b._table === 'profiles' && b._op === 'update') {
        const id = (b._eqs.find((e: any[]) => e[0] === 'id') || [])[1]
        h.updates.push({ id, payload: b._payload })
        return { data: null, error: null }
      }
      if (b._table === 'referrals' && b._op === 'select' && b._limited) { // 037 probe
        return (b._cols.includes('referrer_consent_to_share') && h.migration037Missing) ? ABSENT : { data: [], error: null }
      }
      if (b._table === 'notification_preferences' && b._op === 'select') {
        return { data: h.prefs, error: null }
      }
      return { data: null, error: null }
    }
    b.then = (res: any, rej: any) => exec().then(res, rej)
    return b
  }
  return { createAdminClient: () => ({ from }) }
})

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}))

vi.mock('@/lib/email', () => ({
  sendReferralRequestEmail: vi.fn(async (email: string) => h.emailResults.get(email) ?? { success: true }),
}))

vi.mock('@/lib/analytics/recommendationEvents', () => ({ logRecommendationEvent: vi.fn() }))

import { computeReferralCampaignEligibility } from '@/lib/referralCampaign/eligibility'
import { POST as SEND } from '@/app/api/admin/referral-campaign/send/route'
import { sendReferralRequestEmail } from '@/lib/email'
import { buildRecommendationIntroEmail } from '@/lib/email/recommendationIntro'

const member = (over: Partial<any> = {}) => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  email: 'm@x.com', full_name: 'M', account_status: 'active',
  is_test_account: false, is_admin: false, profile_complete: true,
  referral_campaign_sent_at: null, ...over,
})

const sendReq = (body: any) => SEND(new Request('http://x/api/admin/referral-campaign/send', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}))

beforeEach(() => {
  h.profiles = []
  h.prefs = []
  h.migration035Missing = false
  h.migration037Missing = false
  h.updates = []
  h.emailResults = new Map()
  h.user = { email: 'bizdev91@gmail.com' }
  ;(sendReferralRequestEmail as any).mockClear()
})

describe('referral campaign — eligibility filtering', () => {
  it('includes only active, onboarded, valid-email, non-test, non-admin, non-opted-out, un-sent members', async () => {
    h.profiles = [
      member({ id: 'ok1', email: 'a@x.com' }),
      member({ id: 'ok2', email: 'b@x.com' }),
      member({ id: 'deact', email: 'c@x.com', account_status: 'deactivated' }),
      member({ id: 'test', email: 'd@x.com', is_test_account: true }),
      member({ id: 'admin', email: 'e@x.com', is_admin: true }),
      member({ id: 'operator', email: 'bizdev91@gmail.com' }),
      member({ id: 'onboarding', email: 'f@x.com', profile_complete: false }),
      member({ id: 'bademail', email: 'not-an-email' }),
      member({ id: 'noemail', email: '' }),
      member({ id: 'optout', email: 'h@x.com' }),
      member({ id: 'sent', email: 'g@x.com', referral_campaign_sent_at: '2026-01-01T00:00:00Z' }),
    ]
    h.prefs = [{ user_id: 'optout', email_product_updates: false }]
    const { eligible, breakdown, dedupeColumnPresent } = await computeReferralCampaignEligibility()
    expect(dedupeColumnPresent).toBe(true)
    expect(eligible.map((e) => e.id).sort()).toEqual(['ok1', 'ok2'])
    expect(breakdown).toMatchObject({
      totalProfiles: 11,
      activeMembers: 10,
      eligible: 2,
      excludedDeactivated: 1,
      excludedTestDemo: 1,
      excludedAdminOperator: 2,
      excludedOnboarding: 1,
      excludedInvalidEmail: 2,
      excludedOptedOut: 1,
      alreadySent: 1,
    })
  })

  it('fails open when the dedupe column is not migrated (treats all as un-sent)', async () => {
    h.migration035Missing = true
    h.profiles = [member({ id: 'ok1', email: 'a@x.com' })]
    const { eligible, dedupeColumnPresent } = await computeReferralCampaignEligibility()
    expect(dedupeColumnPresent).toBe(false)
    expect(eligible.map((e) => e.id)).toEqual(['ok1'])
  })

  it('fails open on unsubscribe read (no notification_preferences) — nobody excluded', async () => {
    h.profiles = [member({ id: 'ok1', email: 'a@x.com' })]
    h.prefs = [] // table empty / not applied
    const { breakdown } = await computeReferralCampaignEligibility()
    expect(breakdown.excludedOptedOut).toBe(0)
    expect(breakdown.eligible).toBe(1)
  })
})

describe('referral campaign — send route', () => {
  it('rejects non-operator callers', async () => {
    h.user = { email: 'someone@else.com' }
    expect((await sendReq({ confirmation: 'SEND' })).status).toBe(401)
  })

  it('requires the exact SEND confirmation', async () => {
    const res = await sendReq({ confirmation: 'nope' })
    expect(res.status).toBe(400)
    expect(sendReferralRequestEmail).not.toHaveBeenCalled()
  })

  it('refuses to send when the dedupe migration (035) is not applied', async () => {
    h.migration035Missing = true
    h.profiles = [member({ id: 'ok1', email: 'a@x.com' })]
    const res = await sendReq({ confirmation: 'SEND' })
    const data = await res.json()
    expect(res.status).toBe(409)
    expect(data.missingMigrations).toContain('035_profiles_referral_campaign_sent.sql')
    expect(sendReferralRequestEmail).not.toHaveBeenCalled()
    expect(h.updates).toHaveLength(0)
  })

  it('refuses to send when the consent migration (037) is not applied (not just 035)', async () => {
    h.migration037Missing = true
    h.profiles = [member({ id: 'ok1', email: 'a@x.com' })]
    const res = await sendReq({ confirmation: 'SEND' })
    const data = await res.json()
    expect(res.status).toBe(409)
    expect(data.missingMigrations).toContain('037_referrals_referrer_consent.sql')
    expect(sendReferralRequestEmail).not.toHaveBeenCalled()
  })

  it('sends to every eligible member and stamps referral_campaign_sent_at only on success', async () => {
    h.profiles = [member({ id: 'ok1', email: 'a@x.com' }), member({ id: 'ok2', email: 'b@x.com' })]
    const res = await sendReq({ confirmation: 'SEND' })
    const data = await res.json()
    expect(data).toMatchObject({ attempted: 2, sent: 2, failed: 0 })
    expect(h.updates.map((u) => u.id).sort()).toEqual(['ok1', 'ok2'])
    expect(h.updates.every((u) => typeof u.payload.referral_campaign_sent_at === 'string')).toBe(true)
  })

  it('a failed send does NOT stamp the member (retried next run)', async () => {
    h.profiles = [member({ id: 'ok1', email: 'a@x.com' }), member({ id: 'bad', email: 'b@x.com' })]
    h.emailResults.set('b@x.com', { success: false, error: 'resend rejected' })
    const res = await sendReq({ confirmation: 'SEND' })
    const data = await res.json()
    expect(data).toMatchObject({ attempted: 2, sent: 1, failed: 1 })
    expect(h.updates.map((u) => u.id)).toEqual(['ok1']) // 'bad' NOT stamped
  })

  it('is resumable/idempotent: once stamped, a re-run targets nobody', async () => {
    h.profiles = [member({ id: 'ok1', email: 'a@x.com' })]
    await sendReq({ confirmation: 'SEND' })
    expect(h.updates.map((u) => u.id)).toEqual(['ok1'])
    h.profiles[0].referral_campaign_sent_at = h.updates[0].payload.referral_campaign_sent_at
    ;(sendReferralRequestEmail as any).mockClear()
    const res2 = await sendReq({ confirmation: 'SEND' })
    expect((await res2.json())).toMatchObject({ attempted: 0, sent: 0 })
    expect(sendReferralRequestEmail).not.toHaveBeenCalled()
  })

  it('excludes an unsubscribed member (email_product_updates=false) from the send', async () => {
    h.profiles = [member({ id: 'ok1', email: 'a@x.com' }), member({ id: 'off', email: 'b@x.com' })]
    h.prefs = [{ user_id: 'off', email_product_updates: false }]
    const res = await sendReq({ confirmation: 'SEND' })
    expect((await res.json())).toMatchObject({ attempted: 1, sent: 1 })
    expect(h.updates.map((u) => u.id)).toEqual(['ok1'])
  })
})

describe('campaign email copy, unsubscribe + consent gate (structural)', () => {
  const email = readFileSync('lib/email.ts', 'utf8')
  const adminClient = readFileSync('components/AdminWaitlistClient.tsx', 'utf8')
  const sendInvite = readFileSync('app/api/admin/send-invite/route.ts', 'utf8')
  const sendRec = readFileSync('app/api/admin/send-recommendation-email/route.ts', 'utf8')

  it('the campaign email carries the approved copy, subject, and CTA', () => {
    expect(email).toContain("Who should be in this room?")
    expect(email).toContain('Andrel grows by judgment rather than volume')
    expect(email).toContain('If someone comes to mind, I\'d love to hear who.')
    expect(email).toContain('Every recommendation is personally reviewed before any invitation goes out.')
    expect(email).toContain("If you choose to allow it, we'll mention that you recommended them. Otherwise your recommendation remains private.")
    expect(email).toContain('Thank you for helping shape this.')
    expect(email).toContain('/dashboard/recommend-member')
    expect(email).toMatch(/>\s*Recommend someone\s*</)
  })

  it('the campaign email unsubscribes through the shared one-click sender', () => {
    // This assertion USED to check for an inline List-Unsubscribe header and a hand-rolled footer
    // pointing at /dashboard/settings. Both were removed deliberately: the header lacked
    // List-Unsubscribe-Post, and a login-gated URL is unactionable for a gateway probe. The header
    // and footer now come from sendManaged() for every send, and are covered in depth by
    // lib/__tests__/unsubscribe-headers.test.ts. What this test still owns is that the campaign
    // email did not opt OUT of that shared path.
    expect(email).toMatch(/await sendManaged\(\{\s*\n\s*unsubscribeCategory: 'email_product_updates'/)
    expect(email).not.toContain("'List-Unsubscribe':")   // no inline header may come back
  })

  it('the admin review interface surfaces the nominee LinkedIn profile when present', () => {
    expect(adminClient).toContain('linkedin_url')
    expect(adminClient).toMatch(/href=\{entry\.linkedin_url\}/)
  })

  it('both invite flows read consent and only name the referrer when it is true', () => {
    expect(sendInvite).toContain('referrer_consent_to_share')
    expect(sendInvite).toMatch(/referrer_consent_to_share === true/)
    expect(sendRec).toContain('referrer_consent_to_share')
    expect(sendRec).toMatch(/referrerConsented \? /)
  })
})

describe('warm recommendation email — anonymity guarantee (no consent → no name)', () => {
  it('omits the referrer entirely when the name is blank (the no-consent path passes "")', () => {
    const anon = buildRecommendationIntroEmail({ recommenderName: '', nomineeName: 'Sarah Lee', manageUrl: 'https://x/y' })
    expect(anon.subject).toBe('A founding member of Andrel recommended you')
    expect(anon.text).toContain('A founding member of Andrel recommended you for consideration')
  })

  it('names the referrer only when a name is supplied (the consented path)', () => {
    const named = buildRecommendationIntroEmail({ recommenderName: 'Jane Smith', nomineeName: 'Sarah Lee', manageUrl: 'https://x/y' })
    expect(named.subject).toBe('Jane Smith recommended you')
    expect(named.text).toContain('Jane Smith, a founding member of Andrel, recommended you')
  })
})
