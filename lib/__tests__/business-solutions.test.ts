import { describe, it, expect } from 'vitest'
import { isBusinessSolutionProvider, maxBusinessSolutionCount, isLegalProfessional, isLegalNetworkingPair } from '@/lib/matching/business-solutions'

describe('isBusinessSolutionProvider', () => {
  it('classifies law firms and consultants as providers', () => {
    expect(isBusinessSolutionProvider({ role_type: 'Law Firm Partner' })).toBe(true)
    expect(isBusinessSolutionProvider({ role_type: 'Law Firm Attorney' })).toBe(true)
    expect(isBusinessSolutionProvider({ role_type: 'Management Consultant' })).toBe(true)
    expect(isBusinessSolutionProvider({ role_type: 'Legal Tech Founder' })).toBe(true)
  })
  it('does not classify in-house / operator roles as providers', () => {
    expect(isBusinessSolutionProvider({ role_type: 'In-House Counsel' })).toBe(false)
    expect(isBusinessSolutionProvider({ role_type: 'General Counsel' })).toBe(false)
    expect(isBusinessSolutionProvider({ role_type: 'COO' })).toBe(false)
    expect(isBusinessSolutionProvider({})).toBe(false)
  })
})

describe('maxBusinessSolutionCount — buyer provider quota (DISABLED at launch capacity)', () => {
  // The quota is a PERCENTAGE of batch size, calibrated for batches of 5-8. BATCH_CONFIG caps
  // everyone at 2, and at that size the percentage collapses to zero for every tier — which
  // turned a "limit vendor exposure" preference into a hard block. Measured on production
  // 2026-08-27: 112 of 116 members held a quota of 0 and could not be introduced to any of the
  // 23 provider members at all. maxBusinessSolutionCount is therefore floored at targetCount
  // (provably non-binding) unless BUSINESS_SOLUTION_THROTTLE=on.
  //
  // These assertions were inverted, not deleted: the ones below record what the function used
  // to return, so the regression is legible when the throttle is recalibrated and re-enabled.

  it('the underlying percentage still collapses to 0 at capacity 2 — the reason it is off', () => {
    const BASE = 0.30, PREF = 0.5
    const MULT: Record<string, number> = { free: 1.0, professional: 0.7, executive: 0.5, founding: 0.7 }
    for (const tier of ['free', 'professional', 'executive', 'founding']) {
      const raw = Math.floor(2 * BASE * MULT[tier])
      expect(raw, tier).toBe(0)                       // was: opted-in floored up to 1
      expect(Math.floor(raw * PREF), tier).toBe(0)    // was: NON-opted-in left at 0
    }
  })

  it('an opted-in member is never blocked at the launch cap (was: exactly 1)', () => {
    for (const tier of ['free', 'professional', 'executive'])
      expect(maxBusinessSolutionCount(true, tier, 2), tier).toBeGreaterThanOrEqual(2)
  })

  it('a NON-opted-in member is no longer shielded to zero (was: 0 — the production block)', () => {
    // The "shielded unless they ask" intent is deferred, not abandoned: it needs an absolute
    // quota rather than a percentage before it can be switched back on. See the module comment.
    for (const tier of ['free', 'professional', 'executive'])
      expect(maxBusinessSolutionCount(false, tier, 2), tier).toBeGreaterThanOrEqual(2)
  })

  it('the quota can never bind at any batch size, opted in or not', () => {
    for (const tier of ['free', 'professional', 'executive', 'founding'])
      for (const opted of [true, false])
        for (const target of [1, 2, 3, 4, 5, 8, 10])
          expect(maxBusinessSolutionCount(opted, tier, target), `${tier}/${opted}/${target}`)
            .toBeGreaterThanOrEqual(target)
  })
})

describe('isLegalProfessional / isLegalNetworkingPair — legal peer exemption', () => {
  it('recognizes practicing lawyers and in-house/GC counsel as legal professionals', () => {
    for (const r of ['Law Firm Partner', 'Law Firm Attorney', 'General Counsel', 'In-House Counsel', 'Deputy General Counsel', 'Associate General Counsel']) {
      expect(isLegalProfessional({ role_type: r })).toBe(true)
    }
  })
  it('does NOT treat legal VENDORS or non-legal roles as legal professionals', () => {
    expect(isLegalProfessional({ role_type: 'Legal Tech Founder' })).toBe(false) // vendor, not a peer lawyer
    expect(isLegalProfessional({ role_type: 'Legal Services' })).toBe(false)
    expect(isLegalProfessional({ role_type: 'Management Consultant' })).toBe(false)
    expect(isLegalProfessional({ role_type: 'Founder' })).toBe(false)
    expect(isLegalProfessional({})).toBe(false)
  })
  it('isLegalNetworkingPair requires BOTH endpoints to be legal professionals', () => {
    expect(isLegalNetworkingPair({ role_type: 'Law Firm Partner' }, { role_type: 'General Counsel' })).toBe(true)
    expect(isLegalNetworkingPair({ role_type: 'Law Firm Attorney' }, { role_type: 'In-House Counsel' })).toBe(true)
    expect(isLegalNetworkingPair({ role_type: 'Law Firm Partner' }, { role_type: 'Founder' })).toBe(false)     // non-legal buyer
    expect(isLegalNetworkingPair({ role_type: 'Law Firm Partner' }, { role_type: 'Legal Tech Founder' })).toBe(false) // legal vendor, not peer
  })
  it('classification is unchanged: law firms + legal-tech are still business-solution providers', () => {
    expect(isBusinessSolutionProvider({ role_type: 'Law Firm Partner' })).toBe(true)
    expect(isBusinessSolutionProvider({ role_type: 'Legal Tech Founder' })).toBe(true)
    expect(isBusinessSolutionProvider({ role_type: 'General Counsel' })).toBe(false)
  })
})
