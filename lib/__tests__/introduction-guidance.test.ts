import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  isActionableCard, selectActionableCards, countActionableCards,
  ACTIONABLE_CARD_STATUS, ANSWERED_OUTBOUND_STATUSES,
  type ActionableContext, type SuggestedCardRow,
} from '@/lib/introductions/actionableCards'
import {
  resolveGuidanceState, hasEverReceivedIntroduction, actionableAnnouncement,
  GUIDANCE_COPY, BANNED_GUIDANCE_WORDS, CARD_LIFECYCLE_STATUSES, ACTIONABLE_ANCHOR_ID,
} from '@/lib/introductions/guidance'

/**
 * Contextual Introductions guidance: accurate copy, an honest count, and no leaked interest.
 *
 * The AUDITED POLICY IS STRICT. Migration 081 gates all four production writers on
 * public.count_unresolved_introductions() > 0, so one unanswered actionable card from a prior
 * release stops every path. These tests pin the copy TO that policy — if the policy is ever
 * softened to capacity-based, the copy assertions here fail, which is the point.
 *
 * The page is a JSX server component this vitest setup cannot render (tsconfig jsx=preserve), so
 * page and component wiring is asserted on source, consistent with the rest of lib/__tests__.
 */
const PAGE = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
const REMINDER = readFileSync('components/introductions/RespondToIntroductionsNotice.tsx', 'utf8')
const EXPLAINER = readFileSync('components/introductions/FirstIntroductionsExplainer.tsx', 'utf8')
const CAUGHT_UP = readFileSync('components/introductions/AllCaughtUpNotice.tsx', 'utf8')
const ACTIONS = readFileSync('app/actions.ts', 'utf8')
const MIGRATION = readFileSync('supabase/migrations/084_introduction_guidance_enrollment.sql', 'utf8')
const PASS_RATE = readFileSync('supabase/audits/introduction_pass_rate.sql', 'utf8')


/**
 * These files are heavily commented, and the comments legitimately DISCUSS the things the
 * assertions forbid ("not fixed, not sticky", "counterparty state", the four writer names). A
 * prose mention is not a behaviour, so every "must not contain" assertion runs against CODE with
 * comments stripped. Anything that survives is real.
 */
function code(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')  // JSX comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ')        // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1')         // line comments (leaves https:// alone)
}
function sqlCode(src: string): string {
  return src.replace(/--.*$/gm, ' ')
}

const EMPTY: ActionableContext = {
  matchedTargetIds: new Set(), unavailableTargetIds: new Set(),
  incomingInterestTargetIds: new Set(), answeredTargetIds: new Set(),
}
const ctx = (over: Partial<Record<keyof ActionableContext, string[]>> = {}): ActionableContext => ({
  matchedTargetIds: new Set(over.matchedTargetIds ?? []),
  unavailableTargetIds: new Set(over.unavailableTargetIds ?? []),
  incomingInterestTargetIds: new Set(over.incomingInterestTargetIds ?? []),
  answeredTargetIds: new Set(over.answeredTargetIds ?? []),
})
const card = (over: Partial<SuggestedCardRow> = {}): SuggestedCardRow => ({
  id: 'row-1', target_user_id: 't1', status: 'suggested',
  target: { id: 't1', account_status: 'active' }, ...over,
})

