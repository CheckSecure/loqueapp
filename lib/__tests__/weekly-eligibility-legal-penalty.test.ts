import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { evaluateWeeklyEligibility, weeklyEligibilityCheck } from '@/lib/introductions/queue'
import { legalSameSidePenalty, lawFirmRole, LEGAL_SAME_SIDE_PENALTY, isSameSideLegalPartnerEdge, crossMarketFirstForLawFirm } from '@/lib/matching/legalSameSidePenalty'

/**
 * PART 2 (weekly eligibility) + PART 5/6 (same-side legal penalty) + PART 3/4 wiring.
 */

// ── Fake service-role client: supports the exact query chains the queue reads ──
function fakeClient(data: { intro_requests?: any[]; recommendation_batches?: any[] }) {
  const make = (rows: any[]) => {
    const preds: Array<(r: any) => boolean> = []
    const b: any = {
      select() { return b },
      eq(c: string, v: any) { preds.push(r => r[c] === v); return b },
      in(c: string, vals: any[]) { preds.push(r => vals.includes(r[c])); return b },
      _rows() { return (rows || []).filter(r => preds.every(f => f(r))) },
      maybeSingle() { return Promise.resolve({ data: b._rows()[0] ?? null, error: null }) },
      then(res: any, rej: any) { return Promise.resolve({ data: b._rows(), error: null }).then(res, rej) },
    }
    return b
  }
  return { from: (t: string) => make((data as any)[t] ?? []) }
}

const sug = (r: string, t: string) => ({ requester_id: r, target_user_id: t, status: 'suggested' })
const expressed = (r: string, t: string, status = 'pending') => ({ requester_id: r, target_user_id: t, status })
const batch = (state: string, source: string, id: string) => ({ member_id: 'M', state, batch_source: source, batch_id: id })

// ── PART 2: weekly eligibility ────────────────────────────────────────────────
describe('evaluateWeeklyEligibility (PART 2 permanent rule)', () => {
  it('unresolved active organic batch → ineligible (reason unresolved_active)', async () => {
    const db = fakeClient({ intro_requests: [sug('M', 'T')], recommendation_batches: [batch('active', 'weekly', 'b1')] })
    const e = await evaluateWeeklyEligibility(db as any, 'M')
    expect(e).toEqual({ eligible: false, reason: 'unresolved_active', unresolvedCount: 1, activeBatchId: 'b1' })
  })

  it('member who ACTED on all intros (expressed interest) → eligible', async () => {
    // suggested T, but requester expressed interest in T → resolved → 0 unresolved
    const db = fakeClient({ intro_requests: [sug('M', 'T'), expressed('M', 'T')], recommendation_batches: [batch('active', 'weekly', 'b1')] })
    const e = await evaluateWeeklyEligibility(db as any, 'M')
    expect(e.eligible).toBe(true)
    expect(e.reason).toBe('eligible')
  })

  it('completed previous batch (no suggested rows, no batch) → eligible', async () => {
    const db = fakeClient({ intro_requests: [], recommendation_batches: [] })
    expect((await evaluateWeeklyEligibility(db as any, 'M')).eligible).toBe(true)
  })

  it('behind an incomplete ADMIN reciprocal batch → ineligible (reason behind_admin) — admin behavior preserved', async () => {
    const db = fakeClient({ intro_requests: [sug('M', 'T')], recommendation_batches: [batch('active', 'admin_reciprocal', 'a1')] })
    const e = await evaluateWeeklyEligibility(db as any, 'M')
    expect(e.reason).toBe('behind_admin')
    expect(e.eligible).toBe(false)
    expect(e.activeBatchId).toBe('a1')
  })

  it('lingering queued batch with nothing unresolved → ineligible (reason queued_exists), no reminder', async () => {
    const db = fakeClient({ intro_requests: [], recommendation_batches: [batch('queued', 'weekly', 'q1')] })
    const e = await evaluateWeeklyEligibility(db as any, 'M')
    expect(e.reason).toBe('queued_exists')
    expect(e.unresolvedCount).toBe(0)
  })

  it('weeklyEligibilityCheck delegates to the same decision (boolean)', async () => {
    const unresolved = fakeClient({ intro_requests: [sug('M', 'T')], recommendation_batches: [batch('active', 'weekly', 'b1')] })
    const clean = fakeClient({ intro_requests: [], recommendation_batches: [] })
    expect(await weeklyEligibilityCheck(unresolved as any, 'M')).toBe(false)
    expect(await weeklyEligibilityCheck(clean as any, 'M')).toBe(true)
  })
})

