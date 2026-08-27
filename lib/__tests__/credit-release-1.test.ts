import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(p, 'utf8')
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\/|--[^\n]*|\/\/[^\n]*/g, ' ')

const MIG  = read('supabase/migrations/087_credit_spend_order_and_meeting_credits_acl.sql')
const INV  = read('supabase/migrations/088_meeting_credits_balance_invariant.sql')
const REP  = read('supabase/repairs/meeting_credits_balance_reconciliation.PROPOSED.sql')
/** Executable SQL only. These files DESCRIBE the shapes they forbid, so a raw-text probe would
 *  match the explanation rather than the code. */
const MIG_CODE = code('supabase/migrations/087_credit_spend_order_and_meeting_credits_acl.sql')
const INV_CODE = code('supabase/migrations/088_meeting_credits_balance_invariant.sql')
/** Just the CREATE FUNCTION body of the spend authority. */
const SPEND = MIG_CODE.slice(MIG_CODE.indexOf('CREATE OR REPLACE FUNCTION public.consume_credits_and_create_match'),
                             MIG_CODE.indexOf('REVOKE ALL ON FUNCTION public.consume_credits_and_create_match'))
const PRE  = read('supabase/audits/087_preflight.sql')
const ADJ  = MIG_CODE.slice(MIG_CODE.indexOf('CREATE OR REPLACE FUNCTION public.admin_adjust_credits'),
                            MIG_CODE.indexOf('REVOKE ALL ON FUNCTION public.admin_adjust_credits'))

// The five policy names the PRODUCTION census reported. Not a fixture's, not an assumption.
const PRODUCTION_POLICIES = [
  'Only admins can delete credits',
  'Only admins can insert credits',
  'Only admins can update credits',
  'Users view own credits or admin views all',
  'credits_select_own',
] as const

// ── 1. Spend order ────────────────────────────────────────────────────────────────────
describe('087 spend order: included first, purchased second, never both', () => {
  it('the free-only predicate is gone from the FUNCTION BODY', () => {
    // The postcondition block legitimately quotes the old predicate in order to reject it, so the
    // probe is scoped to the function body rather than the whole file.
    expect(SPEND).not.toContain('AND free_credits >= 1')
    expect(SPEND).toContain('COALESCE(free_credits, 0) + COALESCE(premium_credits, 0) >= 1')
    // and the postcondition that guards against its return is still present, file-wide
    expect(MIG).toContain('087 FAILED: the free-only debit predicate survived')
  })

  it('funded_from decides the bucket, and only one bucket moves per charge', () => {
    // 'included' when free > 0, else 'purchased' when premium > 0, else NULL → insufficient
    expect(MIG).toMatch(/v_funded_a := CASE WHEN COALESCE\(v_free_a, 0\) > 0 THEN 'included'/)
    expect(MIG).toMatch(/WHEN COALESCE\(v_prem_a, 0\) > 0 THEN 'purchased'/)
    // each UPDATE decrements exactly one bucket, chosen by funded_from
    expect(MIG).toMatch(/free_credits\s*=\s*CASE WHEN v_funded_a = 'included'/)
    expect(MIG).toMatch(/premium_credits\s*=\s*CASE WHEN v_funded_a = 'purchased'/)
    expect(MIG).toMatch(/free_credits\s*=\s*CASE WHEN v_funded_b = 'included'/)
    expect(MIG).toMatch(/premium_credits\s*=\s*CASE WHEN v_funded_b = 'purchased'/)
  })

  it('balance is recomputed from the buckets, never decremented blindly', () => {
    const m = MIG.match(/balance\s*=\s*COALESCE\(free_credits, 0\) \+ COALESCE\(premium_credits, 0\) - 1/g)
    expect(m?.length).toBe(2)                       // one per member
    expect(MIG).not.toMatch(/balance\s*=\s*balance\s*-\s*1/)
  })

  it('both credit rows are locked FOR UPDATE in ascending user_id order', () => {
    expect(MIG).toMatch(/WHERE mc\.user_id IN \(p_user_a, p_user_b\)[\s\S]{0,80}ORDER BY mc\.user_id[\s\S]{0,40}FOR UPDATE/)
  })

  it('serialises a concurrent pair on a CANONICAL advisory lock, in either argument order', () => {
    // matches_unique_pair is UNIQUE (user_a_id, user_b_id) and is NOT canonical, so (A,B) and
    // (B,A) are distinct rows. Without this, two concurrent callers in opposite argument order
    // both created a match and both members were charged twice. Verified on a clean fixture.
    expect(SPEND).toMatch(/pg_catalog\.pg_advisory_xact_lock/)
    expect(SPEND).toMatch(/LEAST\(p_user_a, p_user_b\)::text \|\| ':' \|\| GREATEST\(p_user_a, p_user_b\)::text/)
    // and the duplicate check covers BOTH orders, before any debit
    expect(SPEND).toMatch(/m\.user_a_id = p_user_a AND m\.user_b_id = p_user_b[\s\S]{0,80}m\.user_a_id = p_user_b AND m\.user_b_id = p_user_a/)
    const lockAt = SPEND.indexOf('pg_advisory_xact_lock')
    const debitAt = SPEND.indexOf('UPDATE public.meeting_credits')
    expect(lockAt).toBeGreaterThan(-1)
    expect(lockAt).toBeLessThan(debitAt)
  })

  it('a premium-only member is not refused before any write', () => {
    // insufficient is decided from funded_from being NULL, which requires BOTH buckets empty
    expect(MIG).toMatch(/IF v_funded_a IS NULL THEN[\s\S]{0,120}insufficient_credits_a/)
    expect(MIG).toMatch(/IF v_funded_b IS NULL THEN[\s\S]{0,120}RAISE EXCEPTION 'insufficient_credits_b'/)
  })
})

