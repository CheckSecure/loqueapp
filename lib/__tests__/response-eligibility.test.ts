import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  isUnresolvedIntroduction, countUnresolvedIntroductions, shouldShowRespondNotice,
  type UnresolvedCandidate,
} from '@/lib/introductions/unresolved'

/**
 * Response eligibility: answer what you hold before you are shown more.
 *
 * The DATABASE is the authority — public.count_unresolved_introductions and the four gated writers,
 * proved by scripts/verify-081-response-eligibility.sh against a real PostgreSQL 17 cluster. These
 * tests cover the mirror, the notice, and the copy.
 */
const M081  = readFileSync('supabase/migrations/081_response_eligibility.sql', 'utf8')
const M080  = readFileSync('supabase/migrations/080_introduction_capacity_release.sql', 'utf8')
const PAGE  = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
const NOTICE = readFileSync('components/introductions/RespondToIntroductionsNotice.tsx', 'utf8')
const WELCOME = readFileSync('lib/onboarding/welcomeFromAdmin.ts', 'utf8')
const EMAIL = readFileSync('lib/email.ts', 'utf8')
const GEN   = readFileSync('lib/generate-recommendations.ts', 'utf8')
const RECIP = readFileSync('lib/matching/createReciprocalSuggestion.ts', 'utf8')
const QUEUE = readFileSync('lib/introductions/queue.ts', 'utf8')

/** Comment-stripped notice source: the doc comment names the things it must not contain. */
const NOTICE_CODE = NOTICE.split('\n')
  .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('/*') && !l.trim().startsWith('//'))
  .join('\n')

const base: UnresolvedCandidate = {
  status: 'suggested', hasOwnExpression: false,
  targetActive: true, targetMatched: false, targetExpressedAtMember: false,
}

describe('the authoritative unresolved predicate (mirror)', () => {
  it('an unanswered live suggestion counts', () => {
    expect(isUnresolvedIntroduction(base)).toBe(true)
  })

  it('an answered card does not — correlated and legacy are the same fact', () => {
    expect(isUnresolvedIntroduction({ ...base, hasOwnExpression: true })).toBe(false)
  })

  it('a capacity-released waiting card does not (its author expressed interest)', () => {
    // There is deliberately no separate "released" rule: released + expressed is what a waiting card
    // is, and hasOwnExpression is what excludes it.
    expect(isUnresolvedIntroduction({ ...base, hasOwnExpression: true })).toBe(false)
  })

  it('but a released card whose expression was withdrawn becomes answerable again', () => {
    expect(isUnresolvedIntroduction({ ...base, hasOwnExpression: false })).toBe(true)
  })

  it('queued rows are not actionable', () => {
    expect(isUnresolvedIntroduction({ ...base, status: 'queued' })).toBe(false)
  })

  it('terminal rows never count', () => {
    for (const status of ['passed', 'expired', 'archived', 'hidden', 'hidden_permanent', 'declined']) {
      expect(isUnresolvedIntroduction({ ...base, status })).toBe(false)
    }
  })

  it('an inactive target cannot block the member — the audit trap', () => {
    expect(isUnresolvedIntroduction({ ...base, targetActive: false })).toBe(false)
  })

  it('incoming interest does not control eligibility', () => {
    expect(isUnresolvedIntroduction({ ...base, targetExpressedAtMember: true })).toBe(false)
  })

  it('a matched pair has nothing left to answer', () => {
    expect(isUnresolvedIntroduction({ ...base, targetMatched: true })).toBe(false)
  })

  it('counts across a mixed set', () => {
    expect(countUnresolvedIntroductions([
      base,                                        // counts
      { ...base },                                 // counts
      { ...base, hasOwnExpression: true },         // answered
      { ...base, status: 'queued' },               // invisible
      { ...base, targetActive: false },            // unanswerable
      { ...base, targetExpressedAtMember: true },  // incoming
    ])).toBe(2)
  })
})

