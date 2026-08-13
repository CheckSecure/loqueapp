import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/052_credit_grants.sql', 'utf8')
// Executable statements only (strip -- comments + COMMENT ON).
const code = sql.replace(/COMMENT ON[\s\S]*?;/g, '').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

describe('migration 052 — credit_grants ledger + grant_credit_pack RPC', () => {
  it('is additive/idempotent + non-destructive', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.credit_grants')
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.grant_credit_pack/)
    expect(code).not.toMatch(/DROP\s+(TABLE|FUNCTION|INDEX)|DELETE\s+FROM|TRUNCATE/i)
  })

  it('is idempotent on BOTH the Stripe event id AND the session id', () => {
    expect(sql).toContain('stripe_event_id    text NOT NULL UNIQUE')
    expect(sql).toContain('stripe_session_id  text NOT NULL UNIQUE')
    // event replay → DO NOTHING; a duplicate session under another event → caught → already_processed.
    expect(sql).toContain('ON CONFLICT (stripe_event_id) DO NOTHING')
    expect(sql).toMatch(/EXCEPTION WHEN unique_violation THEN\s*\n\s*RETURN 'already_processed'/)
    expect(sql).toMatch(/IF NOT FOUND THEN\s*\n\s*RETURN 'already_processed'/)
  })

  it('grants EXACTLY the purchased credits, UNCAPPED, NULL-SAFE, preserving the balance invariant', () => {
    // Every existing numeric is COALESCEd; premium/lifetime incremented by p_credits; balance recomputed.
    expect(sql).toContain('free_credits    = COALESCE(public.meeting_credits.free_credits, 0)')
    expect(sql).toContain('premium_credits = COALESCE(public.meeting_credits.premium_credits, 0) + p_credits')
    expect(sql).toContain('balance         = COALESCE(public.meeting_credits.free_credits, 0)')
    expect(sql).toContain('+ COALESCE(public.meeting_credits.premium_credits, 0) + p_credits')
    expect(sql).toContain('lifetime_earned = COALESCE(public.meeting_credits.lifetime_earned, 0) + p_credits')
    // NO cap clamp on the purchase path (no LEAST/min/headroom/getCreditCap in the grant SQL).
    expect(code).not.toMatch(/LEAST\s*\(|headroom|getCreditCap/i)
    // The grant never READS the existing balance column (null balance is irrelevant — it is recomputed).
    const doUpdate = sql.slice(sql.indexOf('ON CONFLICT (user_id) DO UPDATE SET'))
    expect(doUpdate).not.toMatch(/=\s*COALESCE\(public\.meeting_credits\.balance/)
  })

  it('hardens inputs: blank/oversized ids, non-positive amount, currency allow-list', () => {
    expect(sql).toMatch(/pg_catalog\.btrim\(p_event_id\) = ''/)
    expect(sql).toMatch(/pg_catalog\.btrim\(p_session_id\) = ''/)
    expect(sql).toMatch(/pg_catalog\.btrim\(p_price_id\) = ''/)
    expect(sql).toMatch(/pg_catalog\.length\(p_event_id\) > 255/)
    expect(sql).toMatch(/p_amount_total IS NULL OR p_amount_total <= 0/)
    expect(sql).toContain("v_currency <> 'usd'")
    // Table constraints AGREE with the RPC (amount > 0, currency allow-list, bounded id lengths).
    expect(sql).toContain('CHECK (amount_total > 0)')
    expect(sql).toContain("CHECK (currency = 'usd')")
    expect(sql).toContain('CHECK (char_length(stripe_event_id) BETWEEN 1 AND 255)')
    expect(sql).toContain('CHECK (char_length(stripe_session_id) BETWEEN 1 AND 255)')
  })

  it('never expires purchased credits (no expiry column/logic in the executable SQL)', () => {
    expect(code).not.toMatch(/expires_at/i)
    expect(code).not.toMatch(/expire/i) // comment-stripped code has no expiry mechanism
  })

  it('marker + grant are ONE transaction (atomic): the balance mutation follows the claim in the same function body', () => {
    const insertMarker = sql.indexOf('INSERT INTO public.credit_grants')
    const insertBalance = sql.indexOf('INSERT INTO public.meeting_credits')
    expect(insertMarker).toBeGreaterThan(0)
    expect(insertBalance).toBeGreaterThan(insertMarker) // grant is AFTER the claim, same body → same txn
    // Both live inside the single plpgsql function (no COMMIT between them).
    expect(sql).not.toMatch(/COMMIT\s*;/i)
  })

  it('validates inputs (null ids, non-positive/oversized credits rejected)', () => {
    expect(sql).toMatch(/p_user_id IS NULL/)
    expect(sql).toMatch(/p_credits IS NULL OR p_credits <= 0/)
    expect(sql).toContain('CHECK (credits > 0 AND credits <= 100000)')
    expect(sql).toMatch(/RAISE EXCEPTION 'grant_credit_pack:/)
  })

  it('is hardened + service-role only (SECURITY DEFINER, empty search_path, RLS, zero policies, revokes/grant)', () => {
    expect(sql).toContain('SECURITY DEFINER')
    expect(sql).toMatch(/search_path\s*=\s*(''|"")/)
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).not.toMatch(/CREATE POLICY/)
    expect(sql).toContain('REVOKE ALL ON public.credit_grants FROM PUBLIC, anon, authenticated')
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.grant_credit_pack\(.*\) FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.grant_credit_pack\(.*\) TO service_role/)
  })

  it('stores only coarse Stripe references — no card/payload/token/email', () => {
    expect(code).not.toMatch(/card|payment_method|token|email|payload/i)
  })
})

