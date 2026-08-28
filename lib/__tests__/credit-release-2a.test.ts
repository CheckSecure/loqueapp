import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/089_credit_capacity_reservations_and_additive_refills.sql','utf8')

function refill(allowance:number, free:number, premium:number, reserved=0) {
  return Math.min(allowance, Math.max(0,20-free), Math.max(0,50-free-premium-reserved))
}

describe('Release 2A additive monthly-credit policy', () => {
  it.each([
    [3,0,0,0,3], [10,7,0,0,17], [20,15,0,0,20], [15,19,0,0,20],
    [15,30,0,0,30], [20,10,35,0,15], [20,10,25,10,15], [20,20,0,0,20],
  ])('allowance %i, %i included, %i purchased, %i reserved -> %i included',
    (allowance,free,premium,reserved,expected) => expect(free+refill(allowance,free,premium,reserved)).toBe(expected))

  it('never reduces legacy included balances', () => expect(refill(15,30,0)).toBe(0))
  it('counts active purchase reservations against combined headroom', () => expect(refill(20,10,25,10)).toBe(5))
})

describe('migration 089 authority and security', () => {
  it('creates the server-only reservation ledger with RLS and no browser grants', () => {
    expect(sql).toMatch(/CREATE TABLE public\.credit_purchase_reservations/)
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/REVOKE ALL ON public\.credit_purchase_reservations FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE ON public\.credit_purchase_reservations TO service_role/)
  })
  it('uses one user-scoped advisory lock in reservation, grant, and refill authorities', () => {
    expect(sql.match(/hashtextextended\(p_user_id::text, 8901\)/g)).toHaveLength(3)
  })
  it('has a partial index only for capacity-consuming reservations', () => {
    expect(sql).toMatch(/credit_purchase_reservations_active_user_idx[\s\S]*WHERE status = 'reserved'/)
  })
  it('protects all credit writers with a trigger and combined constraint', () => {
    expect(sql).toMatch(/CREATE TRIGGER enforce_credit_capacity/)
    expect(sql).toMatch(/NEW\.balance \+ v_reserved > 50/)
    expect(sql).toMatch(/meeting_credits_combined_cap/)
  })
  it('does not release a Stripe-bound reservation as a checkout-creation failure', () => {
    expect(sql).toMatch(/p_reason='checkout_creation_failed'[\s\S]*v\.stripe_session_id IS NOT NULL/)
  })
  it('does not contain historical DML outside function bodies', () => {
    const beforeFunctions = sql.split('CREATE OR REPLACE FUNCTION public.tg_enforce_credit_capacity')[0]
    expect(beforeFunctions).not.toMatch(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\./i)
  })
})