// ── 1. The canonical actionable predicate ────────────────────────────────────────────
describe('canonical actionable-card predicate', () => {
  it('includes a live suggested card with an active, unanswered, unmatched target', () => {
    expect(isActionableCard(card(), EMPTY)).toBe(true)
    expect(ACTIONABLE_CARD_STATUS).toBe('suggested')
  })

  it('excludes every non-actionable status', () => {
    for (const status of ['queued', 'expired', 'passed', 'hidden_permanent', 'archived', 'declined', 'pending', 'approved', 'accepted', 'admin_pending']) {
      expect(isActionableCard(card({ status }), EMPTY), status).toBe(false)
    }
  })

  it('excludes an answered card — every outbound answered status resolves the target', () => {
    for (const _status of ANSWERED_OUTBOUND_STATUSES) {
      expect(isActionableCard(card(), ctx({ answeredTargetIds: ['t1'] }))).toBe(false)
    }
  })

  it('excludes a matched target — nothing left to answer', () => {
    expect(isActionableCard(card(), ctx({ matchedTargetIds: ['t1'] }))).toBe(false)
  })

  it('excludes an inactive target, whether the join or the caller carries the fact', () => {
    expect(isActionableCard(card({ target: { id: 't1', account_status: 'deactivated' } }), EMPTY)).toBe(false)
    expect(isActionableCard(card({ target: { id: 't1', account_status: 'paused' } }), EMPTY)).toBe(false)
    expect(isActionableCard(card(), ctx({ unavailableTargetIds: ['t1'] }))).toBe(false)
  })

  it('excludes incoming interest — that is answered from "Interested in you"', () => {
    expect(isActionableCard(card(), ctx({ incomingInterestTargetIds: ['t1'] }))).toBe(false)
  })

  it('excludes malformed and orphaned rows instead of throwing', () => {
    expect(isActionableCard(null, EMPTY)).toBe(false)
    expect(isActionableCard(undefined, EMPTY)).toBe(false)
    expect(isActionableCard(card({ target: null }), EMPTY)).toBe(false)
    expect(isActionableCard(card({ target: undefined }), EMPTY)).toBe(false)
    expect(isActionableCard(card({ target: { id: '' } as any }), EMPTY)).toBe(false)
  })

  it('a capacity-released card is excluded via its own expression, not a special case', () => {
    // still 'suggested' after 72h, but its author expressed interest → answeredTargetIds holds it
    expect(isActionableCard(card(), ctx({ answeredTargetIds: ['t1'] }))).toBe(false)
    // and if that expression were withdrawn it becomes answerable again
    expect(isActionableCard(card(), EMPTY)).toBe(true)
    expect(readFileSync('lib/introductions/actionableCards.ts', 'utf8')).not.toMatch(/capacity_released_at/)
  })

  it('counts a person once, not a row — duplicate rows for one target collapse', () => {
    const rows = [card({ id: 'r1' }), card({ id: 'r2' }), card({ id: 'r3', target_user_id: 't2', target: { id: 't2', account_status: 'active' } })]
    expect(selectActionableCards(rows, EMPTY)).toHaveLength(2)
  })

  it('NEVER caps — every actionable card is returned, however many there are', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => card({ id: `r${n}`, target_user_id: `t${n}`, target: { id: `t${n}`, account_status: 'active' } }))
    for (const n of [1, 2, 3, 4, 5]) {
      expect(selectActionableCards(rows.slice(0, n), EMPTY), `${n} cards`).toHaveLength(n)
      expect(countActionableCards(selectActionableCards(rows.slice(0, n), EMPTY))).toBe(n)
    }
    // the selector takes no cap argument at all — there is nothing to pass a 2 to
    expect(selectActionableCards.length).toBe(2)
    expect(readFileSync('lib/introductions/actionableCards.ts', 'utf8')).not.toMatch(/\.slice\(/)
  })

  it('handles null/undefined input', () => {
    expect(selectActionableCards(null, EMPTY)).toEqual([])
    expect(selectActionableCards(undefined, EMPTY)).toEqual([])
    expect(countActionableCards(null)).toBe(0)
  })

  it('excludes EVERY unavailable target, and the caller resolves them exactly as the SQL does', () => {
    for (const id of ['tMissing', 'tInactive', 'tIncomplete', 'tTest', 'tPaused', 'tBlocked']) {
      expect(isActionableCard(card({ target_user_id: id, target: { id, account_status: 'active' } }),
        ctx({ unavailableTargetIds: [id] })), id).toBe(false)
    }
    const PAGE_SRC = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
    // the page resolves availability from the SAME fields migration 085's predicate reads
    for (const field of ['account_status', 'profile_complete', 'is_test_account', 'matching_paused']) {
      expect(PAGE_SRC, field).toContain(field)
    }
    expect(PAGE_SRC).toContain("from('blocked_users')")
    expect(PAGE_SRC).toContain('unavailableTargetIds: unavailableIds')
  })

  it('the page derives its rendered cards from the canonical selector, not an inline filter', () => {
    expect(PAGE).toContain('selectActionableCards(')
    expect(PAGE).toContain("from '@/lib/introductions/actionableCards'")
    // the count handed to the guidance IS the rendered array's length
    expect(PAGE).toContain('const actionableCount = allSuggestions.length')
  })
})