// Reference implementation of the RPC's null-safe accounting (mirrors the DO UPDATE SET above). The
// structural test proves the SQL uses these exact COALESCE formulas; this proves the arithmetic is
// correct for every legacy-null combination.
function computeGrant(
  prev: { free_credits: number | null; premium_credits: number | null; lifetime_earned: number | null } | null,
  purchased: number,
) {
  const free = prev?.free_credits ?? 0
  const premium = prev?.premium_credits ?? 0
  const life = prev?.lifetime_earned ?? 0
  return {
    free_credits: free,
    premium_credits: premium + purchased,
    balance: free + (premium + purchased),
    lifetime_earned: life + purchased,
  }
}

describe('null-safe credit accounting (proves +25 in every legacy-null case)', () => {
  const cases: Array<[string, any]> = [
    ['all populated', { free_credits: 2, premium_credits: 0, lifetime_earned: 3 }],
    ['premium_credits NULL', { free_credits: 2, premium_credits: null, lifetime_earned: 3 }],
    ['free_credits NULL', { free_credits: null, premium_credits: 0, lifetime_earned: 3 }],
    ['balance NULL (irrelevant — recomputed)', { free_credits: 2, premium_credits: 0, lifetime_earned: 3 }],
    ['lifetime_earned NULL', { free_credits: 2, premium_credits: 0, lifetime_earned: null }],
    ['missing meeting_credits row', null],
  ]
  for (const [label, prev] of cases) {
    it(`${label}: grants exactly 25, invariant balance = free + premium holds`, () => {
      const r = computeGrant(prev, 25)
      const priorPremium = prev?.premium_credits ?? 0
      const priorFree = prev?.free_credits ?? 0
      const priorLife = prev?.lifetime_earned ?? 0
      expect(r.premium_credits).toBe(priorPremium + 25)
      expect(r.free_credits).toBe(priorFree)
      expect(r.balance).toBe(r.free_credits + r.premium_credits)
      expect(r.lifetime_earned).toBe(priorLife + 25)
      // never NULL
      for (const v of Object.values(r)) expect(v).not.toBeNull()
    })
  }
  it('Jesse: prior {free:2, premium:0, lifetime:3} + 25 → premium 25, balance 27, lifetime 28', () => {
    expect(computeGrant({ free_credits: 2, premium_credits: 0, lifetime_earned: 3 }, 25))
      .toEqual({ free_credits: 2, premium_credits: 25, balance: 27, lifetime_earned: 28 })
  })
})
