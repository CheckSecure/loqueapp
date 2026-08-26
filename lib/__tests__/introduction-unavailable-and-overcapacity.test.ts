import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  selectActionableCards, countActionableCards, overCapacityWarning,
  type ActionableContext, type SuggestedCardRow,
} from '@/lib/introductions/actionableCards'
import { resolveGuidanceState } from '@/lib/introductions/guidance'
import { MAX_VISIBLE_INTRO_CARDS } from '@/lib/introductions/capacity'

/**
 * Two review blockers, pinned.
 *
 * BLOCKER 1 — an unavailable target must not strand anyone. Migration 085 makes the SQL authority
 * and this module agree: a card whose target is missing, inactive, profile-incomplete, test-only,
 * matching-paused, or blocked in EITHER direction is neither counted nor shown.
 *
 * BLOCKER 2 — the visible cap governs CREATION, never DISPLAY. Every actionable card is rendered,
 * however many there are, because hiding one that the strict gate still counts would leave the
 * member unable to reach the card holding them.
 */
const PRED = readFileSync('lib/introductions/actionableCards.ts', 'utf8')
const PAGE = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
const M085 = readFileSync('supabase/migrations/085_unavailable_target_release.sql', 'utf8')
const M081 = readFileSync('supabase/migrations/081_response_eligibility.sql', 'utf8')
const CENSUS = readFileSync('supabase/audits/unavailable_target_census.sql', 'utf8')
const CLEANUP = readFileSync('supabase/repairs/unavailable_cards_release.PROPOSED.sql', 'utf8')

const ctx = (over: Partial<Record<keyof ActionableContext, string[]>> = {}): ActionableContext => ({
  matchedTargetIds: new Set(over.matchedTargetIds ?? []),
  unavailableTargetIds: new Set(over.unavailableTargetIds ?? []),
  incomingInterestTargetIds: new Set(over.incomingInterestTargetIds ?? []),
  answeredTargetIds: new Set(over.answeredTargetIds ?? []),
})
const cards = (n: number): SuggestedCardRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `r${i}`, target_user_id: `t${i}`, status: 'suggested',
    target: { id: `t${i}`, account_status: 'active' },
  }))

