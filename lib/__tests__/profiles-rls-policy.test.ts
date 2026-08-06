import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { decideDiscoverability, DISCOVERY_GRANT_STATUSES, type IntroRow } from '@/lib/privacy/canViewerDiscoverMember'

/**
 * Migration 043 RLS-policy SIMULATION.
 *
 * Postgres RLS can't be exercised in this test runner, so instead we (1) model the
 * migration's SQL predicate as a pure TS mirror and prove it is byte-for-byte
 * equivalent to the shared helper decideDiscoverability across the FULL status ×
 * direction matrix (the "one definition, two mirrors" guarantee), and (2)
 * structurally verify the migration SQL matches DISCOVERY_GRANT_STATUSES and the
 * direction rules. Actual RLS behavior is verified on a staging DB per the rollout
 * plan; this locks the SQL to the app helper so they cannot drift.
 */

const V = 'viewer', M = 'member'

// Faithful TS mirror of the USING(...) clause in 043_profiles_relationship_read_policy.sql.
const GRANT = new Set(DISCOVERY_GRANT_STATUSES)
function rlsSelectable(
  viewerId: string,
  memberId: string,
  ctx: { blocks: any[]; matches: any[]; intros: IntroRow[] },
): boolean {
  if (viewerId === memberId) return true
  const blocked = ctx.blocks.some(
    (b) => (b.user_id === viewerId && b.blocked_user_id === memberId) || (b.user_id === memberId && b.blocked_user_id === viewerId),
  )
  if (blocked) return false
  const match = ctx.matches.some(
    (m) => m.status !== 'removed' &&
      ((m.user_a_id === viewerId && m.user_b_id === memberId) || (m.user_b_id === viewerId && m.user_a_id === memberId)),
  )
  if (match) return true
  return ctx.intros.some((ir) =>
    GRANT.has(ir.status) && (
      (ir.is_admin_initiated !== true && ir.requester_id === viewerId && ir.target_user_id === memberId) ||
      (ir.is_admin_initiated === true && (
        (ir.requester_id === viewerId && ir.target_user_id === memberId) ||
        (ir.requester_id === memberId && ir.target_user_id === viewerId))) ||
      (ir.is_admin_initiated !== true && ir.requester_id === memberId && ir.target_user_id === viewerId && ir.status === 'approved')
    ),
  )
}

// Every status in the intro_requests CHECK constraint (migration 021).
const ALL_STATUSES = [
  'suggested', 'queued', 'pending', 'accepted', 'admin_pending', 'approved',
  'passed', 'hidden', 'hidden_permanent', 'archived', 'declined', 'rejected',
  'expired', 'accepted_pending_payment',
]

describe('RLS predicate ≡ decideDiscoverability (full matrix)', () => {
  it('agrees for self / match / blocked', () => {
    // self
    expect(rlsSelectable(V, V, { blocks: [], matches: [], intros: [] }))
      .toBe(decideDiscoverability({ viewerId: V, memberId: V, isBlocked: false, hasActiveMatch: false, introRows: [] }))
    // active match
    expect(rlsSelectable(V, M, { blocks: [], matches: [{ user_a_id: V, user_b_id: M, status: 'active' }], intros: [] }))
      .toBe(decideDiscoverability({ viewerId: V, memberId: M, isBlocked: false, hasActiveMatch: true, introRows: [] }))
    // blocked overrides match
    expect(rlsSelectable(V, M, { blocks: [{ user_id: V, blocked_user_id: M }], matches: [{ user_a_id: V, user_b_id: M, status: 'active' }], intros: [] }))
      .toBe(decideDiscoverability({ viewerId: V, memberId: M, isBlocked: true, hasActiveMatch: true, introRows: [] }))
  })

  it('agrees for every status × direction × admin-flag combination', () => {
    for (const status of ALL_STATUSES) {
      for (const admin of [true, false]) {
        for (const dir of ['v2m', 'm2v'] as const) {
          const ir: IntroRow = {
            requester_id: dir === 'v2m' ? V : M,
            target_user_id: dir === 'v2m' ? M : V,
            status,
            is_admin_initiated: admin,
          }
          const fromHelper = decideDiscoverability({ viewerId: V, memberId: M, isBlocked: false, hasActiveMatch: false, introRows: [ir] })
          const fromRls = rlsSelectable(V, M, { blocks: [], matches: [], intros: [ir] })
          expect(fromRls, `status=${status} admin=${admin} dir=${dir}`).toBe(fromHelper)
        }
      }
    }
  })

  it('queued never grants; a full-table scan returns only related rows (no enumeration)', () => {
    const rows = [
      { id: 'self', ctx: { blocks: [], matches: [], intros: [] } }, // handled by self check separately
      { id: 'conn', ctx: { blocks: [], matches: [{ user_a_id: V, user_b_id: 'conn', status: 'active' }], intros: [] } },
      { id: 'shown', ctx: { blocks: [], matches: [], intros: [{ requester_id: V, target_user_id: 'shown', status: 'suggested', is_admin_initiated: false }] } },
      { id: 'inc', ctx: { blocks: [], matches: [], intros: [{ requester_id: 'inc', target_user_id: V, status: 'approved', is_admin_initiated: false }] } },
      { id: 'queuedOnly', ctx: { blocks: [], matches: [], intros: [{ requester_id: V, target_user_id: 'queuedOnly', status: 'queued', is_admin_initiated: false }] } },
      { id: 'stranger', ctx: { blocks: [], matches: [], intros: [] } },
      { id: 'blk', ctx: { blocks: [{ user_id: V, blocked_user_id: 'blk' }], matches: [{ user_a_id: V, user_b_id: 'blk', status: 'active' }], intros: [] } },
    ]
    const visible = rows.filter((r) => rlsSelectable(V, r.id, r.ctx as any)).map((r) => r.id)
    expect(visible.sort()).toEqual(['conn', 'inc', 'shown']) // NOT queuedOnly, stranger, blk
  })
})

