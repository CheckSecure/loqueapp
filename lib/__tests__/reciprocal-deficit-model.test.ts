import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const M093 = readFileSync('supabase/migrations/093_reciprocal_deficit_model.sql', 'utf8')
const M081 = readFileSync('supabase/migrations/081_response_eligibility.sql', 'utf8')
const BATCH = readFileSync('app/api/admin/generate-batch/route.ts', 'utf8')

/**
 * The FUNCTION BODY only, comments stripped.
 *
 * Scoped twice on purpose: the migration's prose documents the removed gate, and its verification
 * block legitimately names count_unresolved_introductions in order to assert the gate is gone. A
 * whole-file check matches both and proves nothing.
 */
const fnBody = M093.slice(
  M093.indexOf('CREATE OR REPLACE FUNCTION public.create_reciprocal_suggestion('),
  M093.indexOf('COMMENT ON FUNCTION public.create_reciprocal_suggestion'))
const code = fnBody.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

describe('093 removes the binary gate and keeps the deficit', () => {
  it('the live body no longer calls the unresolved counter', () => {
    expect(code).not.toContain('count_unresolved_introductions')
    expect(code).not.toContain("RETURN 'unresolved'")
  })

  it('but still enforces capacity at step (5)', () => {
    // Removing the gate must not remove the cap. This is the line that makes it a DEFICIT rather
    // than unlimited: a member at 2 is refused, a member at 1 receives one more.
    expect(code).toContain('a_cards >= max_cards OR b_cards >= max_cards')
    expect(code).toContain("RETURN 'capacity'")
  })

  it('documents the removal rather than deleting it silently', () => {
    expect(M093).toContain('REMOVED IN 093')
    expect(M093).toContain('Act on one, get one; act on both, get two.')
  })

  it('verifies itself, stripping comments before checking', () => {
    // A migration that reported success while leaving the gate live would keep coverage and the
    // batch disagreeing — the entire defect.
    expect(M093).toContain('093 FAILED: the binary unresolved gate is still live')
    expect(M093).toContain('093 FAILED: the deficit capacity check at step (5) is missing')
    expect(M093).toContain("btrim(line) NOT LIKE '--%'")
  })
})

describe('the two paths now agree', () => {
  it('the batch was already the deficit model — unchanged by this migration', () => {
    expect(BATCH).toContain('visibleDeficit(visible, MAX_VISIBLE_INTRO_CARDS)')
    expect(BATCH).toContain('visible_deficit(member) = max(0, MAX_VISIBLE - visible_count(member)). Nothing else.')
  })

  it('081 still defines the counter — it is not dropped', () => {
    // The Wednesday reminder and the post-batch referral nudge both still call it to answer
    // "does this member owe anyone a response", which stays meaningful.
    expect(M081).toContain('CREATE OR REPLACE FUNCTION public.count_unresolved_introductions(')
    expect(M093).not.toContain('DROP FUNCTION public.count_unresolved_introductions')
  })

  it('names the 081 drift-guard inversion', () => {
    // 081 refuses to apply while the function references the counter. After 093 it does not, so a
    // re-run of 081 would consider itself unapplied and restore the gate.
    expect(M081).toContain('DRIFT GUARD 081')
    expect(M093).toContain('THE 081 DRIFT GUARD NOW POINTS THE WRONG WAY')
  })
})
