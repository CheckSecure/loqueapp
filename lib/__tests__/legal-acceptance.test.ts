import { describe, it, expect } from 'vitest'
import {
  needsReacceptance,
  TERMS_VERSION,
  PRIVACY_VERSION,
} from '@/lib/legal/terms'

describe('legal versions are monotonic integers (safe to compare)', () => {
  it('exposes integer versions', () => {
    expect(Number.isInteger(TERMS_VERSION)).toBe(true)
    expect(Number.isInteger(PRIVACY_VERSION)).toBe(true)
    expect(TERMS_VERSION).toBeGreaterThan(0)
    expect(PRIVACY_VERSION).toBeGreaterThan(0)
  })
})

describe('needsReacceptance — clickwrap re-acceptance gate', () => {
  it('requires acceptance when the member has never accepted (null/undefined)', () => {
    expect(needsReacceptance(null, null)).toBe(true)
    expect(needsReacceptance(undefined, undefined)).toBe(true)
  })

  it('does NOT require re-acceptance when both accepted versions are current', () => {
    expect(needsReacceptance(TERMS_VERSION, PRIVACY_VERSION)).toBe(false)
  })

  it('requires re-acceptance when the Terms version is stale', () => {
    expect(needsReacceptance(TERMS_VERSION - 1, PRIVACY_VERSION)).toBe(true)
  })

  it('requires re-acceptance when the Privacy version is stale', () => {
    expect(needsReacceptance(TERMS_VERSION, PRIVACY_VERSION - 1)).toBe(true)
  })

  it('requires re-acceptance when only one document was ever accepted', () => {
    expect(needsReacceptance(TERMS_VERSION, null)).toBe(true)
    expect(needsReacceptance(null, PRIVACY_VERSION)).toBe(true)
  })

  it('treats a future accepted version as still-current (no downgrade prompt)', () => {
    expect(needsReacceptance(TERMS_VERSION + 5, PRIVACY_VERSION + 5)).toBe(false)
  })
})