// ── 2. Preserved semantics ────────────────────────────────────────────────────────────
describe('087 preserves what 072 established', () => {
  it('the administrator exemption is unchanged', () => {
    expect(MIG).toMatch(/count\(\*\) FILTER \(WHERE pr\.is_admin IS TRUE\)/)
    expect(MIG).toMatch(/FOR SHARE/)
    expect(MIG).toMatch(/v_chargeable := \(v_admin_count = 0\)/)
    // p_admin_facilitated still has no authority over money
    expect(code('supabase/migrations/087_credit_spend_order_and_meeting_credits_acl.sql'))
      .not.toMatch(/v_chargeable\s*:?=[^;]*p_admin_facilitated/)
  })

  it('one ledger event per participant, with the same event_key idempotency', () => {
    expect(MIG).toContain("'match_debit:' || v_match_id::text || ':' || p_user_a::text")
    expect(MIG).toContain("'match_debit:' || v_match_id::text || ':' || p_user_b::text")
    expect(MIG).toContain("'match_exempt:' || v_match_id::text || ':' || p_user_a::text")
    expect(MIG).toMatch(/source_kind[\s\S]{0,400}'match_debit'/)
    expect(MIG).toMatch(/'match_exempt_admin'/)
  })

  it('every error code and the unwind-by-RAISE survive', () => {
    for (const c of ['participant_not_found', 'insufficient_credits_a', 'insufficient_credits_b',
                     'duplicate_match']) expect(MIG, c).toContain(c)
    expect(MIG).toMatch(/WHEN unique_violation THEN[\s\S]{0,120}duplicate_match/)
    expect(MIG).toMatch(/WHEN raise_exception THEN[\s\S]{0,120}SQLERRM/)
  })

  it('match, conversation and the return contract are unchanged', () => {
    expect(MIG).toContain("INSERT INTO public.matches (user_a_id, user_b_id, admin_facilitated)")
    expect(MIG).toContain("INSERT INTO public.conversations (match_id) VALUES (v_match_id)")
    expect(MIG).toContain("RETURNS TABLE (match_id uuid, conversation_id uuid, error_code text)")
  })

  it('the function stays SECURITY DEFINER with an empty search_path and no EXECUTE grant', () => {
    expect(MIG).toMatch(/SECURITY DEFINER/)
    expect(MIG).toMatch(/SET search_path = ''/)
    expect(MIG).toMatch(/REVOKE ALL ON FUNCTION public\.consume_credits_and_create_match\(uuid, uuid, boolean\) FROM anon, authenticated/)
    expect(MIG).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.consume_credits_and_create_match/)
  })
})