// ── Structural: migration SQL is aligned + correct ───────────────────────────
describe('migration 043 SQL', () => {
  const sql = readFileSync('supabase/migrations/043_profiles_relationship_read_policy.sql', 'utf8')

  it('drops the permissive policy and delegates to the SECURITY DEFINER function', () => {
    expect(sql).toContain('DROP POLICY IF EXISTS profiles_authenticated_read ON public.profiles')
    expect(sql).toContain('CREATE POLICY profiles_relationship_read ON public.profiles')
    expect(sql).toContain('USING (public.can_discover_profile(id))')
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('TO authenticated')
  })

  it('the function is SECURITY DEFINER, search-path-pinned, unspoofable, execute-restricted', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.can_discover_profile(member_id uuid)')
    expect(sql).toContain('SECURITY DEFINER')
    expect(sql).toContain('SET search_path = public, pg_temp')
    expect(sql).toContain('auth.uid() = member_id') // viewer derived internally, not a spoofable param
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.can_discover_profile(uuid) FROM public')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.can_discover_profile(uuid) TO authenticated')
    // returns only a boolean
    expect(sql).toMatch(/RETURNS boolean/)
  })

  it('grant-status list mirrors DISCOVERY_GRANT_STATUSES exactly and excludes queued', () => {
    for (const s of DISCOVERY_GRANT_STATUSES) expect(sql).toContain(`'${s}'`)
    // queued must NOT appear in the grant IN(...) list
    const inList = sql.slice(sql.indexOf('ir.status IN ('), sql.indexOf(')', sql.indexOf('ir.status IN (')))
    expect(inList).not.toContain("'queued'")
  })

  it('encodes the direction rules (viewer-shown, admin-both, approved-incoming)', () => {
    expect(sql).toContain('ir.requester_id = auth.uid() AND ir.target_user_id = member_id')
    expect(sql).toContain('ir.is_admin_initiated IS TRUE')
    expect(sql).toMatch(/ir\.requester_id = member_id\s+AND ir\.target_user_id = auth\.uid\(\) AND ir\.status = 'approved'/)
    expect(sql).toContain('blocked_users')
  })

  it('adds the safe public_profiles view (security_invoker, no sensitive columns) and preserves service-role', () => {
    expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.public_profiles[\s\S]*security_invoker = on/)
    for (const forbidden of ['email', 'stripe_customer_id', 'subscription', 'is_admin', 'trust_score', 'verification_metadata']) {
      const viewBody = sql.slice(sql.indexOf('CREATE OR REPLACE VIEW'))
      expect(viewBody.slice(0, viewBody.indexOf('FROM public.profiles'))).not.toContain(forbidden)
    }
    expect(sql).toContain('GRANT SELECT ON public.public_profiles TO authenticated')
  })
})
