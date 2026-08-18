import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DISMISS_CHOICES, isDismissChoice, statusForDismissal, isPermanentDismissal,
} from '@/lib/introRequests/dismissal'
import {
  classifyIntroHistory, buildIntroHistoryExclusions,
  HARD_HISTORY_STATUSES, SOFT_HISTORY_STATUSES,
} from '@/lib/introRequests/history'

/**
 * "I already know them" — a third dismissal choice that records an EXISTING RELATIONSHIP.
 *
 * The three choices must stay analytically distinct (status answers "may this pair be recommended
 * again?", resolution_reason answers "why did the member dismiss it?"), and an already-known pair
 * must never be recommended to EITHER member again — including through the exhaustion safety valve
 * that deliberately releases ordinary passes.
 */

const ACTIONS = readFileSync('app/actions.ts', 'utf8')
const BUTTON = readFileSync('components/RequestIntroButton.tsx', 'utf8')
const MIGRATION = readFileSync('supabase/migrations/062_intro_requests_resolution_reason.sql', 'utf8')

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001'
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002'

// ─────────────────────────────────────────────────────────────────────────────
describe('the three choices map to the right status + reason', () => {
  it('offers exactly three choices', () => {
    expect([...DISMISS_CHOICES]).toEqual(['not_for_me', 'never_show', 'already_know'])
  })

  it('"Not for me" records not_for_me and keeps its SOFT status', () => {
    expect(statusForDismissal('not_for_me')).toBe('passed')
    expect(SOFT_HISTORY_STATUSES.has('passed')).toBe(true)
    expect(isPermanentDismissal('not_for_me')).toBe(false)
  })

  it('"Don\'t show again" records never_show and stays permanent', () => {
    expect(statusForDismissal('never_show')).toBe('hidden_permanent')
    expect(isPermanentDismissal('never_show')).toBe(true)
  })

  it('"I already know them" records already_know and is permanent', () => {
    expect(statusForDismissal('already_know')).toBe('hidden_permanent')
    expect(isPermanentDismissal('already_know')).toBe(true)
  })

  it('does NOT accidentally make "Not for me" permanently excluded', () => {
    // The whole point of keeping 'passed': the exhaustion valve may still release it.
    expect(HARD_HISTORY_STATUSES.has(statusForDismissal('not_for_me'))).toBe(false)
  })

  it('rejects a reason that is not one of the three', () => {
    for (const bad of ['spam', '', null, undefined, 'ALREADY_KNOW', 1]) {
      expect(isDismissChoice(bad)).toBe(false)
    }
    for (const good of DISMISS_CHOICES) expect(isDismissChoice(good)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('an already-known pair is excluded in BOTH directions, forever', () => {
  /** The row a non-reciprocal "already know them" leaves behind: Alice dismissed Bob. */
  const row = {
    requester_id: ALICE,
    target_user_id: BOB,
    status: statusForDismissal('already_know'),
    batch_id: 'batch-1',
  }

  it('excludes Bob when generating for Alice', () => {
    const { hardExcluded } = classifyIntroHistory(ALICE, [row])
    expect(hardExcluded.has(BOB)).toBe(true)
  })

  it('excludes Alice when generating for Bob — the reverse direction, from the SAME row', () => {
    const { hardExcluded } = classifyIntroHistory(BOB, [row])
    expect(hardExcluded.has(ALICE)).toBe(true)
  })

  it('is HARD, so the exhaustion safety valve can never resurrect the pair', () => {
    // The valve drops softExcluded only; a hard exclusion survives it.
    const forAlice = classifyIntroHistory(ALICE, [row])
    expect(forAlice.softExcluded.has(BOB)).toBe(false)
    expect(forAlice.hardExcluded.has(BOB)).toBe(true)
    expect(HARD_HISTORY_STATUSES.has('hidden_permanent')).toBe(true)
  })

  it('is excluded by the pair-wise producer map in both directions too', () => {
    const map = buildIntroHistoryExclusions([row])
    expect(map.get(ALICE)?.has(BOB)).toBe(true)
    expect(map.get(BOB)?.has(ALICE)).toBe(true)
  })

  it('by contrast, "Not for me" stays SOFT and is releasable', () => {
    const passed = { ...row, status: statusForDismissal('not_for_me') }
    const forAlice = classifyIntroHistory(ALICE, [passed])
    expect(forAlice.softExcluded.has(BOB)).toBe(true)
    expect(forAlice.hardExcluded.has(BOB)).toBe(false)
  })

  it('the reciprocal creation RPC also refuses a hidden_permanent pair in either direction', () => {
    const RECIPROCAL = readFileSync('supabase/migrations/050_member_pairs.sql', 'utf8')
    // step (4) of create_reciprocal_suggestion checks both orders and lists hidden_permanent
    expect(RECIPROCAL).toMatch(/ir\.requester_id = lo AND ir\.target_user_id = hi/)
    expect(RECIPROCAL).toMatch(/ir\.requester_id = hi AND ir\.target_user_id = lo/)
    expect(RECIPROCAL).toMatch(/'hidden_permanent'/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('migration 062 is additive and backward-compatible', () => {
  it('adds a NULLABLE column with no default, so existing rows stay valid', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS resolution_reason text NULL/)
    expect(MIGRATION).not.toMatch(/resolution_reason text NOT NULL/)
    expect(MIGRATION).not.toMatch(/SET DEFAULT/)
  })

  it('allows NULL in the CHECK, so code that never sets the column keeps working', () => {
    expect(MIGRATION).toMatch(/resolution_reason IS NULL/)
  })

  it('constrains the reason to exactly the three allowed values', () => {
    expect(MIGRATION).toMatch(/'not_for_me',\s*'never_show',\s*'already_know'/)
  })

  it('introduces NO new recommendation status and does not touch the status CHECK', () => {
    expect(MIGRATION).not.toMatch(/known_contact/)
    // the migration NAMES the status check in prose to say it is untouched — assert it is never
    // altered, rather than never mentioned
    expect(MIGRATION).not.toMatch(/ALTER TABLE[^;]*intro_requests_status_check/i)
    expect(MIGRATION).not.toMatch(/ADD CONSTRAINT intro_requests_status_check/i)
    expect(MIGRATION).not.toMatch(/ADD CONSTRAINT member_pairs_status_check/i)
  })

  it('performs no backfill of existing rows', () => {
    expect(MIGRATION).not.toMatch(/UPDATE public\.intro_requests\s+SET resolution_reason[^;]*WHERE resolution_reason IS NULL/i)
  })

  it('is idempotent (safe to re-run)', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS/)
    expect(MIGRATION).toMatch(/DROP CONSTRAINT IF EXISTS/)
    expect(MIGRATION).toMatch(/CREATE INDEX IF NOT EXISTS/)
    expect(MIGRATION).toMatch(/CREATE OR REPLACE FUNCTION/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the mark_pair_known RPC — atomic, locked, and authorization-scoped', () => {
  it('closes BOTH directions in ONE statement, permanently, with the reason', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('FUNCTION public.mark_pair_known'))
    expect(fn).toMatch(/status = 'hidden_permanent'/)
    expect(fn).toMatch(/resolution_reason = 'already_know'/)
    // one UPDATE keyed on pair_id → both directional rows, never two client round-trips
    expect(fn).toMatch(/WHERE pair_id = pair\.id/)
  })

  it('uses the same locking discipline as the existing pass RPC', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('FUNCTION public.mark_pair_known'))
    expect(fn).toMatch(/pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(pair\.user_a_id/)
    expect(fn).toMatch(/pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(pair\.user_b_id/)
    expect(fn).toMatch(/FOR UPDATE/)
  })

  it('cannot alter an unrelated member\'s recommendations', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('FUNCTION public.mark_pair_known'))
    // the actor must be one of the two participants of THIS pair
    expect(fn).toMatch(/p_actor_id <> pair\.user_a_id AND p_actor_id <> pair\.user_b_id/)
    expect(fn).toMatch(/RETURN 'invalid'/)
  })

  it('is service-role only and hardened like its sibling', () => {
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION public\.mark_pair_known\(uuid, uuid\) FROM PUBLIC, anon, authenticated/)
    expect(MIGRATION).toMatch(/GRANT EXECUTE ON FUNCTION public\.mark_pair_known\(uuid, uuid\) TO service_role/)
    expect(MIGRATION).toMatch(/SECURITY DEFINER/)
    expect(MIGRATION).toMatch(/SET search_path = ''/)
  })

  it('never destroys an existing match', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('FUNCTION public.mark_pair_known'))
    expect(fn).toMatch(/FROM public\.matches m/)
    expect(fn).toMatch(/RETURN 'matched'/)
  })

  it('does not mark the pair as blocked (this is not a negative signal)', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('FUNCTION public.mark_pair_known'))
    expect(fn).not.toMatch(/status = 'blocked'/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the server action routes each choice correctly', () => {
  const action = ACTIONS.slice(ACTIONS.indexOf('export async function passOnSuggestion'), ACTIONS.indexOf('export async function acceptMeeting'))

  it('validates the reason before writing anything', () => {
    expect(action).toMatch(/isDismissChoice\(choice\)/)
    expect(action.indexOf('isDismissChoice')).toBeLessThan(action.indexOf('createAdminClient()'))
  })

  it('sends a reciprocal already-know to the atomic RPC, not to two updates', () => {
    expect(action).toMatch(/choice === 'already_know'/)
    expect(action).toMatch(/rpc\('mark_pair_known'/)
  })

  it('keeps the existing pass RPC for the other two choices', () => {
    expect(action).toMatch(/rpc\('pass_reciprocal_pair'/)
  })

  it('records the reason for ALL THREE choices, not just the new one', () => {
    // non-pair path writes status + reason together
    expect(action).toMatch(/status: statusForDismissal\(choice\)/)
    expect(action).toMatch(/resolution_reason: choice/)
  })

  it('scopes every write to the caller\'s own row', () => {
    expect(action).toMatch(/\.eq\('requester_id', user\.id\)/)
  })

  it('derives the actor from the session, never from client input', () => {
    expect(action).toMatch(/p_actor_id: user\.id/)
  })

  it('creates no match, conversation, message, email or direct notification', () => {
    for (const forbidden of [/from\('matches'\)/, /from\('conversations'\)/, /from\('messages'\)/, /sendEmail/, /resend/i, /createNotification/]) {
      expect(action).not.toMatch(forbidden)
    }
  })

  it('preserves the existing queued-batch promotion behaviour unchanged', () => {
    expect(action).toMatch(/promoteIfResolved\(admin, user\.id\)/)
    expect(action).toMatch(/notifyNewVisibleBatch\(user\.id, promo\.newActive\)/)
  })

  it('generates no replacement recommendation of its own', () => {
    expect(action).not.toMatch(/generateOnboardingRecommendations|create_reciprocal_suggestion/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the card menu', () => {
  it('shows all three options in the required order', () => {
    // measure inside the rendered menu block only — the file's comments mention the same labels
    const menu = BUTTON.slice(BUTTON.indexOf('showPassMenu && ('))
    const i1 = menu.indexOf('Not for me')
    const i2 = menu.indexOf('I already know them')
    const i3 = menu.indexOf("Don't show again")
    expect(i1).toBeGreaterThan(-1)
    expect(i2).toBeGreaterThan(i1)
    expect(i3).toBeGreaterThan(i2)
  })

  it('wires each option to its own choice', () => {
    expect(BUTTON).toMatch(/handlePass\('not_for_me'\)/)
    expect(BUTTON).toMatch(/handlePass\('already_know'\)/)
    expect(BUTTON).toMatch(/handlePass\('never_show'\)/)
  })

  it('resolves the card with the same UX pattern as the existing decline actions', () => {
    // one handler, one state transition — already-know simply takes the permanent branch
    expect(BUTTON).toMatch(/isPermanentDismissal\(choice\) \? 'hidden' : 'passed'/)
  })

  it('no longer passes a boolean "permanent" flag', () => {
    expect(BUTTON).not.toMatch(/handlePass\((true|false)\)/)
  })
})