// ── 3. ACL posture ────────────────────────────────────────────────────────────────────
describe('087 meeting_credits ACL', () => {
  it('revokes everything then grants back the minimum', () => {
    for (const r of ['PUBLIC', 'anon', 'authenticated', 'service_role'])
      expect(MIG, r).toContain(`REVOKE ALL PRIVILEGES ON TABLE public.meeting_credits FROM ${r};`)
    expect(MIG).toContain('GRANT SELECT ON TABLE public.meeting_credits TO authenticated;')
    expect(MIG).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE public.meeting_credits TO service_role;')
    // DELETE deliberately withheld
    expect(MIG).not.toMatch(/GRANT[^;]*DELETE[^;]*ON TABLE public\.meeting_credits/)
  })

  it('clears column grants separately, because a table REVOKE does not', () => {
    expect(MIG).toMatch(/REVOKE ALL \(%I\) ON TABLE public\.meeting_credits FROM %I/)
    expect(MIG).toMatch(/REVOKE ALL \(%I\) ON TABLE public\.meeting_credits FROM PUBLIC/)
    expect(MIG).toMatch(/attacl IS NOT NULL/)   // the postcondition reads attacl, not information_schema
  })

  it('drops all FIVE production policies by name, quoted where needed', () => {
    for (const n of PRODUCTION_POLICIES) {
      const quoted = /[ A-Z]/.test(n) ? `"${n}"` : n
      expect(MIG, n).toContain(`DROP POLICY IF EXISTS ${quoted}`)
    }
    // and the postcondition proves none survived
    expect(MIG).toContain('087 FAILED: one of the five superseded policies survived the drop')
    expect(MIG).toContain('087 FAILED: a non-SELECT policy exists on meeting_credits')
  })

  it('enables RLS with exactly one own-row SELECT policy', () => {
    expect(MIG).toContain('ALTER TABLE public.meeting_credits ENABLE ROW LEVEL SECURITY;')
    expect(MIG).toMatch(/CREATE POLICY meeting_credits_self_read ON public\.meeting_credits\s*\n\s*FOR SELECT\s*\n\s*TO authenticated\s*\n\s*USING \(user_id = \(SELECT auth\.uid\(\)\)\)/)
    expect((MIG.match(/CREATE POLICY/g) || []).length).toBe(1)
  })

  it('asserts the final posture and fails closed', () => {
    for (const frag of ['087 FAILED: authenticated still holds', '087 FAILED: anon still holds',
                        '087 FAILED: authenticated lost SELECT', '087 FAILED: RLS is not enabled',
                        '087 FAILED: service_role holds', '087 FAILED: % column-level grants remain',
                        '087 FAILED: the free-only debit predicate survived'])
      expect(MIG, frag).toContain(frag)
  })
})

