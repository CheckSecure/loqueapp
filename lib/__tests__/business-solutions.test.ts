import { describe, it, expect } from 'vitest'
import { isBusinessSolutionProvider, maxBusinessSolutionCount } from '@/lib/matching/business-solutions'

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