describe('the Introductions-page notice', () => {
  it('shows with one actionable card', () => {
    expect(shouldShowRespondNotice([{}])).toBe(true)
  })

  it('shows with two actionable cards', () => {
    expect(shouldShowRespondNotice([{}, {}])).toBe(true)
  })

  it('does not show with nothing actionable', () => {
    expect(shouldShowRespondNotice([])).toBe(false)
    expect(shouldShowRespondNotice(null)).toBe(false)
    expect(shouldShowRespondNotice(undefined)).toBe(false)
  })

  it('is driven by allSuggestions — the array that renders the cards', () => {
    expect(PAGE).toMatch(/shouldShowRespondNotice\(allSuggestions\) && <RespondToIntroductionsNotice \/>/)
    // never from the raw rows, the waiting entries, the pending list or incoming interest
    expect(PAGE).not.toMatch(/shouldShowRespondNotice\((suggestedIntros|waitingEntries|pendingProfiles|incomingInterest)/)
  })

  it('so correlated waiting, released, queued, terminal, matched and incoming rows are all excluded', () => {
    // allSuggestions is built from status='suggested' rows only, minus matched/deactivated/incoming
    // targets, minus every target with an outbound expression (which includes correlated + released).
    expect(PAGE).toMatch(/const allSuggestions = Array\.from\(/)
    expect(PAGE).toMatch(/!pendingTargetIds\.has\(item\.profile\.id\)/)
    expect(PAGE).toMatch(/correlatedTargetIds\.forEach\(\(id\) => pendingTargetIds\.add\(id\)\)/)
    expect(PAGE).toMatch(/!matchedUserIds\.has\(intro\.target\.id\)/)
    expect(PAGE).toMatch(/!deactivatedIds\.has\(intro\.target\.id\)/)
    expect(PAGE).toMatch(/!incomingRequesterIds\.has\(intro\.target\.id\)/)
  })

  it('sits directly above the card grid, in normal flow', () => {
    const at = PAGE.indexOf('<RespondToIntroductionsNotice />')
    const grid = PAGE.indexOf('{/* TWO-COLUMN LAYOUT */}')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(grid)
  })

  it('uses the exact copy and the exact product labels', () => {
    expect(NOTICE).toContain('Respond to your introductions to stay eligible for new ones.')
    expect(NOTICE).toContain('Choose Express interest or Pass on each one.')
    expect(NOTICE).toMatch(/Responding keeps you eligible for future curated\s*\n?\s*introductions/)
    expect(NOTICE).toMatch(/doesn&rsquo;t guarantee a new one in every batch/)
    const BUTTON = readFileSync('components/RequestIntroButton.tsx', 'utf8')
    expect(BUTTON).toContain("'Express interest'")      // the real label
    expect(BUTTON).toContain('aria-label="Pass"')
  })

  it('is accessible and mobile-safe', () => {
    expect(NOTICE).toMatch(/role="status"/)
    expect(NOTICE).toMatch(/aria-live="polite"/)
    expect(NOTICE_CODE).not.toMatch(/\bfixed\b|\bsticky\b|\bz-\d/)   // cannot cover MobileNav
    expect(NOTICE_CODE).not.toMatch(/onClick|<button|useState|'use client'/)
  })

  it('has no countdown, dismissal or tracking', () => {
    expect(NOTICE_CODE).not.toMatch(/countdown|localStorage|dismiss|track|analytics|setInterval/i)
  })

  it('never reveals another member’s response', () => {
    expect(NOTICE_CODE).not.toMatch(/interested in you|they (?:have|haven)|declined|waiting on them/i)
  })
})

describe('migration 081 closes the bypasses', () => {
  it('adds release_id, nullable, with no backfill and no FK', () => {
    expect(M081).toMatch(/ADD COLUMN IF NOT EXISTS release_id uuid NULL/)
    expect(M081).not.toMatch(/UPDATE public\.intro_requests\s+SET\s+release_id/)
    expect(M081).not.toMatch(/release_id[^\n]*REFERENCES/)
    expect(M081).toMatch(/No backfill\./)
  })

  it('defines exactly ONE predicate and every writer calls it', () => {
    expect(M081).toMatch(/CREATE OR REPLACE FUNCTION public\.count_unresolved_introductions\(/)
    const gate = 'count_unresolved_introductions'
    for (const fn of ['create_reciprocal_suggestion', 'place_batch_rows', 'promote_queued_rows', 'materialize_admin_pair']) {
      const body = M081.slice(M081.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`))
      expect(body.slice(0, body.indexOf('$fn$;'))).toContain(gate)
    }
  })

  it('gates the COUNTERPART with no envelope exclusion — the largest bypass', () => {
    expect(M081).toMatch(/IF public\.count_unresolved_introductions\(b_id, NULL, NULL\) > 0 THEN/)
    expect(M081).toMatch(/b_id gets NO exclusion/)
  })

  it('exempts only the release owner, and only their own envelope', () => {
    expect(M081).toMatch(/IF public\.count_unresolved_introductions\(a_id, p_release_id, NULL\) > 0 THEN/)
    // the counterpart's card is stamped NULL, so an envelope can never exempt the far side
    expect(M081).toMatch(/\(b_id, a_id, 'suggested', false, p_reason, pair\.id, NULL,\s+now\(\), now\(\)\)/)
  })

  it('is not the naive rule — the same release may still place two cards', () => {
    expect(M081).toMatch(/WHY THIS IS NOT THE NAIVE RULE/)
    expect(M081).toMatch(/p_release_id uuid DEFAULT NULL/)
  })

  it('queued promotion no longer ignores rows outside the batch', () => {
    const body = M081.slice(M081.indexOf('CREATE OR REPLACE FUNCTION public.promote_queued_rows('))
    expect(body.slice(0, body.indexOf('$fn$;'))).toMatch(/count_unresolved_introductions\(p_member_id, NULL, NULL\)/)
  })

  it('admin materialization refuses BEFORE any write, so no asymmetric card', () => {
    const body = M081.slice(M081.indexOf('CREATE OR REPLACE FUNCTION public.materialize_admin_pair('))
    const fn = body.slice(0, body.indexOf('$fn$;'))
    expect(fn.indexOf('12b) RESPONSE ELIGIBILITY')).toBeLessThan(fn.indexOf('INSERT INTO public.intro_requests'))
  })

  it('drops and recreates the reciprocal writer rather than creating an overload', () => {
    expect(M081).toMatch(/DROP FUNCTION public\.create_reciprocal_suggestion\(uuid, uuid, text, text, integer, integer\);/)
    expect(M081).toMatch(/GRANT EXECUTE ON FUNCTION public\.create_reciprocal_suggestion\(uuid, uuid, text, text, integer, integer, uuid\) TO service_role;/)
    expect(M081).toMatch(/REVOKE ALL ON FUNCTION public\.create_reciprocal_suggestion\(uuid, uuid, text, text, integer, integer, uuid\) FROM PUBLIC, anon, authenticated;/)
  })

  it('pins the POST-080 bodies in a fail-closed drift guard', () => {
    const g = M081.slice(M081.indexOf('DO $drift$'), M081.indexOf('$drift$;'))
    expect(g).toMatch(/pg_catalog\.to_regprocedure\(r\.sig\)/)
    expect(g).not.toMatch(/LIMIT 1/)
    for (const md5 of ['e86e1dde486a4da9c72883b42e0fb391', '64512aa7d77c56a251239cf329527b1b',
                       'bf31f1ce0df71c432e098e7e1b6311dd', 'a2f2fbd5e3c5c63993b2a59849fe7c6b',
                       'c786da9312cf962eb06ec6463ceecfd8']) {
      expect(g).toContain(md5)
    }
    expect(g).toMatch(/NOT v_proc\.prosecdef/)
    expect(g).toMatch(/NOT IN \('search_path=', 'search_path=""'\)/)
    expect(g).toMatch(/migration 080 is not applied/)
  })

  it('leaves migrations 063–080 alone', () => {
    expect(M080).not.toMatch(/count_unresolved_introductions|release_id/)
    expect(M081).not.toMatch(/CREATE OR REPLACE FUNCTION public\.expire_intro_pair/)
    expect(M081).not.toMatch(/CREATE OR REPLACE FUNCTION public\.express_intro_interest/)
    expect(M081).not.toMatch(/CREATE OR REPLACE FUNCTION public\.release_intro_capacity/)
  })
})

describe('the generator carries one release envelope per run', () => {
  it('mints it once and passes it to every placement of that run', () => {
    expect(GEN).toMatch(/const releaseId = randomUUID\(\)/)
    expect(GEN).toMatch(/createReciprocalSuggestion\(adminClient, userId, id, \{ source: pairSource, releaseId \}\)/)
    expect((GEN.match(/const releaseId = randomUUID\(\)/g) ?? []).length).toBe(1)
  })

  it('prefilters the member, and says plainly that the prefilter is not the enforcement', () => {
    expect(GEN).toMatch(/const outstanding = await countUnresolvedRecommendations\(adminClient, userId\)/)
    expect(GEN).toMatch(/if \(outstanding > 0\) return finish\('capacity', 0, 0, 0\)/)
    expect(GEN).toMatch(/it is NOT the\s*\n?\s*\/\/ enforcement/)
  })

  it('treats an unresolved refusal as a deterministic, self-clearing skip', () => {
    expect(RECIP).toMatch(/'unresolved'/)
    expect(GEN).toMatch(/o === 'capacity' \|\| o === 'exists_active' \|\| o === 'unresolved'/)
  })

  it('the weekly gate delegates to the database predicate', () => {
    expect(QUEUE).toMatch(/rpc\('count_unresolved_introductions'/)
    expect(QUEUE).toMatch(/THE AUTHORITY IS THE DATABASE/)
    expect(QUEUE).toMatch(/FALLBACK, deliberately kept/)
  })
})

describe('prospective welcome education', () => {
  it('adds the paragraph before the sign-off', () => {
    expect(WELCOME).toContain('A note on how introductions work: each one waits for your response—choose Express interest or Pass.')
    expect(WELCOME).toContain('we keep it private until the other person responds independently')
    expect(WELCOME).toContain('Responding to the introductions you have keeps you eligible for future introductions.')
    expect(WELCOME).toContain('They remain curated rather than scheduled, so there may not be a new introduction in every batch.')
    expect(WELCOME.indexOf('A note on how introductions work')).toBeLessThan(WELCOME.indexOf('— Daniel'))
  })

  it('reaches only NEW members — the welcome_sent_at gate is unchanged', () => {
    expect(WELCOME).toMatch(/if \(profile\.welcome_sent_at\) \{/)
    expect(WELCOME).toMatch(/welcome_sent_at: new Date\(\)\.toISOString\(\)/)
  })

  it('adds no onboarding step, modal, field or migration', () => {
    expect(WELCOME).not.toMatch(/onboarding_step|ALTER TABLE|modal/i)
    expect(M081).not.toMatch(/welcome|onboarding_step/i)
  })

  it('promises nothing weekly', () => {
    const para = WELCOME.slice(WELCOME.indexOf('A note on how introductions work'), WELCOME.indexOf('— Daniel'))
    expect(para).not.toMatch(/every week|weekly|guarantee|automatically|you will receive|you'll receive/i)
  })
})

describe('the reminder email no longer promises delivery', () => {
  const fn = EMAIL.slice(EMAIL.indexOf('export async function sendPendingIntrosReminderEmail'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))

  it('the automatic-delivery sentence is gone', () => {
    expect(EMAIL).not.toContain("you'll automatically receive new introductions in the following batch")
  })

  it('and is replaced by the eligibility wording', () => {
    expect(body).toContain("you'll be eligible for the next round of curated introductions")
    expect(body).toContain("We only introduce when there's a genuine fit, so there may not be a new introduction in every batch")
  })

  it('no remaining line implies automatic, weekly or next-batch delivery', () => {
    expect(body).not.toMatch(/automatically|guarantee|every week|weekly introduction|will receive/i)
  })

  it('uses the real product labels', () => {
    expect(body).toContain('choose either Express interest or Pass')
    expect(body).not.toContain('choose either Interested or Pass')
  })

  it('is not sent by anything this change touches', () => {
    expect(GEN).not.toMatch(/sendPendingIntrosReminderEmail/)
    expect(PAGE).not.toMatch(/sendPendingIntrosReminderEmail/)
  })
})