// ── BLOCKER 2: nothing is ever hidden ────────────────────────────────────────────────
describe('over-capacity cards stay actionable', () => {
  it('renders THREE actionable cards, and the count matches', () => {
    const got = selectActionableCards(cards(3), ctx())
    expect(got).toHaveLength(3)
    expect(countActionableCards(got)).toBe(3)
    expect(got.map((c) => c.id)).toEqual(['r0', 'r1', 'r2'])   // none dropped
  })

  it('renders FOUR actionable cards, and the count matches', () => {
    const got = selectActionableCards(cards(4), ctx())
    expect(got).toHaveLength(4)
    expect(countActionableCards(got)).toBe(4)
    expect(got.map((c) => c.id)).toEqual(['r0', 'r1', 'r2', 'r3'])
  })

  it('the reminder count equals the rendered card count at every size', () => {
    for (const n of [1, 2, 3, 4, 7]) {
      const got = selectActionableCards(cards(n), ctx())
      expect(got.length, `${n}`).toBe(n)
      expect(countActionableCards(got), `${n}`).toBe(got.length)
      expect(resolveGuidanceState({ actionableCount: got.length, hasEverReceivedIntroduction: true })).toBe('reminder')
    }
  })

  it('over-capacity is a SERVER warning, never a member-facing error', () => {
    expect(overCapacityWarning(2, MAX_VISIBLE_INTRO_CARDS)).toBeNull()
    expect(overCapacityWarning(1, MAX_VISIBLE_INTRO_CARDS)).toBeNull()
    expect(overCapacityWarning(0, MAX_VISIBLE_INTRO_CARDS)).toBeNull()
    const w = overCapacityWarning(4, MAX_VISIBLE_INTRO_CARDS)
    expect(w).toContain('4 actionable cards')
    expect(w).toContain('above the visible cap of 2')
    expect(w).toContain('none is hidden')
    // it goes to the log, and the member sees nothing unusual
    expect(PAGE).toContain('const warning = overCapacityWarning(allSuggestions.length, MAX_VISIBLE_INTRO_CARDS)')
    expect(PAGE).toContain('if (warning) console.warn(warning)')
  })

  it('no cap, no slice, anywhere in the canonical derivation', () => {
    expect(PRED).not.toMatch(/\.slice\(/)
    expect(PRED).not.toMatch(/\bcap\b\s*[:?]/)
    expect(PAGE).not.toMatch(/selectActionableCards\([\s\S]{0,900}RECOMMENDATIONS_PER_BATCH,\s*\n\s*\)/)
    expect(PAGE).not.toMatch(/allSuggestions[\s\S]{0,80}\.slice\(0,/)
    expect(PRED).toContain('NO DISPLAY CAP')
  })

  it('nothing over capacity is deleted, hidden, passed or expired by the UI', () => {
    const guidance = PAGE.slice(PAGE.indexOf('THE actionable set'), PAGE.indexOf('Featured = first'))
    expect(guidance).not.toMatch(/\.update\(|\.delete\(|\.rpc\(|\.insert\(/)
    expect(guidance).not.toMatch(/'passed'|'expired'|hidden_permanent|release_unavailable/)
  })
})

// ── BLOCKER 1: the two predicates agree ──────────────────────────────────────────────
describe('unavailable targets: SQL authority and UI predicate agree', () => {
  const FIELDS = ['account_status', 'profile_complete', 'is_test_account', 'matching_paused']

  it('085 defines availability once, and every category is in it', () => {
    const avail = M085.slice(M085.indexOf('CREATE OR REPLACE FUNCTION public.is_available_intro_target'),
                             M085.indexOf('REVOKE ALL ON FUNCTION public.is_available_intro_target'))
    for (const f of FIELDS) expect(avail, f).toContain(f)
    expect(avail).toContain('public.blocked_users')
    expect(avail).toMatch(/bu\.user_id = p_member_id AND bu\.blocked_user_id = p_target_id/)
    expect(avail).toMatch(/bu\.user_id = p_target_id AND bu\.blocked_user_id = p_member_id/)
    // and the gate, the capacity count and the neutraliser all go through it
    for (const fnName of ['count_unresolved_introductions', 'count_usable_visible_cards', 'neutralize_unavailable_pair']) {
      const body = M085.slice(M085.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}`))
      expect(body.slice(0, body.indexOf('REVOKE ALL')), fnName).toContain('is_available_intro_target')
    }
  })

  it('and keeps every exclusion 081 already had', () => {
    const body = M085.slice(M085.indexOf('CREATE OR REPLACE FUNCTION public.count_unresolved_introductions'),
                            M085.indexOf('REVOKE ALL ON FUNCTION public.count_unresolved_introductions'))
    expect(body).toContain("s.status = 'suggested'")
    expect(body).toContain('p_exclude_release')
    expect(body).toContain('p_exclude_batch')
    expect(body).toContain('public.matches')
    expect(body).toMatch(/accepted_pending_payment/)
  })

  it('the UI resolves availability from those exact fields, plus blocking both ways', () => {
    for (const f of FIELDS) expect(PAGE, f).toContain(f)
    expect(PAGE).toContain("from('blocked_users')")
    expect(PAGE).toMatch(/blocked_user_id\.in/)
    expect(PAGE).toContain('unavailableIds.add')
    // a counterpart whose profile row does not come back is unavailable, not silently actionable
    expect(PAGE).toMatch(/if \(!seen\.has\(id\)\) unavailableIds\.add\(id\)/)
  })

  it('a blocked target is excluded from BOTH — so it can neither strand nor be shown', () => {
    expect(selectActionableCards(cards(1), ctx({ unavailableTargetIds: ['t0'] }))).toHaveLength(0)
    expect(M085).toContain('blocked_users')
    expect(PRED).toContain('blocked in EITHER direction')
  })

  it('an available target still counts — the strict gate is corrected, not disarmed', () => {
    expect(selectActionableCards(cards(1), ctx())).toHaveLength(1)
    expect(M081).toContain('count_unresolved_introductions')
    expect(M085).not.toMatch(/DROP FUNCTION public\.(create_reciprocal_suggestion|place_batch_rows|promote_queued_rows|materialize_admin_pair)/)
  })
})

describe('the neutral system transition', () => {
  const fn = M085.slice(M085.indexOf('CREATE OR REPLACE FUNCTION public.neutralize_unavailable_pair'),
                        M085.indexOf('REVOKE ALL ON FUNCTION public.neutralize_unavailable_pair'))

  it('writes a NEUTRAL status and a SYSTEM reason — never a member verdict', () => {
    expect(fn).toContain("status = 'expired'")
    expect(fn).toContain("resolution_reason = 'system_pair_unavailable'")
    expect(fn).not.toContain("'passed'")
    expect(fn).not.toContain("'hidden_permanent'")
    expect(fn).not.toMatch(/'not_for_me'|'never_show'|'already_know'/)
  })

  it('the new reason is added to the allowlist without removing a member choice', () => {
    const cons = M085.slice(M085.indexOf('ADD CONSTRAINT intro_requests_resolution_reason_check'),
                            M085.indexOf('COMMENT ON COLUMN public.intro_requests.resolution_reason'))
    for (const v of ['not_for_me', 'never_show', 'already_know', 'system_pair_unavailable']) {
      expect(cons, v).toContain(v)
    }
    expect(cons).toContain('resolution_reason IS NULL')
    expect(M085).toContain('is NEVER a member verdict')
  })

  it('no status value is invented — the status CHECK is untouched', () => {
    // asserted on CODE: the header comment legitimately explains that it is left alone
    const code = M085.replace(/--.*$/gm, ' ')
    expect(code).not.toContain('intro_requests_status_check')
  })

  it('holds both advisory locks in canonical order, like every other writer', () => {
    expect(fn).toContain('pg_catalog.pg_advisory_xact_lock')
    expect(fn).toMatch(/v_lo := LEAST\(/)
    expect(fn).toMatch(/v_hi := GREATEST\(/)
    // every row it will change is re-read FOR UPDATE after the locks are taken
    expect(fn).toMatch(/SELECT \* INTO v_card FROM public\.intro_requests WHERE id = p_card_id FOR UPDATE/)
    expect(fn).toMatch(/SELECT \* INTO v_other FROM public\.intro_requests WHERE id = v_ids\[1\] FOR UPDATE/)
    // and every UPDATE re-asserts the status, so a concurrent response cannot be overwritten
    for (const m of fn.match(/UPDATE public\.intro_requests[\s\S]{0,400}?;/g) || []) {
      expect(m).toMatch(/WHERE id = [\w.\[\]]+ AND status = 'suggested' AND responds_to_id IS NULL/)
    }
  })

  it('refuses rather than guessing whenever real state would be destroyed', () => {
    for (const outcome of ['not_actionable', 'target_available', 'matched', 'finalized', 'not_found',
                           'not_a_placement_card', 'malformed', 'changed_concurrently']) {
      expect(fn, outcome).toContain(`'${outcome}'`)
    }
  })

  it('keeps reciprocal pair state consistent and never half-closes', () => {
    expect(fn).toContain('both_sides_closed')
    expect(fn).toContain('counterpart_authored')
    expect(fn).toContain('public.member_pairs')
    expect(fn).toMatch(/status NOT IN \('matched','blocked','expired'\)/)
    expect(fn).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.intro_requests x[\s\S]{0,220}status = 'suggested'\)/)
    // the counterpart is found by the placement-card predicate, never LIMIT 1 over mixed rows
    expect(fn).toContain('x.responds_to_id IS NULL')
    expect(fn.replace(/--.*$/gm, ' ')).not.toContain('LIMIT 1')  // code only; the comments explain why
    expect(fn).toContain("'malformed'")
  })

  it('creates no match, conversation, notification, email, credit or replacement card', () => {
    expect(fn).not.toMatch(/notifications|conversations|meeting_credits|credit_transactions|INSERT INTO public\.matches/)
    expect(fn).not.toMatch(/create_reciprocal_suggestion|place_batch_rows|promote_queued_rows|generate/i)
    expect(fn).not.toMatch(/INSERT INTO public\.intro_requests/)
  })

  it('discloses no one-sided interest — both rows get the same neutral state', () => {
    const closes = fn.match(/resolution_reason = 'system_pair_unavailable'/g) || []
    expect(closes.length).toBe(2)   // counterpart and self, identical
  })

  it('is privilege-hardened with an empty search_path', () => {
    expect(M085).toContain("SET search_path = ''")
    expect(M085).toContain('REVOKE ALL ON FUNCTION public.neutralize_unavailable_pair(uuid) FROM PUBLIC, anon, authenticated')
    expect(M085).toContain('GRANT EXECUTE ON FUNCTION public.neutralize_unavailable_pair(uuid) TO service_role')
  })
})

describe('085 does not backfill, and the cleanup is separate and gated', () => {
  it('the migration rewrites no historical row', () => {
    const code = M085.replace(/--.*$/gm, ' ')
    expect(code).not.toMatch(/^(INSERT|UPDATE|DELETE)/m)       // no top-level DML
    expect(M085).toContain('NO BACKFILL')
    expect(M085).toContain('This migration writes no row')
  })

  it('the census is read-only, mutually exclusive, and emits no identity', () => {
    expect(CENSUS).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT)\b/im)
    for (const b of ['target_missing', 'target_inactive', 'target_profile_incomplete', 'target_test_account',
                     'target_matching_paused', 'blocked_either_direction', 'orphaned_pair_row',
                     'malformed_row', 'otherwise_actionable']) {
      expect(CENSUS, b).toContain(b)
    }
    expect(CENSUS).toContain("'reconciles'")
    expect(CENSUS).toContain('No member identity is emitted')
  })

  it('the cleanup artifact is gated false and rolls back by default', () => {
    expect(CLEANUP).toMatch(/^ {2}v_apply constant boolean := false;$/m)
    expect((CLEANUP.match(/v_apply constant boolean := (false|true);/g) || []).length).toBe(1)
    expect(CLEANUP).toContain('DRY RUN COMPLETE — NOTHING WAS KEPT')
    expect(CLEANUP).toContain('neutralize_unavailable_pair')   // neutral transitions only
    // it never ASSIGNS a member-authored reason (it only checks that none was written)
    expect(CLEANUP).not.toMatch(/resolution_reason\s*=\s*'(not_for_me|never_show|already_know)'/)
    expect(CLEANUP).not.toMatch(/status\s*=\s*'passed'/)
  })

  it('the cleanup proves its own pre/post counts and pair consistency', () => {
    expect(CLEANUP).toContain('v_before')
    expect(CLEANUP).toContain('v_after')
    expect(CLEANUP).toContain('HALF-CLOSED PAIRS')
    expect(CLEANUP).toContain('left half-closed')
    expect(CLEANUP).toContain('a member-authored reason was written by this run')
  })

  it('and it is NOT embedded in the migration', () => {
    expect(M085).not.toContain('v_apply')
    expect(M085).toContain('supabase/repairs/unavailable_cards_release.PROPOSED.sql')
  })
})

// ── Capacity recovery: the second review blocker ─────────────────────────────────────
describe('unavailable cards recover CAPACITY, not just gate eligibility', () => {
  const M085b = readFileSync('supabase/migrations/085_unavailable_target_release.sql', 'utf8')
  const WORKER = readFileSync('lib/introductions/expiryWorker.ts', 'utf8')

  it('names the real capacity authority and says why excluding was not enough', () => {
    expect(M085b).toContain("status = 'suggested' AND capacity_released_at IS NULL")
    expect(M085b).toContain('WHY EXCLUDING FROM THE GATE WAS NOT ENOUGH')
    expect(M085b).toMatch(/an unavailable pair must neither block the strict unanswered gate NOR consume/i)
  })

  it('all four writers reconcile INSIDE their locks, before anything is counted', () => {
    for (const w of ['create_reciprocal_suggestion', 'place_batch_rows', 'promote_queued_rows', 'materialize_admin_pair']) {
      const i = M085b.indexOf(`CREATE OR REPLACE FUNCTION public.${w}(`)
      expect(i, w).toBeGreaterThan(-1)
      const body = M085b.slice(i, M085b.indexOf('\n$$;', i))
      expect(body, `${w}: usable capacity`).toContain('count_usable_visible_cards')
      expect(body, `${w}: no raw count`).not.toContain("status = 'suggested' AND ir.capacity_released_at IS NULL")
      expect(body, `${w}: never neutralises`).not.toContain('neutralize_unavailable_pair')
      expect(body, `${w}: still locks`).toContain('pg_advisory_xact_lock')
    }
  })

  it('the migration refuses to commit if a writer regresses', () => {
    expect(M085b).toContain('does not use count_usable_visible_cards')
    expect(M085b).toContain('still counts RAW suggested rows for capacity')
    expect(M085b).toContain('Writers are read-only with respect to')
  })

  it('names the raw-versus-usable distinction and proves the cap still holds', () => {
    expect(M085b).toContain('RAW      every placement card still')
    expect(M085b).toContain('THE CAP STILL HOLDS')
    expect(M085b).toMatch(/USABLE can never exceed/)
    expect(readFileSync('lib/introductions/actionableCards.ts', 'utf8')).toContain('RAW ROWS vs USABLE CARDS')
  })

  it('there is NO lock-bypassing function left, under any name', () => {
    // the ONLY mentions left are the postcondition that refuses them if they are deployed
    const guard = M085b.slice(M085b.indexOf('NO LOCK-BYPASS SIGNATURE MAY EXIST'))
    for (const gone of ['release_unavailable_introduction', 'reconcile_unavailable_introductions']) {
      const code = M085b.replace(/--.*$/gm, ' ')
      const outsideGuard = code.split(gone).length - 1 - (guard.split(gone).length - 1)
      expect(outsideGuard, `${gone} still used`).toBe(0)
    }
    expect(M085b).not.toContain('p_skip_locks')
    expect(M085b).not.toContain('skip_locks boolean')
    // and the migration refuses to commit if one is deployed
    expect(M085b).toContain('a lock-bypassing neutraliser is deployed')
    expect(M085b).toContain('exactly one 1-argument signature is permitted')
  })

  it('the writers are READ-ONLY with respect to unavailable rows', () => {
    expect(M085b).not.toContain('p_skip_locks')
    expect(M085b).toMatch(/deadlock waiting to happen/i)
  })
})

describe('the maintenance sweep', () => {
  const M085b = readFileSync('supabase/migrations/085_unavailable_target_release.sql', 'utf8')
  const WORKER = readFileSync('lib/introductions/expiryWorker.ts', 'utf8')
  const fn = M085b.slice(M085b.indexOf('CREATE OR REPLACE FUNCTION public.sweep_unavailable_introductions'),
                         M085b.indexOf('REVOKE ALL ON FUNCTION public.sweep_unavailable_introductions'))

  it('is bounded, deterministic and clamps an absurd limit', () => {
    expect(fn).toContain('LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)')
    expect(fn).toContain('ORDER BY s.created_at, s.id')
    expect(fn).toContain('LIMIT v_limit')
  })

  it('takes the canonical member locks (it does NOT skip them)', () => {
    expect(fn).toContain('public.neutralize_unavailable_pair(r.id)')
  })

  it('reports aggregate counts and survives a partial failure', () => {
    for (const k of ['processed', 'released', 'skipped', 'failed', 'truncated', 'outcomes']) {
      expect(fn, k).toContain(`'${k}'`)
    }
    expect(fn).toContain('EXCEPTION WHEN OTHERS THEN')
    expect(fn).toContain("'error_' || SQLSTATE")
  })

  it('logs no private profile data', () => {
    expect(fn.replace(/--.*$/gm, ' ')).not.toMatch(/full_name|'email'/)
    expect(fn).toMatch(/nothing about the member is recorded/i)
  })

  it('creates nothing — no replacement card, notification or email', () => {
    expect(fn).not.toMatch(/INSERT INTO|notifications|send|email/i)
  })

  it('is service-role only', () => {
    expect(M085b).toContain('REVOKE ALL ON FUNCTION public.sweep_unavailable_introductions(integer) FROM PUBLIC, anon, authenticated')
    expect(M085b).toContain('GRANT EXECUTE ON FUNCTION public.sweep_unavailable_introductions(integer) TO service_role')
  })

  it('rides the EXISTING maintenance stage rather than a new cron', () => {
    expect(WORKER).toContain("admin.rpc('sweep_unavailable_introductions'")
    expect(WORKER).toContain('maxUnavailable')
    expect(WORKER).toMatch(/rather than in a cron of its own/i)
    // no new route or vercel.json cron entry
    expect(readFileSync('vercel.json', 'utf8')).not.toMatch(/unavailable|sweep/i)
  })

  it('is explicitly NOT the correctness mechanism', () => {
    expect(WORKER).toMatch(/IT IS NOT THE CORRECTNESS MECHANISM/)
    expect(WORKER.replace(/\s*\n\s*\/\/\s*/g, ' ')).toMatch(/can never reduce a member's\s+weekly allocation/)
    expect(M085b).toMatch(/delayed sweep cannot reduce anyone/i)
  })

  it('reports aggregates to the log and nothing about a member', () => {
    const block = WORKER.slice(WORKER.indexOf('UNAVAILABLE-PAIR SWEEP'))
    expect(block).toContain("console.log('[intro-expiry] unavailable sweep:'")
    // asserted on CODE: the comment legitimately says it logs no id, name or email
    expect(block.replace(/\/\/.*$/gm, ' ')).not.toMatch(/full_name|email|requester_id|target_user_id/)
    expect(block).toContain("(error as any).code ?? 'unknown'")   // coarse class only
  })

  it('does not run during migration apply and backfills nothing', () => {
    const code = M085b.replace(/--.*$/gm, ' ')
    expect(code).not.toMatch(/SELECT public\.sweep_unavailable_introductions/)
    expect(code).not.toMatch(/PERFORM public\.sweep_unavailable_introductions/)
  })
})

describe('the reason names the PAIR', () => {
  const ALL = [
    'supabase/migrations/085_unavailable_target_release.sql',
    'supabase/audits/085_preflight.sql', 'supabase/audits/085_postapply.sql',
    'supabase/audits/unavailable_target_census.sql', 'supabase/audits/introduction_pass_rate.sql',
    'supabase/repairs/unavailable_cards_release.PROPOSED.sql',
    'lib/introductions/actionableCards.ts', 'lib/introductions/guidance.ts',
    'app/dashboard/introductions/page.tsx', 'lib/introductions/expiryWorker.ts',
  ]

  it('no proposed or application artifact still USES system_target_unavailable', () => {
    for (const f of ALL) {
      const code = f.endsWith('.sql')
        ? readFileSync(f, 'utf8').replace(/--.*$/gm, ' ')
        : readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ')
      expect(code, f).not.toContain('system_target_unavailable')
    }
    // the ONLY surviving mention is the migration comment explaining why the name was wrong
    const m = readFileSync(ALL[0], 'utf8')
    expect(m).toContain('An earlier draft called it system_target_unavailable')
    expect((m.match(/system_target_unavailable/g) || []).length).toBe(1)
  })

  it('and the migration explains why the target-named version was untruthful', () => {
    const m = readFileSync(ALL[0], 'utf8')
    expect(m).toContain('WHY THE REASON NAMES THE PAIR, NOT THE TARGET')
    expect(m).toMatch(/targets A, who is still perfectly available/)
    expect(m).toContain('system_pair_unavailable is true of BOTH rows')
  })

  it('it stays neutral, system-authored, and outside Pass and Interest', () => {
    const pr = readFileSync('supabase/audits/introduction_pass_rate.sql', 'utf8')
    expect(pr).toMatch(/state = 'expired_without_an_answer'\s*\n\s*AND resolution_reason = 'system_pair_unavailable'/)
    expect(pr).toMatch(/It sits under EXPIRED, never under PASSED/)
    const m = readFileSync(ALL[0], 'utf8')
    expect(m).toContain('is NEVER a member verdict')
  })
})
