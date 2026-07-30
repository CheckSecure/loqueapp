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

describe('maxBusinessSolutionCount — buyer provider quota (v3.2)', () => {
  it('guarantees an opted-in member ≥1 provider at the launch cap of 2 (the collapse is fixed)', () => {
    expect(maxBusinessSolutionCount(true, 'free', 2)).toBe(1)
    expect(maxBusinessSolutionCount(true, 'professional', 2)).toBe(1)
    expect(maxBusinessSolutionCount(true, 'executive', 2)).toBe(1)
  })

  it('keeps a NON-opted-in member at zero providers (they are shielded unless they ask)', () => {
    expect(maxBusinessSolutionCount(false, 'free', 2)).toBe(0)
    expect(maxBusinessSolutionCount(false, 'professional', 2)).toBe(0)
    expect(maxBusinessSolutionCount(false, 'executive', 2)).toBe(0)
  })

  it('opted-in quota grows with the percentage as the cap rises; never below 1', () => {
    expect(maxBusinessSolutionCount(true, 'free', 3)).toBe(1) // floor(0.9)=0 → floored to 1
    expect(maxBusinessSolutionCount(true, 'free', 4)).toBe(1) // floor(1.2)=1
    expect(maxBusinessSolutionCount(true, 'free', 10)).toBe(3) // floor(3.0)=3
  })

  it('non-opted allowance stays the reduced percentage (0 until the batch is large)', () => {
    expect(maxBusinessSolutionCount(false, 'free', 4)).toBe(0) // floor(floor(1.2)*0.5)=0
    expect(maxBusinessSolutionCount(false, 'free', 10)).toBe(1) // floor(3*0.5)=1
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