// ── 2. Which guidance shows ──────────────────────────────────────────────────────────
describe('guidance state resolution', () => {
  const base = { actionableCount: 0, hasEverReceivedIntroduction: false }

  it('a newly enrolled member with their first actual cards sees the explainer', () => {
    expect(resolveGuidanceState({ ...base, actionableCount: 2, enrolledAt: '2026-08-20T00:00:00Z' })).toBe('first_batch')
  })

  it('but NOT before cards exist — onboarding and an empty page both fall through', () => {
    expect(resolveGuidanceState({ ...base, actionableCount: 0, enrolledAt: '2026-08-20T00:00:00Z' })).toBe('none')
    expect(resolveGuidanceState({
      ...base, actionableCount: 0, hasEverReceivedIntroduction: true, enrolledAt: '2026-08-20T00:00:00Z',
    })).toBe('caught_up')
  })

  it('a historical member is NEVER enrolled — no stamp, so never the explainer', () => {
    for (const enrolledAt of [null, undefined, '']) {
      expect(resolveGuidanceState({ ...base, actionableCount: 2, enrolledAt })).toBe('reminder')
    }
  })

  it('dismissal is durable — once dismissed the explainer never returns', () => {
    expect(resolveGuidanceState({
      ...base, actionableCount: 2, enrolledAt: '2026-08-20T00:00:00Z',
      explainerDismissedAt: '2026-08-21T00:00:00Z',
    })).toBe('reminder')
  })

  it('the compact reminder shows only with actionable cards', () => {
    expect(resolveGuidanceState({ ...base, actionableCount: 1 })).toBe('reminder')
    expect(resolveGuidanceState({ ...base, actionableCount: 2 })).toBe('reminder')
    expect(resolveGuidanceState({ ...base, actionableCount: 0 })).toBe('none')
  })

  it('it disappears after the final response — the state changes, it is not hidden', () => {
    const after = resolveGuidanceState({ actionableCount: 0, hasEverReceivedIntroduction: true })
    expect(after).toBe('caught_up')
    expect(after).not.toBe('reminder')
  })

  it('all-caught-up requires a past; a never-introduced member keeps the waiting state', () => {
    expect(resolveGuidanceState({ actionableCount: 0, hasEverReceivedIntroduction: true })).toBe('caught_up')
    expect(resolveGuidanceState({ actionableCount: 0, hasEverReceivedIntroduction: false })).toBe('none')
  })

  it('exactly one state is ever returned — the panels cannot compete', () => {
    const states = new Set<string>()
    for (const count of [0, 1, 2]) for (const hist of [true, false])
      for (const enrolled of [null, 'x']) for (const dismissed of [null, 'y'])
        states.add(resolveGuidanceState({ actionableCount: count, hasEverReceivedIntroduction: hist, enrolledAt: enrolled, explainerDismissedAt: dismissed }))
    expect(Array.from(states).sort()).toEqual(['caught_up', 'first_batch', 'none', 'reminder'])
  })

  it('negative and non-integer counts cannot fabricate a reminder', () => {
    expect(resolveGuidanceState({ ...base, actionableCount: -3 })).toBe('none')
    expect(resolveGuidanceState({ ...base, actionableCount: 0.4 })).toBe('none')
  })
})