// ── PART 5/6: same-side legal penalty ─────────────────────────────────────────
const P = { role_type: 'Law Firm Partner' }
const A = { role_type: 'Law Firm Attorney' }
const Alegacy = { role_type: 'Law firm attorney' }
const GC = { role_type: 'General Counsel' }
const INHOUSE = { role_type: 'In-House Counsel' }
const GP = { role_type: 'General Partner' } // investor — contains "partner" but NOT a law firm

describe('lawFirmRole classification (role_type only)', () => {
  it('classifies law-firm sides and returns null for everything else', () => {
    expect(lawFirmRole(P)).toBe('partner')
    expect(lawFirmRole(A)).toBe('attorney')
    expect(lawFirmRole(Alegacy)).toBe('attorney')
    expect(lawFirmRole(GC)).toBeNull()
    expect(lawFirmRole(INHOUSE)).toBeNull()
    expect(lawFirmRole(GP)).toBeNull()            // "General Partner" is not a law firm
    expect(lawFirmRole({ role_type: '' })).toBeNull()
    expect(lawFirmRole(undefined)).toBeNull()
  })
})

describe('legalSameSidePenalty values (exact)', () => {
  it('Partner ↔ Partner is the STRONGEST penalty', () => {
    expect(legalSameSidePenalty(P, P)).toBe(-LEGAL_SAME_SIDE_PENALTY.partnerPartner) // -60
  })
  it('Partner ↔ law-firm Attorney/Counsel is a STRONG penalty (symmetric)', () => {
    expect(legalSameSidePenalty(P, A)).toBe(-LEGAL_SAME_SIDE_PENALTY.partnerAttorney) // -45
    expect(legalSameSidePenalty(A, P)).toBe(-LEGAL_SAME_SIDE_PENALTY.partnerAttorney)
  })
  it('law-firm Attorney ↔ law-firm Attorney is penalized', () => {
    expect(legalSameSidePenalty(A, A)).toBe(-LEGAL_SAME_SIDE_PENALTY.attorneyAttorney) // -30
  })
  it('penalty magnitude ordering: partner-partner > partner-attorney > attorney-attorney', () => {
    expect(LEGAL_SAME_SIDE_PENALTY.partnerPartner).toBeGreaterThan(LEGAL_SAME_SIDE_PENALTY.partnerAttorney)
    expect(LEGAL_SAME_SIDE_PENALTY.partnerAttorney).toBeGreaterThan(LEGAL_SAME_SIDE_PENALTY.attorneyAttorney)
  })
  it('CROSS-MARKET legal / corporate pairings receive NO penalty', () => {
    expect(legalSameSidePenalty(P, GC)).toBe(0)
    expect(legalSameSidePenalty(A, INHOUSE)).toBe(0)
    expect(legalSameSidePenalty(P, GP)).toBe(0)       // partner ↔ investor
    expect(legalSameSidePenalty(GC, INHOUSE)).toBe(0) // corporate legal ↔ corporate legal
  })
})