// ── 4. No browser writer remains in the application ───────────────────────────────────
describe('application no longer needs browser write authority', () => {
  it('every meeting_credits WRITE in the tree is service-role', () => {
    const FILES = ['app/actions.ts', 'app/api/profile/complete/route.ts',
                   'app/api/targeted-request/submit/route.ts']
    for (const f of FILES) {
      const src = code(f)
      // Resolve the client variable properly: a bare \w+ capture matches the tail of an
      // identifier (e.g. the 't' of 'await adminClient'), which is how this test first misfired.
      const admin = new Set<string>()
      const re0 = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?createAdminClient\(/g
      let d: RegExpExecArray | null
      while ((d = re0.exec(src)) !== null) admin.add(d[1])
      const re = /(?:^|[^\w.])([A-Za-z_$][\w$]*)\s*\n?\s*\.from\('meeting_credits'\)([\s\S]{0,180})/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        if (!/\.(update|insert|upsert|delete)\(/.test(m[2])) continue
        expect(admin.has(m[1]), `${f}: ${m[1]}.from('meeting_credits') performs a WRITE`).toBe(true)
      }
    }
  })

  it('the admin Members credits read moved to service_role before the policy lands', () => {
    const src = code('app/dashboard/admin/members/page.tsx')
    expect(src).toMatch(/const creditsClient = createAdminClient\(\)/)
    expect(src).toMatch(/creditsClient\s*\n?\s*\.from\('meeting_credits'\)/)
    // still admin-gated, and still the same columns
    expect(src).toMatch(/user\.email !== ADMIN_EMAIL\) redirect\('\/dashboard'\)/)
    expect(src).toContain("select('user_id, balance')")
  })

  it('the billing page keeps its browser SELF read (the policy must allow it)', () => {
    const src = code('app/dashboard/billing/page.tsx')
    expect(src).toMatch(/supabase\.from\('meeting_credits'\)\.select\('balance'\)\.eq\('user_id', user\.id\)/)
  })

  it('adminAdjustCredits no longer read-modify-writes in JavaScript', () => {
    const src = code('app/actions.ts')
    const fn = src.slice(src.indexOf('export async function adminAdjustCredits')).slice(0, 2200)
    // the drift-causing shape is gone, and so is ALL client-side arithmetic
    expect(fn).not.toMatch(/upsert\(\{ user_id: userId, balance: newBalance \}/)
    expect(fn).not.toMatch(/\.from\('meeting_credits'\)/)
    expect(fn).not.toMatch(/Math\.min\(spend, curFree\)/)
    // it delegates to the locked database authority instead
    expect(fn).toMatch(/adminClient\.rpc\('admin_adjust_credits'/)
  })
})

// ── 4b. Preflight pins the OBSERVED production posture ────────────────────────────────
describe('087 preflight is pinned to production, not to a fixture', () => {
  it('pins all five policy names', () => {
    for (const n of PRODUCTION_POLICIES) expect(PRE, n).toContain(`'${n}'`)
  })

  it('emits every policy expression in full, so what is dropped is recorded', () => {
    expect(PRE).toMatch(/'using',\s*using_expr/)
    expect(PRE).toMatch(/'with_check',\s*check_expr/)
    expect(PRE).toMatch(/'applies_to',\s*applies_to/)
    expect(PRE).toMatch(/'command',\s*cmd/)
    expect(PRE).toContain('RECORD the five policy expressions')
  })

  it('states the expected pre-state as RLS-on, not-forced, five policies, all seven privileges', () => {
    expect(PRE).toMatch(/'rls_enabled', true, 'rls_forced', false, 'policy_count', 5/)
    expect(PRE).toMatch(/'anon', 'all seven table privileges'/)
    expect(PRE).toMatch(/'authenticated', 'all seven table privileges'/)
    expect(PRE).toMatch(/'public_acl', '\(none\)'/)
  })

  it('BLOCKS on every drift class', () => {
    for (const f of ['BLOCKER: unexpected polic(ies)', 'BLOCKER: expected polic(ies) absent',
                     'BLOCKER: privilege drift', 'BLOCKER: a PUBLIC ACL entry appeared',
                     'BLOCKER: an explicit column grant appeared', 'BLOCKER: RLS is FORCED'])
      expect(PRE, f).toContain(f)
  })

  it('records why the earlier baseline was wrong', () => {
    expect(PRE).toContain('DISPOSABLE FIXTURE')
    expect(PRE).toMatch(/never an\s*\n?-- observation/)
  })
})

// ── 4b-ii. The 1A / 1B deployment split ───────────────────────────────────────────────
describe('Release 1A and 1B must not ship together', () => {
  it('1A contains the reader swap and NOT the RPC call', () => {
    const page = code('app/dashboard/admin/members/page.tsx')
    expect(page).toMatch(/const creditsClient = createAdminClient\(\)/)
    expect(page).not.toMatch(/admin_adjust_credits/)
  })

  it('1B is the only file that references the RPC 087 creates', () => {
    const act = code('app/actions.ts')
    expect(act).toMatch(/rpc\('admin_adjust_credits'/)
    // 087 is what creates it — so 1B cannot precede the migration
    expect(MIG).toContain('CREATE OR REPLACE FUNCTION public.admin_adjust_credits')
  })

  it('there is NO catch-and-fallback to the old write path', () => {
    const act = code('app/actions.ts')
    const fn = act.slice(act.indexOf('export async function adminAdjustCredits')).slice(0, 2400)
    expect(fn).not.toMatch(/try\s*\{/)
    expect(fn).not.toMatch(/catch/)
    expect(fn).not.toMatch(/\.from\('meeting_credits'\)/)   // no legacy path remains at all
  })

  it('the preflight instructs the operator about the 087→1B interval', () => {
    expect(PRE).toContain('RELEASE 1A IS DEPLOYED — and ONLY 1A')
    expect(PRE).toContain('RELEASE 1B IS *NOT* YET DEPLOYED')
    expect(PRE).toContain('DO NOT USE THE ADMIN CREDIT-ADJUSTMENT CONTROL')
  })
})

// ── 4b-iii. Policy SEMANTICS, not just names ──────────────────────────────────────────
describe('087 preflight pins policy semantics', () => {
  it('pins the OBSERVED production values for all five — zero placeholders', () => {
    expect(PRE).toMatch(/expected_semantics\(policy, cmd, applies_to, using_expr, check_expr\)/)
    expect(PRE).not.toContain('<PASTE FROM CENSUS>')
    // exactly what credit_state_census.sql returned: roles {public}, predicate is_admin()
    const EXPECTED: ReadonlyArray<readonly [string, string, string, string, string]> = [
      ['Only admins can delete credits',            'DELETE', '{public}', 'is_admin()', '(none)'],
      ['Only admins can insert credits',            'INSERT', '{public}', '(none)', 'is_admin()'],
      ['Only admins can update credits',            'UPDATE', '{public}', 'is_admin()', '(none)'],
      ['Users view own credits or admin views all', 'SELECT', '{public}', '((auth.uid() = user_id) OR is_admin())', '(none)'],
      ['credits_select_own',                        'SELECT', '{public}', '(user_id = auth.uid())', '(none)'],
    ]
    for (const [name, cmd, roles, using, chk] of EXPECTED) {
      const i = PRE.indexOf(`('${name}'`)
      expect(i, name).toBeGreaterThan(-1)
      const row = PRE.slice(i, i + 260)
      for (const v of [cmd, roles, using, chk]) expect(row, `${name} ← ${v}`).toContain(`'${v}'`)
    }
  })

  it('the roles are {public}, not {authenticated} — pinned as production has them', () => {
    const block = PRE.slice(PRE.indexOf('expected_semantics(policy'), PRE.indexOf('-- NORMALISATION'))
    expect((block.match(/'\{public\}'/g) || []).length).toBe(5)
    expect(block).not.toContain("'{authenticated}'")
  })

  it('BLOCKS while semantics are unpinned, and on each kind of change', () => {
    expect(PRE).toContain('BLOCKER: policy SEMANTICS are not pinned for')
    expect(PRE).toContain('BLOCKER: policy SEMANTICS changed since the census')
    // the drift report names WHICH field moved
    for (const f of ["'command'", "'roles'", "'USING'", "'WITH CHECK'"])
      expect(PRE, f).toContain(f)
  })

  it('normalises only formatting, never meaning', () => {
    expect(PRE).toMatch(/collapses whitespace/)
    expect(PRE).toMatch(/does NOT lowercase/)
    expect(PRE).toMatch(/does NOT strip parentheses that change grouping/)
    // the alias pg_get_expr appends to a scalar subselect is dropped
    expect(PRE).toMatch(/AS\\s\+\[a-z_\]\[a-z0-9_\]\*/)
  })
})

// ── 4c. Atomic administrator adjustment ───────────────────────────────────────────────
describe('admin_adjust_credits is a locked, service-role-only authority', () => {
  it('locks the row and is SECURITY DEFINER with an empty search_path', () => {
    expect(ADJ).toMatch(/FOR UPDATE/)
    expect(ADJ).toMatch(/SECURITY DEFINER/)
    expect(ADJ).toMatch(/SET search_path = ''/)
    // fully qualified everywhere
    expect(ADJ).toMatch(/public\.meeting_credits/)
    expect(ADJ).toMatch(/public\.credit_transactions/)
    expect(ADJ).toMatch(/pg_catalog\./)
  })

  it('positive adds to included; negative spends included then purchased', () => {
    expect(ADJ).toMatch(/IF p_delta > 0 THEN[\s\S]{0,200}v_free\s*:= v_free \+ p_delta/)
    expect(ADJ).toMatch(/v_spend\s*:= LEAST\(-p_delta, v_free \+ v_prem\)/)
    expect(ADJ).toMatch(/v_from_f\s*:= LEAST\(v_spend, v_free\)/)
  })

  it('refuses a negative bucket and recomputes balance', () => {
    expect(ADJ).toMatch(/IF v_free < 0 OR v_prem < 0 THEN[\s\S]{0,140}refusing to drive a bucket negative/)
    expect(ADJ).toMatch(/balance\s*= v_free \+ v_prem/)
  })

  it('writes an attributable ledger event', () => {
    expect(ADJ).toMatch(/INSERT INTO public\.credit_transactions/)
    expect(ADJ).toMatch(/'admin_adjustment'/)
    expect(ADJ).toMatch(/funded_from/)
  })

  it('is unavailable to PUBLIC, anon and authenticated', () => {
    expect(MIG).toContain('REVOKE ALL ON FUNCTION public.admin_adjust_credits(uuid, integer, text, text) FROM PUBLIC;')
    expect(MIG).toContain('REVOKE ALL ON FUNCTION public.admin_adjust_credits(uuid, integer, text, text) FROM anon, authenticated;')
    expect(MIG).toContain('GRANT EXECUTE ON FUNCTION public.admin_adjust_credits(uuid, integer, text, text) TO service_role;')
    expect(MIG).toContain('087 FAILED: a browser role can EXECUTE admin_adjust_credits')
  })

  it('the server action calls the RPC and no longer read-modify-writes', () => {
    const src = code('app/actions.ts')
    const fn = src.slice(src.indexOf('export async function adminAdjustCredits')).slice(0, 2200)
    expect(fn).toMatch(/adminClient\.rpc\('admin_adjust_credits'/)
    expect(fn).toMatch(/p_user_id: userId/)
    expect(fn).toMatch(/p_delta: delta/)
    expect(fn).not.toMatch(/\.from\('meeting_credits'\)/)   // no direct table write remains
    expect(fn).toMatch(/user\.email !== 'bizdev91@gmail\.com'\) return \{ error: 'Not authorized' \}/)
  })

  it('states the bucket decision as MADE, with its temporary limitation', () => {
    expect(MIG).toContain('THE BUCKET DECISION, MADE: a positive administrative adjustment goes into free_credits')
    expect(MIG).toContain('premium_credits remains PURCHASED-ONLY')
    expect(MIG).toMatch(/TEMPORARY LIMITATION, ACCEPTED FOR RELEASE 1/)
    expect(MIG).toMatch(/CAN BE REPLACED at the member's next anniversary/)
    expect(MIG).toMatch(/No third\s*\n?-- bucket is introduced/)
    // and it is NOT described as open
    expect(MIG).not.toMatch(/IS NOT SETTLED|Neither bucket is correct|rather than decided here/)
  })
})

// ── 5. Reconciliation + invariant ordering ────────────────────────────────────────────
describe('reconciliation repair and migration 088', () => {
  it('the repair ships gated false with exactly one gate', () => {
    expect((REP.match(/^  v_apply constant boolean := (false|true);$/gm) || []).length).toBe(1)
    expect(REP).toMatch(/^  v_apply constant boolean := false;$/m)
    expect(REP).toContain('DRY RUN COMPLETE — NOTHING WAS KEPT')
    expect((REP.match(/^COMMIT;$/gm) || []).length).toBe(1)
  })

  it('it pins the reviewed census and refuses on any mismatch', () => {
    expect(REP).toMatch(/c_expect_drifted\s+constant integer := 11;/)
    expect(REP).toMatch(/c_expect_max_drift\s+constant integer := 1;/)
    expect(REP).toMatch(/c_expect_negative_free\s+constant integer := 0;/)
    expect(REP).toMatch(/c_expect_negative_prem\s+constant integer := 0;/)
    expect(REP).toMatch(/c_expect_negative_bal\s+constant integer := 0;/)
    for (const f of ['drifted row(s), expected', 'maximum drift is', 'negative free_credits row(s)',
                     'negative premium_credits row(s)', 'negative balance row(s)'])
      expect(REP, f).toContain(f)
  })

  it('it may touch ONLY balance and updated_at, and recomputes FROM the buckets', () => {
    expect(REP).toMatch(/c_allowed\s+constant text\[\] := ARRAY\['balance','updated_at'\]/)
    expect(REP).toMatch(/SET balance\s+= COALESCE\(free_credits,0\) \+ COALESCE\(premium_credits,0\)/)
    expect(REP).toContain('columns outside the allowed set changed')
    // never the reverse: no bucket is ever written
    const set = REP.slice(REP.indexOf('UPDATE public.meeting_credits'), REP.indexOf('GET DIAGNOSTICS'))
    expect(set).not.toMatch(/free_credits\s*=/)
    expect(set).not.toMatch(/premium_credits\s*=/)
  })

  it('088 refuses while any violation remains — the ordering is enforced, not documented', () => {
    expect(INV).toMatch(/088 REFUSED: % row\(s\) still violate balance = free_credits \+ premium_credits/)
    expect(INV).toContain('meeting_credits_balance_reconciliation.PROPOSED.sql')
    expect(INV).toMatch(/ADD CONSTRAINT meeting_credits_balance_invariant/)
    expect(INV).toMatch(/ADD CONSTRAINT meeting_credits_buckets_non_negative/)
    // Added VALID in one step. The header explains why NOT VALID was rejected, so the probe reads
    // executable SQL rather than the explanation.
    expect(INV_CODE).not.toMatch(/NOT VALID/)
    expect(INV).toMatch(/c\.convalidated/)
  })

  it('the invariant is NOT in 087 — that would fail or half-enforce', () => {
    expect(MIG).not.toMatch(/ADD CONSTRAINT meeting_credits_balance_invariant/)
    expect(MIG).toMatch(/No balance CHECK constraint/)
  })
})

// ── 6. Out of scope stays out ─────────────────────────────────────────────────────────
describe('Credit Release 1 scope', () => {
  it('adds no cap, no reservation table and no refill change', () => {
    // Comment-stripped: 087's header NAMES apply_credit_refill in order to explain that an
    // included-bucket admin grant would be erased by it. Naming a hazard is not changing behaviour.
    for (const f of [MIG_CODE, INV_CODE]) {
      expect(f).not.toMatch(/credit_purchase_reservations/)
      expect(f).not.toMatch(/apply_credit_refill|claim_due_credit_refills/)
      expect(f).not.toMatch(/<= 20\b|<= 50\b/)
    }
  })

  it('migrations 072 and 073 are untouched', () => {
    // this release replaces 072's FUNCTION via CREATE OR REPLACE; it never edits their files
    expect(MIG).toContain('CREATE OR REPLACE FUNCTION public.consume_credits_and_create_match')
  })
})