describe('"has ever received an introduction"', () => {
  it('is true for any card-lifecycle status, including terminal ones', () => {
    for (const status of CARD_LIFECYCLE_STATUSES) {
      expect(hasEverReceivedIntroduction([{ status }]), status).toBe(true)
    }
  })

  it('is FALSE for a member whose only rows are their own outbound requests', () => {
    // a member-initiated intro request is not an introduction they RECEIVED
    expect(hasEverReceivedIntroduction([{ status: 'pending' }])).toBe(false)
    expect(hasEverReceivedIntroduction([{ status: 'approved' }, { status: 'accepted' }])).toBe(false)
  })

  it('is false for no rows at all', () => {
    expect(hasEverReceivedIntroduction([])).toBe(false)
    expect(hasEverReceivedIntroduction(null)).toBe(false)
    expect(hasEverReceivedIntroduction(undefined)).toBe(false)
  })
})

// ── 3. Copy matches the AUDITED policy ───────────────────────────────────────────────
describe('copy accuracy against the audited strict policy', () => {
  const allCopy = [
    GUIDANCE_COPY.firstBatch.heading, GUIDANCE_COPY.firstBatch.body,
    GUIDANCE_COPY.reminder.heading, GUIDANCE_COPY.reminder.body,
    GUIDANCE_COPY.caughtUp.heading, GUIDANCE_COPY.caughtUp.body,
  ]

  it('uses the STRICT reminder wording, because all four writers gate on the predicate', () => {
    expect(GUIDANCE_COPY.reminder.heading).toBe('You have introductions waiting')
    expect(GUIDANCE_COPY.reminder.body).toContain('Once you’ve responded to your current introductions')
    expect(GUIDANCE_COPY.reminder.body).toContain('eligible for consideration in the next weekly round')
    // the capacity-based wording would be inaccurate here and must not appear
    expect(GUIDANCE_COPY.reminder.body).not.toContain('Responding keeps your introduction queue moving')
  })

  it('the strict rule really is what the production writers enforce', () => {
    const sql = readFileSync('supabase/migrations/081_response_eligibility.sql', 'utf8')
    for (const writer of ['create_reciprocal_suggestion', 'place_batch_rows', 'promote_queued_rows', 'materialize_admin_pair']) {
      expect(sql, writer).toContain(writer)
    }
    expect((sql.match(/IF public\.count_unresolved_introductions\(/g) || []).length).toBeGreaterThanOrEqual(5)
  })

  it('uses no pressure or promise words anywhere', () => {
    for (const s of allCopy) {
      for (const word of BANNED_GUIDANCE_WORDS) {
        expect(new RegExp(`\\b${word}\\b`, 'i').test(s), `"${word}" in: ${s}`).toBe(false)
      }
    }
  })

  it('promises no introduction — only consideration', () => {
    expect(GUIDANCE_COPY.caughtUp.body).toContain('We’ll consider you for the next weekly round')
    for (const s of allCopy) expect(s).not.toMatch(/you will receive|we will introduce|guarantee/i)
  })

  it('omits the "passing is not shared" sentence, which the code does not prove', () => {
    for (const s of allCopy) expect(s).not.toMatch(/not shared with the other member/i)
  })

  it('carries no second calendar — the Thursday countdown stays the only timing authority', () => {
    for (const s of allCopy) expect(s).not.toMatch(/thursday|\d{1,2}:\d{2}|days?\b|hours?\b/i)
    expect(code(CAUGHT_UP)).not.toMatch(/nextBatch|countdown|thursdaySchedule|toLocaleDateString/i)
  })

  it('announces the count to screen readers as a sentence, and pluralises', () => {
    expect(actionableAnnouncement(1)).toBe('1 introduction is waiting for your response.')
    expect(actionableAnnouncement(2)).toBe('2 introductions are waiting for your response.')
    expect(actionableAnnouncement(0)).toBe('0 introductions are waiting for your response.')
    expect(actionableAnnouncement(-5)).toBe('0 introductions are waiting for your response.')
  })
})

// ── 4. Mutual-interest privacy ───────────────────────────────────────────────────────
describe('no one-sided interest is exposed', () => {
  it('no guidance surface reads counterparty state', () => {
    for (const [name, src] of [['reminder', REMINDER], ['explainer', EXPLAINER], ['caught-up', CAUGHT_UP],
                               ['guidance', readFileSync('lib/introductions/guidance.ts', 'utf8')]] as const) {
      expect(code(src), name).not.toMatch(/target_user_id|requester_id|otherAlreadyApproved|reciprocal|incomingInterest|expressed/i)
    }
  })

  it('no guidance copy implies who is waiting, or that a pass reached anyone', () => {
    const all = code(REMINDER) + code(EXPLAINER) + code(CAUGHT_UP) + JSON.stringify(GUIDANCE_COPY)
    expect(all).not.toMatch(/they (are|have)|the other member|someone is waiting|mutual|their response|interested in you/i)
  })

  it('the reminder receives only a number — nothing that could identify anyone', () => {
    expect(REMINDER).toMatch(/count,\s*\n?\s*targetId/)
    // `className` legitimately contains "name" — assert on fields that would carry identity
    expect(code(REMINDER)).not.toMatch(/full_name|\bemail\b|avatar_url|\bprofile\b/i)
  })

  it('adds no "Not now" status anywhere', () => {
    for (const src of [REMINDER, EXPLAINER, CAUGHT_UP, PAGE]) expect(src).not.toMatch(/not[_ ]now/i)
  })
})

// ── 5. The action targets the first actionable card ──────────────────────────────────
describe('the reminder action focuses the first actionable card', () => {
  it('is a real keyboard-reachable button with a visible focus ring', () => {
    expect(REMINDER).toMatch(/<button[\s\S]*?type="button"/)
    expect(REMINDER).toContain('focus-visible:ring-2')
    expect(REMINDER).not.toMatch(/<div[^>]*onClick/)
  })

  it('looks up the shared anchor id and moves focus, not just scroll', () => {
    expect(REMINDER).toContain('getElementById(targetId)')
    expect(REMINDER).toContain('scrollIntoView')
    expect(REMINDER).toContain('el.focus({ preventScroll: true })')
  })

  it('leaves no phantom tab stop behind', () => {
    expect(REMINDER).toContain("el.removeAttribute('tabindex')")
  })

  it('the page stamps that id on exactly one card — the first one rendered', () => {
    expect(PAGE).toContain('ACTIONABLE_ANCHOR_ID')
    expect(PAGE).toContain('row.rowId === firstActionableRowId ? ACTIONABLE_ANCHOR_ID : undefined')
    // reciprocal section renders before the ordinary one, so it wins the anchor
    expect(PAGE).toMatch(/introSections\.andrel\.featured as any\)\?\.rowId \?\? \(introSections\.ordinary\.featured/)
    expect(readFileSync('components/IntroductionCard.tsx', 'utf8')).toContain('id={anchorId}')
    expect(ACTIONABLE_ANCHOR_ID).toBe('first-actionable-introduction')
  })

  it('renders nothing at all when the count is zero, belt-and-braces', () => {
    expect(REMINDER).toMatch(/if \(safe <= 0\) return null/)
    expect(EXPLAINER).toMatch(/if \(hidden \|\| safe <= 0\) return null/)
  })

  it('is not dismissible while cards remain', () => {
    expect(code(REMINDER)).not.toMatch(/dismiss|localStorage|setHidden/i)
  })
})

// ── 6. Enrollment and dismissal are server-side and self-only ────────────────────────
describe('enrollment cannot reach existing members', () => {
  it('the migration writes no rows and adds no default', () => {
    expect(sqlCode(MIGRATION)).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)\b/im)
    expect(sqlCode(MIGRATION)).not.toMatch(/ADD COLUMN[^;]*DEFAULT/i)
    expect(MIGRATION).toContain('NO BACKFILL')
  })

  it('it proves in-transaction that nobody was enrolled, and rolls back if anyone was', () => {
    expect(MIGRATION).toContain('intro_guidance_enrolled_at IS NOT NULL')
    expect(MIGRATION).toMatch(/RAISE EXCEPTION[\s\S]{0,400}No profile may be enrolled by this migration/)
  })

  it('it preserves the profiles privacy posture rather than assuming it', () => {
    expect(MIGRATION).toMatch(/has_table_privilege\('authenticated', 'public\.profiles', 'SELECT'\)/)
    expect(MIGRATION).toMatch(/has_table_privilege\('authenticated', 'public\.profiles', 'UPDATE'\)/)
    expect(MIGRATION).toContain('column_privileges')
  })

  it('there is NO application-level enrollment writer left — the trigger is the only authority', () => {
    for (const f of ['app/actions.ts', 'app/api/profile/complete/route.ts',
                     'app/dashboard/introductions/page.tsx']) {
      expect(readFileSync(f, 'utf8'), f).not.toContain('stampIntroGuidanceEnrollment')
    }
    // nothing anywhere writes the column from application code
    expect(ACTIONS).not.toContain('intro_guidance_enrolled_at')
  })

  it('the trigger stamps ONLY the first transition to complete', () => {
    // bound the slice to the FUNCTION BODY; the postconditions further down legitimately name the
    // dismissal column while proving nothing was dismissed
    const start = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.tg_stamp_intro_guidance_enrollment')
    const fn = MIGRATION.slice(start, MIGRATION.indexOf('$fn$;', start))
    expect(fn).toMatch(/IF NEW\.intro_guidance_enrolled_at IS NOT NULL THEN\s*\n\s*RETURN NEW;/) // never overwrite
    expect(fn).toMatch(/IF NEW\.profile_complete IS NOT TRUE THEN\s*\n\s*RETURN NEW;/)           // only when complete
    expect(fn).toContain("TG_OP = 'INSERT'")                                                     // insert-complete
    expect(fn).toContain("OLD.profile_complete IS DISTINCT FROM TRUE")                           // the TRANSITION only
    expect(fn).not.toContain('intro_first_batch_explainer_dismissed_at')                         // never clears dismissal
  })

  it('the trigger is BEFORE, row-level, scoped to profile_complete, and privilege-hardened', () => {
    expect(MIGRATION).toMatch(/BEFORE INSERT OR UPDATE OF profile_complete ON public\.profiles/)
    expect(MIGRATION).toContain('FOR EACH ROW')
    expect(MIGRATION).toContain('SECURITY INVOKER')
    expect(MIGRATION).toMatch(/SET search_path = ''/)
    expect(MIGRATION).toContain('REVOKE ALL ON FUNCTION public.tg_stamp_intro_guidance_enrollment() FROM PUBLIC, anon, authenticated')
    // exactly ONE enrollment authority is asserted in the migration's own postconditions
    expect(MIGRATION).toContain('exactly 1 authority is permitted')
  })
})

