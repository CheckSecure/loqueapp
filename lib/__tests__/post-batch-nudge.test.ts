import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { BATCH_SOURCES, REFERRAL_CAMPAIGN_KEY } from '../referralCampaign/postBatchNudge'

const MOD = readFileSync('lib/referralCampaign/postBatchNudge.ts', 'utf8')
const CRON = readFileSync('app/api/cron/engagement-reminders/route.ts', 'utf8')
const NOTIFY = readFileSync('app/api/admin/referral-campaign/notify/route.ts', 'utf8')

describe('the trigger is durable', () => {
  it('reads member_pairs, not a card', () => {
    // intro_requests moves to passed/expired/matched the moment a member acts, so it answers
    // "do they have a card", not "have they ever received an introduction".
    expect(MOD).toContain(".from('member_pairs')")
    expect(MOD).not.toContain(".from('intro_requests')")
  })

  it('uses first_recommended_at and tolerates it being null', () => {
    expect(MOD).toContain('first_recommended_at')
    expect(MOD).toContain('p.first_recommended_at ?? p.created_at')
  })

  it('counts only curated batch sources', () => {
    expect(BATCH_SOURCES).toEqual(['weekly', 'admin'])
    // 'onboarding' pairs are generated at signup, so gating on them would be barely different
    // from gating on signup — the opposite of "let them see it work first".
    expect(BATCH_SOURCES as readonly string[]).not.toContain('onboarding')
  })
})

describe('members holding unactioned cards', () => {
  it('are skipped by default, using the DB authority not a local predicate', () => {
    expect(MOD).toContain('const skipUnactioned = opts.skipUnactioned !== false')
    expect(MOD).toContain('countUnresolvedRecommendations(admin, m.id)')
  })

  it('are reported rather than silently dropped, so the rule has a measurable cost', () => {
    expect(MOD).toContain("verdict: 'holding_unactioned_cards'")
    expect(MOD).toContain('holdingUnactionedCards')
  })
})

describe('one campaign, two triggers', () => {
  it('shares the manual broadcast key exactly', () => {
    expect(REFERRAL_CAMPAIGN_KEY).toBe('referral_campaign_2026_09')
    expect(NOTIFY).toContain("const CAMPAIGN_KEY = 'referral_campaign_2026_09'")
  })

  it('passes it as the top-level dedupeKey', () => {
    // Migration 006's unique index has NO time window, so a member notified by the manual run is
    // permanently ineligible here — and vice versa.
    expect(MOD).toContain('dedupeKey: REFERRAL_CAMPAIGN_KEY')
  })
})

describe('placement in the daily cron', () => {
  it('runs inside engagement-reminders rather than a new scheduled function', () => {
    expect(CRON).toContain('runPostBatchReferralNudge(admin)')
  })

  it('cannot break the reminders the cron exists for', () => {
    const call = CRON.indexOf('runPostBatchReferralNudge(admin)')
    const guard = CRON.lastIndexOf('try {', call)
    expect(guard).toBeGreaterThan(-1)
    expect(CRON).toContain('referral nudge failed (non-blocking)')
  })

  it('reports what it did in the cron summary', () => {
    expect(CRON).toContain('referral notified:${referralNudge.notified}')
  })
})

describe('inspection before it fires', () => {
  it('the notify route exposes the post_batch cohort read-only', () => {
    expect(NOTIFY).toContain("body.mode === 'post_batch'")
    expect(NOTIFY).toContain('selectPostBatchNudgeTargets(')
    // Read-only regardless of `action` — the automatic version is driven by the cron.
    const modeBlock = NOTIFY.slice(NOTIFY.indexOf("body.mode === 'post_batch'"))
    expect(modeBlock.slice(0, 600)).toContain("mode: 'dry_run'")
  })
})