// Pure ranking simulation mirroring how both engines apply the penalty (score += penalty, sort desc, top-N).
function rank(viewer: any, candidates: Array<{ id: string; role_type: string; base: number }>, topN: number) {
  return candidates
    .map(c => ({ ...c, s: c.base + legalSameSidePenalty(viewer, c) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, topN)
}
const isSameSide = (c: any) => lawFirmRole(c) !== null

describe('penalty ranking behavior (PART 5 requirements)', () => {
  it('corporate/in-house alternative OUTRANKS a same-side legal peer', () => {
    const top = rank(P, [{ id: 'att', role_type: 'Law Firm Attorney', base: 70 }, { id: 'gc', role_type: 'General Counsel', base: 65 }], 1)
    expect(top[0].id).toBe('gc') // 65 beats 70-45=25
  })

  it('NO two same-side legal suggestions when a viable cross-market option exists', () => {
    const top = rank(P, [
      { id: 'att1', role_type: 'Law Firm Attorney', base: 80 },
      { id: 'att2', role_type: 'Law Firm Attorney', base: 78 },
      { id: 'gc', role_type: 'General Counsel', base: 60 },
    ], 2)
    const sameSide = top.filter(isSameSide).length
    expect(sameSide).toBeLessThanOrEqual(1)
    expect(top.map(t => t.id)).toContain('gc')
  })

  it('same-side legal pair REMAINS POSSIBLE when there is no acceptable alternative (not a ban)', () => {
    const top = rank(P, [
      { id: 'att1', role_type: 'Law Firm Attorney', base: 80 },
      { id: 'att2', role_type: 'Law Firm Partner', base: 78 },
    ], 2)
    expect(top).toHaveLength(2)
    expect(top.every(isSameSide)).toBe(true) // still returned — penalized, never removed
  })
})

// ── Structural: both engines apply the SAME policy; wiring & emails ────────────
describe('both scoring engines apply the equivalent penalty (structural)', () => {
  const live = readFileSync('lib/generate-recommendations.ts', 'utf8')
  const batchScorer = readFileSync('lib/matching/batch-scoring.ts', 'utf8')
  it('live ranker imports and applies the shared penalty AFTER the relevance gate', () => {
    expect(live).toContain("from '@/lib/matching/legalSameSidePenalty'")
    expect(live).toContain('legalSameSidePenalty(newUserProfile, c)')
    // applied on mentorshipFiltered (post >=10 gate) so it demotes, never bans
    expect(live.indexOf('legalSameSidePenalty(newUserProfile, c)')).toBeGreaterThan(live.indexOf("filter(c => c.finalScore >= 10)"))
  })
  it('batch scoreMatch does NOT apply the penalty (would remove last-resort edges below the relevance gate)', () => {
    expect(batchScorer).not.toContain('score += legalSameSidePenalty')
    // System B enforces cross-market-first in SELECTION (two-pass), not via a score penalty
    expect(batchScorer).toContain('cross-market-first')
  })
})

describe('PART 3 reminder email (structural)', () => {
  const email = readFileSync('lib/email.ts', 'utf8')
  it('exact subject, body, and CTA', () => {
    expect(email).toContain("subject: 'Action needed before your next introductions'")
    expect(email).toContain('You still have introductions waiting for your response.')
    expect(email).toContain('Review them and choose either Interested or Pass.')
    expect(email).toContain("Once you've responded, you'll automatically receive new introductions in the following batch.")
    expect(email).toContain('https://andrel.app/dashboard/introductions')
    expect(email).toContain('Review Introductions')
  })
  it('honors the email preference and returns a result (never throws)', () => {
    const fn = email.slice(email.indexOf('export async function sendPendingIntrosReminderEmail'))
    expect(fn).toContain("isPrefEnabled(toEmail, 'email_new_introductions')")
    expect(fn).toContain('return { success: false, skipped: true }')
    expect(fn).toContain('return { success: true }')
    expect(fn).toContain('catch') // wrapped → never throws
  })
})

describe('PART 4 existing new-batch email + notification UNCHANGED (structural)', () => {
  const email = readFileSync('lib/email.ts', 'utf8')
  const engagement = readFileSync('lib/notifications/engagement.ts', 'utf8')
  it('sendNewBatchEmail subject and new_batch notification type still present', () => {
    expect(email).toContain("subject: 'New introductions waiting for you'")
    expect(engagement).toContain("type: 'new_batch'")
  })
})

describe('PART 3 notification wiring + PART 2 cron (structural)', () => {
  const engagement = readFileSync('lib/notifications/engagement.ts', 'utf8')
  const cron = readFileSync('app/api/cron/weekly-refresh/route.ts', 'utf8')

  it('notifyPendingIntrosActionNeeded creates the in-app notification + sends the reminder, best-effort', () => {
    expect(engagement).toContain('export async function notifyPendingIntrosActionNeeded')
    expect(engagement).toContain("type: 'introductions_waiting'")
    expect(engagement).toContain('actionneeded:')
    expect(engagement).toContain('sendPendingIntrosReminderEmail')
    const fn = engagement.slice(engagement.indexOf('notifyPendingIntrosActionNeeded'))
    expect(fn).toContain('catch') // never throws
  })

  it('weekly cron: durable per-cycle reminder, only for unresolved skips, and NO generation on skip', () => {
    expect(cron).toContain('evaluateWeeklyEligibility')
    expect(cron).toContain('const cycleKey = isoWeekKey(new Date())')          // durable cycle id
    expect(cron).toContain('notifyPendingIntrosActionNeeded(user.id, elig.activeBatchId, cycleKey)')
    expect(cron).toContain('const reminded = new Set<string>()')               // cheap intra-run guard
    // reminder gated on unresolvedCount > 0
    expect(cron).toContain('if (elig.unresolvedCount > 0)')
    // generation only happens AFTER the eligibility check passes (never in the skip branch)
    const skipIdx = cron.indexOf('notifyPendingIntrosActionNeeded')
    const genIdx = cron.indexOf('generateReciprocalBatchForMember(user.id')
    expect(genIdx).toBeGreaterThan(skipIdx)
    expect(cron).toContain('reminderSent')
    expect(cron).toContain('reminderAlreadyHandled')
    expect(cron).toContain('reminderFailed')
  })

  it('reminder failure cannot create or alter a batch (skip branch continues before generation)', () => {
    // the skip branch ends in `continue`, so a reminder result never reaches generateBatchForMember
    const skipBlock = cron.slice(cron.indexOf('if (!elig.eligible)'), cron.indexOf('const result = await generateBatchForMember'))
    expect(skipBlock).toContain('continue')
    expect(skipBlock).not.toContain('generateBatchForMember')
  })
})

// ── Cross-market-first partition (issue #2) ────────────────────────────────────
describe('crossMarketFirstForLawFirm + isSameSideLegalPartnerEdge', () => {
  const partner = { role_type: 'Law Firm Partner' }
  const attorney = { role_type: 'Law Firm Attorney' }
  const gc = { id: 'gc', role_type: 'General Counsel' }
  const clo = { id: 'clo', role_type: 'Chief Legal Officer' }
  const lfa = { id: 'lfa', role_type: 'Law Firm Attorney' }
  const lfp = { id: 'lfp', role_type: 'Law Firm Partner' }

  it('isSameSideLegalPartnerEdge covers partner↔partner AND partner↔attorney, not attorney↔attorney or cross-market', () => {
    expect(isSameSideLegalPartnerEdge(partner, partner)).toBe(true)
    expect(isSameSideLegalPartnerEdge(partner, attorney)).toBe(true)
    expect(isSameSideLegalPartnerEdge(attorney, attorney)).toBe(false) // no partner involved
    expect(isSameSideLegalPartnerEdge(partner, gc)).toBe(false)        // cross-market
  })

  it('A: ≥2 cross-market → 0 same-side in top 2', () => {
    const top2 = crossMarketFirstForLawFirm([lfa, lfp, gc, clo], partner).slice(0, 2)
    expect(top2.map((c: any) => c.id)).toEqual(['gc', 'clo'])
  })
  it('B: exactly 1 cross-market → cross-market first, one same-side fills slot 2', () => {
    const top2 = crossMarketFirstForLawFirm([lfa, gc], partner).slice(0, 2)
    expect(top2.map((c: any) => c.id)).toEqual(['gc', 'lfa'])
  })
  it('C: 0 cross-market → same-side used as fallback (not banned)', () => {
    const top2 = crossMarketFirstForLawFirm([lfa, lfp], partner).slice(0, 2)
    expect(top2).toHaveLength(2)
  })
  it('non-law-firm recipient is returned unchanged', () => {
    const arr = [lfa, gc, lfp]
    expect(crossMarketFirstForLawFirm(arr, gc)).toBe(arr)
  })
})

// ── Both generation systems aligned + versioning (issue #6/#7) ─────────────────
describe('both member-facing generators apply cross-market-first + versions bumped', () => {
  const live = readFileSync('lib/generate-recommendations.ts', 'utf8')
  const batchRoute = readFileSync('app/api/admin/generate-batch/route.ts', 'utf8')
  const batchScorer = readFileSync('lib/matching/batch-scoring.ts', 'utf8')

  it('System A composition delegates to the shared cross-market-first helper', () => {
    expect(live).toContain('crossMarketFirstForLawFirm(candidates, viewer)')
  })
  it('System B expresses cross-market-first as a BOUNDED penalty, not a selection exclusion', () => {
    // The two-pass exclusion (build without same-side partner edges, then re-add them as a
    // fallback) is gone. It could not coexist with a global optimizer: excluding edges before
    // selection removes them from the graph the optimizer is meant to reason over.
    //
    // The preference now lives inside the optimizer's QUALITY term, using the same authoritative
    // legalSameSidePenalty, applied once per direction. That keeps it bounded — at most 120 mutual
    // points for partner<->partner — so a materially stronger same-side match can still win, while
    // an equally strong cross-market match always beats a same-side one.
    expect(batchRoute).toContain("from '@/lib/matching/legalSameSidePenalty'")
    // Calibrated to the MEASURED distribution rather than reusing the shared penalty at full
    // strength: at -120 per edge the crossover sits at +121 mutual points, outside the observed
    // 62..166 range, which would make a near-best same-side match unwinnable on quality.
    expect(batchRoute).toContain('crossMarketAdjustment(lawFirmRole)')
    // and the shared helper is NOT modified — the weekly ranker keeps its own behaviour
    expect(readFileSync('lib/matching/legalSameSidePenalty.ts', 'utf8'))
      .toMatch(/partnerPartner: 60/)
    // Crucially: the relevance floor is applied to the UNADJUSTED score, so the penalty can never
    // push a same-side edge out of the candidate pool — the exact objection recorded in
    // lib/matching/batch-scoring.ts, which is why it was never a scoreMatch penalty.
    expect(batchRoute).toContain('if (avgScore < MIN_RELEVANCE_SCORE) continue')
    expect(batchRoute).not.toContain('allPairs.filter((p) => !isPartnerPair(p.userA, p.userB))')
  })
  it('algorithm + scoring-model versions were bumped (contract)', () => {
    expect(batchScorer).toContain("RECOMMENDATION_ALGORITHM_VERSION = 'v3.3'") // selection changed
    expect(batchScorer).toContain("SCORING_MODEL_VERSION = 'v2.0.0'")           // scoreMatch unchanged
  })
})

// ── PART 3 durable idempotency across two weekly-route invocations (issue #3) ───
describe('reminder is durably idempotent across duplicate weekly invocations', () => {
  it('two invocations with the same cycle send at most ONE email; a failed send stays retryable', async () => {
    vi.resetModules()
    const notifRows: any[] = []
    let emailSends = 0
    let failNext = false

    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => ({
        from: (t: string) => {
          const preds: Array<(r: any) => boolean> = []
          const b: any = {
            select() { return b },
            eq(c: string, v: any) {
              preds.push((r) => c === 'data->>dedupeKey' ? r?.data?.dedupeKey === v : r[c] === v)
              return b
            },
            limit() { return Promise.resolve({ data: notifRows.filter(r => preds.every(f => f(r))), error: null }) },
            maybeSingle() { return Promise.resolve({ data: { email: 'cw@x.com', full_name: 'CW' }, error: null }) },
          }
          return b
        },
      }),
    }))
    vi.doMock('@/lib/notifications', () => ({
      createNotificationSafe: async ({ userId, type, data }: any) => {
        if (notifRows.some(r => r.user_id === userId && r.type === type && r.data?.dedupeKey === data?.dedupeKey)) return null
        notifRows.push({ id: 'n' + notifRows.length, user_id: userId, type, data }); return notifRows[notifRows.length - 1]
      },
    }))
    vi.doMock('@/lib/email', () => ({
      sendPendingIntrosReminderEmail: async () => {
        if (failNext) return { success: false, error: 'resend down' }
        emailSends++; return { success: true }
      },
    }))
    process.env.RESEND_API_KEY = 'test'
    const { notifyPendingIntrosActionNeeded } = await import('@/lib/notifications/engagement')

    // Invocation 1 (same cycle) → sends once
    // Both System A (weekly-refresh) and System B (approve-batch) call THIS helper with the
    // same actionneeded:<ISO_WEEK> key, so these invocations model "System A then B", "B then
    // A", and a duplicate Send — all collapse to one email.
    const r1 = await notifyPendingIntrosActionNeeded('M', 'b1', '2026-W32') // System A
    const r2 = await notifyPendingIntrosActionNeeded('M', 'b1', '2026-W32') // System B, same cycle
    const r3 = await notifyPendingIntrosActionNeeded('M', 'bX', '2026-W32') // duplicate Send (any batch ref)
    expect(emailSends).toBe(1)
    expect(r1.emailed).toBe(true)
    expect(r2.alreadyHandled).toBe(true); expect(r2.emailed).toBe(false)
    expect(r3.alreadyHandled).toBe(true); expect(r3.emailed).toBe(false)
    // A NEW ISO week may remind again (new durable key)
    const nextWeek = await notifyPendingIntrosActionNeeded('M', 'b1', '2026-W33')
    expect(nextWeek.emailed).toBe(true); expect(emailSends).toBe(2)

    // A DIFFERENT member whose send FAILS records nothing → a retry re-sends (not suppressed)
    failNext = true
    const f1 = await notifyPendingIntrosActionNeeded('N', 'b2', '2026-W32')
    expect(f1.handled).toBe(false)
    failNext = false
    const f2 = await notifyPendingIntrosActionNeeded('N', 'b2', '2026-W32')
    expect(f2.emailed).toBe(true) // retry succeeded because failure was not persisted
    vi.resetModules()
  })
})

