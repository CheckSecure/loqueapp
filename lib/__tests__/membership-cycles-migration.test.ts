import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/053_membership_credit_cycles.sql', 'utf8')
const code = sql.replace(/COMMENT ON[\s\S]*?;/g, '').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

describe('migration 053 — membership credit cycles', () => {
  it('is additive/idempotent + non-destructive; does not touch migration 052 objects', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.membership_credit_cycles')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.credit_refills')
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.claim_due_credit_refills/)
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.apply_credit_refill/)
    expect(code).not.toMatch(/DROP\s+(TABLE|FUNCTION)|DELETE\s+FROM|TRUNCATE|ALTER TABLE .*meeting_credits/i)
    expect(code).not.toMatch(/credit_grants|grant_credit_pack/) // migration 052 untouched
  })

  it('durable per-cycle idempotency (UNIQUE user+cycle) — not inferred from balance', () => {
    expect(sql).toContain('CONSTRAINT credit_refills_once UNIQUE (user_id, cycle_on)')
    expect(sql).toContain('ON CONFLICT (user_id, cycle_on) DO NOTHING')
    expect(sql).toMatch(/IF NOT FOUND THEN[\s\S]*?RETURN 'already_processed'/)
  })

  it('REPLACES included/free credits to the allowance and PRESERVES premium exactly (null-safe balance)', () => {
    expect(sql).toContain('free_credits = v_included')
    expect(sql).toContain('balance      = v_included + COALESCE(public.meeting_credits.premium_credits, 0)')
    // premium_credits is NOT in the DO UPDATE SET → preserved exactly; lifetime not decremented.
    const doUpdate = sql.slice(sql.indexOf('ON CONFLICT (user_id) DO UPDATE SET'))
    expect(doUpdate).not.toMatch(/premium_credits\s*=/)
  })

  it('apply is TIER-BOUND, CYCLE-BOUND, LEASE-OWNED; no caller tier/amount/date', () => {
    // apply takes ONLY (user, cycle, lease_token) — NO p_tier / p_included / p_next_refill_on.
    expect(sql).toMatch(/FUNCTION public\.apply_credit_refill\(\s*p_user_id uuid, p_cycle_on date, p_lease_token uuid\s*\)/)
    expect(sql).not.toMatch(/p_included|p_next_refill_on/)
    expect(sql).not.toMatch(/apply_credit_refill\([^)]*p_tier/) // apply signature has no tier param
    expect(sql).toContain('FROM public.membership_credit_cycles WHERE user_id = p_user_id FOR UPDATE') // row lock
    expect(sql).toContain('v_row.lease_token <> p_lease_token')          // ownership
    expect(sql).toContain('v_row.lease_expires_at < pg_catalog.now()')   // unexpired lease
    expect(sql).toContain('p_cycle_on <> v_row.next_refill_on') // fabricated/stale/mismatched cycle → stale_claim
    expect(sql).toContain('v_row.next_refill_on > CURRENT_DATE') // not-due → not_due
    // TIER BINDING: re-resolve current tier; drift → reject; allowance from the STORED claimed_tier.
    expect(sql).toContain('SELECT public.effective_credit_tier(pr.is_founding_member, pr.founding_member_expires_at, pr.subscription_tier)')
    expect(sql).toContain('v_current IS DISTINCT FROM v_row.claimed_tier')
    expect(sql).toContain('v_included := public.tier_included_credits(v_row.claimed_tier)') // DB-derived amount from STORED tier
    expect(sql).toContain('v_next := public.next_credit_refill_on(v_row.anchor_day, CURRENT_DATE)') // DB-derived date
    // the ledger records the bound tier (not a caller value).
    expect(sql).toContain('VALUES (p_user_id, v_row.next_refill_on, v_row.claimed_tier, v_included)')
    for (const r of ["'stale_claim'", "'not_due'", "'invalid_tier'"]) expect(sql).toContain(`RETURN ${r}`)
  })

  it('effective_credit_tier mirrors getEffectiveTier (founding expiry + subscription fallback)', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.effective_credit_tier/)
    expect(sql).toContain('IF p_is_founding THEN')
    expect(sql).toContain('IF p_founding_expires IS NOT NULL AND p_founding_expires < pg_catalog.now() THEN')
    expect(sql).toContain("RETURN 'founding'")
    expect(sql).toMatch(/RETURN COALESCE\(NULLIF\(p_subscription_tier, ''\), 'free'\)/)
  })

  it('claim resolves + STORES the authoritative tier snapshot (claimed_tier) from profile fields', () => {
    expect(sql).toContain('claimed_tier text NULL')
    expect(sql).toContain('claimed_tier = public.effective_credit_tier(p.is_founding_member, p.founding_member_expires_at, p.subscription_tier)')
    expect(sql).toMatch(/RETURNS TABLE\(user_id uuid, cycle_on date, lease_token uuid, claimed_tier text\)/)
  })

  it('DB-authoritative allowance map (free 3 / professional 10 / executive 20 / founding 15)', () => {
    expect(sql).toMatch(/WHEN 'free' THEN 3/)
    expect(sql).toMatch(/WHEN 'professional' THEN 10/)
    expect(sql).toMatch(/WHEN 'executive' THEN 20/)
    expect(sql).toMatch(/WHEN 'founding' THEN 15/)
  })

  it('worker claim is bounded, lease-TOKEN based, atomic, active + due only, joins tier fields', () => {
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain("s.status = 'active'")
    expect(sql).toContain('s.next_refill_on <= CURRENT_DATE')
    expect(sql).toContain('LIMIT LEAST(GREATEST(COALESCE(p_limit, 0), 0), 200)')
    expect(sql).toContain('lease_token = gen_random_uuid()') // per-row ownership token
    expect(sql).toContain('make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 1), 3600))')
    expect(sql).toMatch(/FROM public\.profiles p\s+WHERE c\.user_id = p\.id/) // tier resolved in ONE query (no N+1)
  })

  it('unknown-tier rows are PARKED (needs_review), not looped forever — lease-owned + due-bound', () => {
    expect(sql).toMatch(/FUNCTION public\.park_credit_cycle/)
    expect(sql).toContain("SET status = 'needs_review'")
    expect(sql).toMatch(/status\s+text NOT NULL DEFAULT 'active' CHECK \(status IN \('active','needs_review'\)\)/)
    expect(sql).toContain("WHERE status = 'active'") // parked rows excluded from the due index/claims
  })

  it('auto-enrolls new members via trigger + backfills existing to the NEXT FUTURE anniversary', () => {
    expect(sql).toMatch(/CREATE TRIGGER trg_enroll_membership_credit_cycle\s+AFTER INSERT ON public\.profiles/)
    expect(sql).toContain('public.next_credit_refill_on(pg_catalog.date_part(\'day\', p.created_at)::int, CURRENT_DATE)')
    expect(sql).toContain('ON CONFLICT (user_id) DO NOTHING') // idempotent enroll/backfill (no historical catch-up)
  })

  it('anniversary helper clamps day-31 to month end (short months / leap safe)', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.next_credit_refill_on/)
    expect(sql).toContain("LEAST(v_anchor, pg_catalog.date_part('day', (v_month_start + INTERVAL '1 month - 1 day'))::int)")
  })

  it('is hardened + service-role only (SECURITY DEFINER, empty search_path, RLS, zero policies, revokes/grants)', () => {
    // Every function pins an empty search_path.
    for (const fn of ['tier_included_credits', 'effective_credit_tier', 'next_credit_refill_on', 'claim_due_credit_refills', 'apply_credit_refill', 'park_credit_cycle', 'enroll_membership_credit_cycle']) {
      expect(sql).toMatch(new RegExp(`FUNCTION public\\.${fn}[\\s\\S]*?SET search_path = ''`))
    }
    // SECURITY DEFINER on every function that reads/writes rows or fires as a trigger.
    for (const fn of ['claim_due_credit_refills', 'apply_credit_refill', 'park_credit_cycle', 'enroll_membership_credit_cycle']) {
      expect(sql).toMatch(new RegExp(`FUNCTION public\\.${fn}[\\s\\S]*?SECURITY DEFINER`))
    }
    for (const tbl of ['membership_credit_cycles', 'credit_refills']) {
      expect(sql).toContain(`ALTER TABLE public.${tbl} ENABLE ROW LEVEL SECURITY`)
      expect(sql).toContain(`REVOKE ALL ON public.${tbl} FROM PUBLIC, anon, authenticated`)
    }
    expect(sql).not.toMatch(/CREATE POLICY/)
    // EXECUTE revoked from PUBLIC/anon/authenticated on EVERY function (incl. the trigger fn).
    for (const fn of ['tier_included_credits', 'effective_credit_tier', 'next_credit_refill_on', 'claim_due_credit_refills', 'apply_credit_refill', 'park_credit_cycle', 'enroll_membership_credit_cycle']) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(.*\\) FROM PUBLIC, anon, authenticated`))
    }
    // GRANT EXECUTE to service_role only on the callable RPCs (the trigger fn needs no grant).
    for (const fn of ['tier_included_credits', 'effective_credit_tier', 'next_credit_refill_on', 'claim_due_credit_refills', 'apply_credit_refill', 'park_credit_cycle']) {
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(.*\\) TO service_role`))
    }
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.enroll_membership_credit_cycle/) // trigger fn: no grant
    // The trigger fn is explicitly revoked from service_role too → NO role can call it directly (it only
    // runs via the AFTER INSERT trigger, which bypasses EXECUTE checks). Matches production's final state.
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.enroll_membership_credit_cycle() FROM service_role')
  })

  it('apply_credit_refill exposes EXACTLY the (uuid, date, uuid) signature — one overload, no p_tier', () => {
    // File-level proof of a single tier-less signature (the DB verification query confirms one overload
    // at runtime via to_regprocedure). Two CREATE-signatures or any p_tier param would fail here.
    const applyDefs = sql.match(/CREATE OR REPLACE FUNCTION public\.apply_credit_refill\(/g) ?? []
    expect(applyDefs).toHaveLength(1)
    expect(sql).toMatch(/FUNCTION public\.apply_credit_refill\(\s*p_user_id uuid, p_cycle_on date, p_lease_token uuid\s*\) RETURNS text/)
    expect(sql).not.toMatch(/apply_credit_refill\([^)]*p_tier/)
  })

  it('stores no secrets / payment payloads (lease_token is an internal ownership uuid, not a secret)', () => {
    expect(code).not.toMatch(/card|payment|stripe|payload|cvv|\bemail\b/i)
  })
})