describe('dismissal is server-side and self-only', () => {
  const fn = ACTIONS.slice(
    ACTIONS.indexOf('export async function dismissFirstIntroductionsExplainer'),
    ACTIONS.indexOf('export async function stampIntroGuidanceEnrollment'),
  )

  it('takes NO argument, so there is no id to aim at another member', () => {
    expect(fn).toMatch(/dismissFirstIntroductionsExplainer\(\)/)
  })

  it('resolves the subject from the server-validated session and keys the write on it', () => {
    expect(fn).toContain('await supabase.auth.getUser()')
    expect(fn).toMatch(/if \(!user\) return \{ ok: false/)
    expect(fn).toContain(".eq('id', user.id)")
  })

  it('writes one member-private column and nothing else', () => {
    expect(fn).toContain('intro_first_batch_explainer_dismissed_at')
    expect(code(fn)).not.toMatch(/profile_complete|account_status|intro_guidance_enrolled_at|matches|credits|intro_requests/)
  })

  it('persists on the server — localStorage is never the record', () => {
    expect(EXPLAINER).toContain('dismissFirstIntroductionsExplainer')
    for (const src of [EXPLAINER, REMINDER, PAGE]) expect(code(src)).not.toMatch(/localStorage|sessionStorage|document\.cookie/)
  })

  it('is honest when migration 084 is not applied yet', () => {
    expect(fn).toContain('isMissingColumnError(error)')
    expect(fn).toContain('persisted: false')
  })
})

// ── 7. Behaviour that must NOT have changed ──────────────────────────────────────────
describe('matching, capacity, expiry, pair, credit, email and notification behaviour', () => {
  it('no guidance module touches any of them', () => {
    for (const f of ['lib/introductions/guidance.ts', 'lib/introductions/actionableCards.ts',
                     'components/introductions/RespondToIntroductionsNotice.tsx',
                     'components/introductions/FirstIntroductionsExplainer.tsx',
                     'components/introductions/AllCaughtUpNotice.tsx']) {
      const src = code(readFileSync(f, 'utf8'))
      expect(src, f).not.toMatch(/create_reciprocal_suggestion|place_batch_rows|promote_queued_rows|materialize_admin_pair|expire_intro_pair/)
      expect(src, f).not.toMatch(/meeting_credits|credit_transactions|sendEmail|sendMatchCreated|notifications|member_pairs/)
      expect(src, f).not.toMatch(/\.insert\(|\.delete\(|\.rpc\(/) // src already comment-stripped
    }
  })

  it('the migration is confined to two additive profile columns', () => {
    expect(sqlCode(MIGRATION)).not.toMatch(/intro_requests|member_pairs|matches|meeting_credits|recommendation_batches|notifications/)
    expect((sqlCode(MIGRATION).match(/ADD COLUMN IF NOT EXISTS/g) || []).length).toBe(2)
    expect(sqlCode(MIGRATION)).not.toMatch(/CREATE POLICY|ALTER POLICY/)
    // the only function/trigger it creates is the enrollment authority itself
    expect((sqlCode(MIGRATION).match(/CREATE OR REPLACE FUNCTION/g) || []).length).toBe(1)
    expect((sqlCode(MIGRATION).match(/CREATE TRIGGER/g) || []).length).toBe(1)
    expect(sqlCode(MIGRATION)).toContain('tg_stamp_intro_guidance_enrollment')
  })

  it('the capacity contract and the release size are untouched', () => {
    expect(readFileSync('lib/introductions/capacity.ts', 'utf8')).toContain('MAX_VISIBLE_INTRO_CARDS = 2')
    expect(PAGE).toContain('RECOMMENDATIONS_PER_BATCH')
  })

  it('the page adds no write of any kind', () => {
    const guidanceBlock = PAGE.slice(PAGE.indexOf('── INTRODUCTION GUIDANCE'), PAGE.indexOf('UI Review overlay'))
    expect(guidanceBlock).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/)
  })
})

// ── 8. Layout and accessibility ──────────────────────────────────────────────────────
describe('mobile layout and accessibility', () => {
  it('every guidance surface wraps and can shrink — no horizontal overflow', () => {
    for (const [name, src] of [['reminder', REMINDER], ['explainer', EXPLAINER], ['caught-up', CAUGHT_UP]] as const) {
      expect(src, name).toContain('min-w-0')
      expect(src, name).toContain('break-words')
      expect(src, name).not.toMatch(/whitespace-nowrap|overflow-x-auto|w-\[\d{3,}px\]/)
    }
  })

  it('the reminder stacks on a phone and only goes side-by-side from sm', () => {
    expect(REMINDER).toContain('flex flex-col sm:flex-row')
  })

  it('never covers the fixed MobileNav or the Thursday countdown', () => {
    for (const src of [REMINDER, EXPLAINER, CAUGHT_UP]) expect(code(src)).not.toMatch(/\bfixed\b|\bsticky\b|z-\d+/)
    // rendered in normal flow, after the countdown banner
    expect(PAGE.indexOf('ThursdayCountdownBanner')).toBeLessThan(PAGE.indexOf('guidanceState === '))
  })

  it('state changes reach assistive technology', () => {
    for (const src of [REMINDER, EXPLAINER]) {
      expect(src).toContain('role="status"')
      expect(src).toContain('aria-live="polite"')
      expect(src).toContain('actionableAnnouncement')
    }
    expect(CAUGHT_UP).toContain('role="status"')
  })

  it('controls have accessible names and adequate tap targets', () => {
    expect(EXPLAINER).toContain('aria-label="Dismiss this explanation"')
    expect(EXPLAINER).toMatch(/w-9 h-9/)
    expect(REMINDER).toMatch(/min-h-\[2\.5rem\]/)
    expect(REMINDER).toContain('aria-hidden="true"')
  })

  it('exactly one guidance panel can render at a time', () => {
    expect(PAGE).toContain("guidanceState === 'first_batch' && <FirstIntroductionsExplainer")
    expect(PAGE).toContain("guidanceState === 'reminder' && (")
    expect(PAGE).toContain("guidanceState === 'caught_up' && <AllCaughtUpNotice />")
    expect(PAGE).toContain("guidanceState !== 'caught_up' && (")
  })
})

// ── 9. Pass-rate measurement ─────────────────────────────────────────────────────────
describe('pass-rate measurement', () => {
  it('is read-only and emits no member identity', () => {
    expect(sqlCode(PASS_RATE)).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT)\b/im)
    expect(PASS_RATE).not.toMatch(/FOR UPDATE|FOR SHARE/i)
    expect(sqlCode(PASS_RATE)).not.toMatch(/'requester_id'|'target_user_id'|full_name|email/)
  })

  it('reports answered, interested, passed and unanswered per weekly window', () => {
    for (const key of ['cards_placed', 'answered', 'answered_rate_pct', 'interested', 'interested_rate_pct',
                       'passed', 'pass_rate_pct', 'unanswered', 'unanswered_rate_pct', 'week_start']) {
      expect(PASS_RATE, key).toContain(`'${key}'`)
    }
  })

  it('counts BOTH ways a member can express interest, so none is lost', () => {
    expect(PASS_RATE).toContain('interested_inplace')
    expect(PASS_RATE).toContain('interested_correlated')
    expect(PASS_RATE).toContain('responds_to_id')
  })

  it('does not double-count: a correlated answer row is not itself a placed card', () => {
    expect(PASS_RATE).toContain('is_card')
    expect(PASS_RATE).toContain('WHERE is_card')
  })

  it('reports the pre-062 reason gap honestly instead of inventing it', () => {
    expect(PASS_RATE).toContain('unrecorded_pre_062')
    expect(PASS_RATE).toMatch(/Never backfilled/)
  })

  it('adds no second tracking authority — it reads card status only', () => {
    expect(sqlCode(PASS_RATE)).not.toMatch(/analytics|telemetry|_log\b/i)
    // 'events_overlapping' is a REPORTING key derived from card status, not a second source
    expect(sqlCode(PASS_RATE)).not.toMatch(/FROM public\.(?!intro_requests)/)
  })
})

// ── all-caught-up agrees with the DATABASE's usable capacity ─────────────────────────
describe('all-caught-up is consistent with database capacity', () => {
  it('appears with zero actionable cards even before cleanup has run', () => {
    // since 085 a stale unavailable row costs the member nothing: it is out of the gate AND out of
    // usable visible capacity, so their full allocation is already available
    expect(resolveGuidanceState({ actionableCount: 0, hasEverReceivedIntroduction: true })).toBe('caught_up')
  })

  it('a never-introduced member still keeps the waiting state', () => {
    expect(resolveGuidanceState({ actionableCount: 0, hasEverReceivedIntroduction: false })).toBe('none')
  })

  it('the page no longer withholds it on a stale row, and says why', () => {
    expect(PAGE).not.toContain('unavailableHoldingCapacity')
    expect(PAGE).toMatch(/costs the member nothing in\s*\n\s*\/\/ the database/)
    const g = readFileSync('lib/introductions/guidance.ts', 'utf8')
    expect(g).toContain('count_usable_visible_cards')
    expect(g).not.toContain('unavailableHoldingCapacity')
  })

  it('the actionable count still equals the rendered cards', () => {
    expect(PAGE).toContain('const actionableCount = allSuggestions.length')
  })
})
