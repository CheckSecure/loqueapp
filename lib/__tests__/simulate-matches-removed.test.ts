import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

/**
 * THE MATCH SIMULATOR IS GONE, AND MUST STAY GONE.
 *
 * `POST /api/admin/simulate-matches` was added on 2026-04-12 "for test environment" / "test data
 * population". It never acquired an environment guard, and this project has no staging Supabase — so
 * the only database it could ever run against was production, reachable from a green, unconfirmed,
 * one-click "Simulate Matches" button on /dashboard/admin/members.
 *
 * What it wrote were not fixtures. They were real rows:
 *   - `matches` with status 'active' — granting two members permanent mutual profile visibility
 *     through can_discover_profile, unlocking messaging and meetings, and charging no credits;
 *   - `conversations` visible in both members' inboxes;
 *   - `messages` with `sender_id` set to one of the two REAL members and `is_system` left unset
 *     (so: false). That renders as a message attributed by name to a person who never wrote it, and
 *     it increments the recipient's unread badge, which counts exactly `is_system = false` messages.
 *
 * A production audit confirmed it had never created an identifiable row
 * (`admin_notes LIKE 'Simulated match%'` → 0), so nothing had to be cleaned up — the capability was
 * removed before it was ever used, rather than after.
 *
 * A confirmation dialog would not have fixed this. Fabricating member-attributed messages is the
 * capability itself, not a way of misusing it. Legitimate admin match creation already lives in
 * `adminForceMatch`, which is credit- and notification-aware, so nothing operational was lost.
 *
 * These tests exist because "we deleted it" is not a durable guarantee: an endpoint is one file away
 * from returning.
 */

describe('the simulate-matches endpoint no longer exists', () => {
  it('the route file is gone', () => {
    expect(existsSync('app/api/admin/simulate-matches/route.ts')).toBe(false)
  })

  it('the route directory is gone — not merely emptied', () => {
    expect(existsSync('app/api/admin/simulate-matches')).toBe(false)
  })
})

describe('the admin UI no longer exposes it', () => {
  const UI = readFileSync('components/AdminMembersClient.tsx', 'utf8')

  it('no control, handler, or state remains', () => {
    expect(UI).not.toContain('Simulate Matches')
    expect(UI).not.toContain('handleSimulateMatches')
    expect(UI).not.toContain('simulationResult')
    expect(UI).not.toMatch(/setSimulating|\bsimulating\b/)
  })

  it('nothing in the app fetches the endpoint any more', () => {
    expect(UI).not.toContain('/api/admin/simulate-matches')
  })
})

describe('Force Match — the legitimate path — is untouched', () => {
  const UI = readFileSync('components/AdminMembersClient.tsx', 'utf8')

  it('still imports and calls the real admin action', () => {
    expect(UI).toContain("import { adminForceMatch")
    expect(UI).toContain('adminForceMatch(matchUserA, matchUserB, true)')
  })

  it('still renders its button, modal and handler', () => {
    expect(UI).toContain('Force Match')
    expect(UI).toContain('handleForceMatch')
    expect(UI).toContain('showForceMatch')
  })

  it('adminForceMatch still creates real matches — now through the gated RPC', () => {
    const actions = readFileSync('app/actions.ts', 'utf8')
    expect(actions).toContain('export async function adminForceMatch')
    const from = actions.indexOf('export async function adminForceMatch')
    const fn = actions.slice(from, actions.indexOf('\nexport async function', from + 1))

    // UPDATED IN PHASE 3 STAGE 1b. This used to assert two direct INSERTs — from('matches') and
    // from('conversations'). Those moved into public.create_gated_match, which writes both rows in
    // one transaction under the community boundary. The PROPERTIES this test defends are unchanged
    // and are what is asserted below: it is admin-gated BEFORE it writes, it really does create a
    // match (unlike the deleted simulator, which fabricated member-attributed messages), and it
    // notifies and emails both members.
    expect(fn).toContain('createGatedMatch(')
    expect(fn).toContain('sendMatchCreatedEmail')
    expect(fn.slice(0, fn.indexOf('createGatedMatch('))).toMatch(/Not authorized/)

    // No direct match INSERT survives anywhere in this function.
    expect(fn).not.toMatch(/from\('matches'\)[\s\S]{0,200}?\.insert\(/)
    expect(fn).not.toMatch(/from\('conversations'\)[\s\S]{0,200}?\.insert\(/)

    // And it must still refuse rather than proceed when the write does not happen.
    expect(fn).toMatch(/outcome !== 'created'/)
  })
})

describe('other legitimate admin match/introduction paths are intact', () => {
  const present = (f: string, needle: string) => {
    expect(existsSync(f), f).toBe(true)
    expect(readFileSync(f, 'utf8'), f).toContain(needle)
  }

  it('admin-proposed introductions still exist', () => {
    present('lib/introRequests/createAdminIntroPair.ts', 'admin_pending')
  })
  it('the admin batch generator still exists', () => {
    present('app/api/admin/generate-batch/route.ts', 'applyMemberEligibility')
  })
  it('facilitate-intro still exists', () => {
    present('app/api/admin/facilitate-intro/route.ts', 'sendMatchCreatedEmail')
  })
  it('the match inspector overrides still exist', () => {
    present('app/api/admin/admin-create-match/route.ts', 'export async function POST')
    present('app/api/admin/restore-match/route.ts', 'export async function POST')
    present('app/api/admin/unblock/route.ts', 'export async function POST')
  })
  it('the mutual-match finalizer still exists', () => {
    present('lib/introductions/finalizeMutualMatch.ts', 'finalize_mutual_match_atomic')
  })
})

describe('no shared matching machinery was removed with it', () => {
  it('the canonical eligibility filter and its helpers survive', () => {
    const src = readFileSync('lib/matching/eligibility.ts', 'utf8')
    for (const sym of ['applyMemberEligibility', 'filterEligible', 'assertAllEligible', 'ELIGIBILITY_COLUMNS']) {
      expect(src, sym).toContain(`export ${sym.startsWith('ELIGIBILITY') ? 'const' : 'function'} ${sym}`)
    }
  })

  it('every remaining recommendation path still uses the canonical filter', () => {
    for (const f of [
      'app/api/admin/generate-batch/route.ts',
      'app/api/admin/batch/[batchId]/generate-replacements/route.ts',
      'lib/generate-recommendations.ts',
      'lib/opportunities/matching.ts',
    ]) {
      expect(readFileSync(f, 'utf8'), f).toContain('applyMemberEligibility')
    }
  })
})