// ── Unified Thursday workflow (PART 2/3/4): admin Send is canonical ────────────
describe('admin Send (approve-batch) enforces the shared eligibility + reminder rules', () => {
  const approve = readFileSync('app/api/admin/approve-batch/route.ts', 'utf8')
  const cron = readFileSync('app/api/cron/weekly-refresh/route.ts', 'utf8')

  it('unresolved recipient → Action Needed via the SHARED helper + ISO-week key (not the generic waiting email)', () => {
    expect(approve).toContain("import { notifyAdminBatchReady, notifyPendingIntrosActionNeeded, isoWeekKey } from '@/lib/notifications/engagement'")
    expect(approve).toContain('const cycleKey = isoWeekKey(new Date())')
    expect(approve).toContain('notifyPendingIntrosActionNeeded(p.recipientId, p.queuedBatchId, cycleKey)')
    // the OLD generic "Your Andrel introductions are waiting" nudge is no longer used here
    expect(approve).not.toContain('notifyQueuedIntrosWaiting')
  })

  it('eligible recipient (placed active) → existing new-batch email, unchanged', () => {
    expect(approve).toContain('notifyAdminBatchReady(p.recipientId, p.activeBatchId, p.visible)')
  })

  it('approve-batch reports the canonical Thursday counts', () => {
    for (const k of ['batchVisible', 'actionNeeded', 'otherSkipped', 'newBatchEmailsSent', 'actionNeededEmailsSent', 'remindersAlreadyHandled', 'emailFailures']) {
      expect(approve).toContain(k)
    }
  })

  it('BOTH routes share the same durable ISO-week reminder identity', () => {
    expect(cron).toContain('const cycleKey = isoWeekKey(new Date())')
    expect(approve).toContain('const cycleKey = isoWeekKey(new Date())')
    // both feed the same helper (which derives dedupeKey = actionneeded:<cycleKey>)
    expect(cron).toContain('notifyPendingIntrosActionNeeded(user.id, elig.activeBatchId, cycleKey)')
    expect(approve).toContain('notifyPendingIntrosActionNeeded(p.recipientId, p.queuedBatchId, cycleKey)')
  })

  it('weekly-refresh GENERATION is gated off by default (admin batch canonical); reminders remain', () => {
    expect(cron).toContain("const WEEKLY_REFRESH_GENERATION = process.env.WEEKLY_REFRESH_GENERATION === '1'")
    expect(cron).toContain('if (!WEEKLY_REFRESH_GENERATION) { generationDisabledSkipped++; continue }')
    // the reminder path is still present (safety net for unresolved members)
    expect(cron).toContain('notifyPendingIntrosActionNeeded(user.id, elig.activeBatchId, cycleKey)')
  })
})
