import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  needsReacceptance, needsReacceptanceAt,
  TERMS_VERSION, PRIVACY_VERSION, PRIVACY_VERSION_LABEL, PRIVACY_EFFECTIVE_DATE,
  MIN_REQUIRED_PRIVACY_VERSION,
} from '@/lib/legal/terms'

/**
 * Privacy 2.0 rollout: PUBLISH without INTERRUPTING.
 *
 * Publishing a revision and forcing every member through /legal/accept are separate decisions. They
 * used to be one integer, which meant you could not do the first without also doing the second.
 * MIN_REQUIRED_PRIVACY_VERSION holds them apart: the published version is what the page shows and
 * what an acceptance records; the minimum is what the access gate compares against.
 *
 * The decision is made from the member's own durable acceptance record — never from an account
 * creation date, which is a proxy that goes wrong the moment a record and a timestamp disagree.
 */

const LEGAL = readFileSync('lib/legal/terms.ts', 'utf8')
const PRIVACY_PAGE = readFileSync('app/privacy/page.tsx', 'utf8')
const ACCEPT_ROUTE = readFileSync('app/api/legal/accept/route.ts', 'utf8')
const TERMS_PAGE_HASH = 'fda912a97ee96e1718a9d3e349a1cc59b00d9665011e228191e40e1688832c29'

const accepted = (t: number | null, p: number | null) =>
  ({ acceptedTermsVersion: t, acceptedPrivacyVersion: p,
     grandfatheredTermsVersion: null, grandfatheredPrivacyVersion: null })

describe('the two constants', () => {
  it('publishes 2 while requiring only 1', () => {
    expect(PRIVACY_VERSION).toBe(2)
    expect(MIN_REQUIRED_PRIVACY_VERSION).toBe(1)
  })

  it('never lets the minimum exceed the published version', () => {
    expect(MIN_REQUIRED_PRIVACY_VERSION).toBeLessThanOrEqual(PRIVACY_VERSION)
    // and the module refuses to load if a future edit breaks it
    expect(LEGAL).toMatch(/if \(MIN_REQUIRED_PRIVACY_VERSION > PRIVACY_VERSION\) \{\s*\n\s*throw new Error/)
  })

  it('leaves Terms with no minimum of its own — behaviour unchanged', () => {
    expect(TERMS_VERSION).toBe(1)
    expect(LEGAL).not.toMatch(/MIN_REQUIRED_TERMS_VERSION/)
    expect(LEGAL).toMatch(/Terms behaviour is UNCHANGED: always compared against the current published Terms version/)
  })
})

describe('who is interrupted, and who is not', () => {
  it('1. an existing member who accepted Privacy 1 is NOT redirected', () => {
    expect(needsReacceptance(accepted(TERMS_VERSION, 1))).toBe(false)
  })

  it('2. an existing member who accepted Privacy 2 is NOT redirected', () => {
    expect(needsReacceptance(accepted(TERMS_VERSION, 2))).toBe(false)
  })

  it('an existing member grandfathered through Privacy 1 is NOT redirected', () => {
    expect(needsReacceptance({
      acceptedTermsVersion: null, acceptedPrivacyVersion: null,
      grandfatheredTermsVersion: 1, grandfatheredPrivacyVersion: 1,
    })).toBe(false)
  })

  it('3. a new user with no acceptance at all IS redirected', () => {
    expect(needsReacceptance({})).toBe(true)
    expect(needsReacceptance(accepted(null, null))).toBe(true)
  })

  it('a member who accepted Terms but never Privacy is still redirected', () => {
    expect(needsReacceptance(accepted(TERMS_VERSION, null))).toBe(true)
  })

  it('5. Terms acceptance is unchanged — an out-of-date Terms still gates', () => {
    expect(needsReacceptance(accepted(TERMS_VERSION - 1, PRIVACY_VERSION))).toBe(true)
    expect(needsReacceptance(accepted(null, PRIVACY_VERSION))).toBe(true)
  })
})

describe('what acceptance records', () => {
  it('4. records the PUBLISHED version, never the minimum', () => {
    expect(ACCEPT_ROUTE).toMatch(/privacy_version_accepted: PRIVACY_VERSION/)
    expect(ACCEPT_ROUTE).toMatch(/terms_version_accepted: TERMS_VERSION/)
    expect(ACCEPT_ROUTE).not.toMatch(/MIN_REQUIRED_PRIVACY_VERSION/)
  })

  it('so a new user who accepts now satisfies the gate at any future minimum up to 2', () => {
    const justAccepted = accepted(TERMS_VERSION, PRIVACY_VERSION)
    expect(needsReacceptance(justAccepted)).toBe(false)
    expect(needsReacceptanceAt(TERMS_VERSION, PRIVACY_VERSION, justAccepted, 2)).toBe(false)
  })
})

describe('6. requiring v2 later is ONE constant change', () => {
  it('flipping the minimum to 2 re-gates Privacy 1 members and nobody else', () => {
    const at2 = (s: Parameters<typeof needsReacceptance>[0]) =>
      needsReacceptanceAt(TERMS_VERSION, PRIVACY_VERSION, s, 2)

    expect(at2(accepted(TERMS_VERSION, 1))).toBe(true)   // v1 member now owes acceptance
    expect(at2(accepted(TERMS_VERSION, 2))).toBe(false)  // v2 member unaffected
    expect(at2({ acceptedTermsVersion: TERMS_VERSION, acceptedPrivacyVersion: null,
                 grandfatheredTermsVersion: null, grandfatheredPrivacyVersion: 1 })).toBe(true)
    expect(at2({})).toBe(true)                            // never-accepted, still gated
  })

  it('and today the same members are NOT gated — the difference is the constant alone', () => {
    expect(needsReacceptance(accepted(TERMS_VERSION, 1))).toBe(false)
  })

  it('the three-argument form still means minimum == published', () => {
    // back-compat: an existing caller that supplies no minimum keeps strict semantics
    expect(needsReacceptanceAt(1, 2, accepted(1, 1))).toBe(true)
    expect(needsReacceptanceAt(1, 2, accepted(1, 2))).toBe(false)
  })
})

describe('7 & 8. nothing is rewritten to achieve this', () => {
  it('no bulk update of member acceptance exists anywhere', () => {
    // the gate compares stored values; it never edits them
    expect(LEGAL).not.toMatch(/UPDATE|upsert|\.from\(/)
    expect(LEGAL).toMatch(/nothing about members' stored acceptance records changes, because the decision is/)
  })

  it('no SQL migration or backfill accompanies the rollout', () => {
    const migrations = readFileSync('supabase/migrations/075_account_deletion_ledger.sql', 'utf8')
    expect(migrations).not.toMatch(/privacy_version_accepted|privacy_grandfathered_through_version/)
  })

  it('does not decide access from an account creation date', () => {
    expect(LEGAL).not.toMatch(/created_at|createdAt|signupDate/)
    expect(LEGAL).toMatch(/never from an account creation date/)
  })
})

describe('9. the published page is genuinely v2 with the approved language', () => {
  it('shows version 2.0 and the August 22, 2026 effective date via the constants', () => {
    expect(PRIVACY_VERSION_LABEL).toBe('2.0')
    expect(PRIVACY_EFFECTIVE_DATE).toBe('August 22, 2026')
    expect(PRIVACY_PAGE).toMatch(/Version \{PRIVACY_VERSION_LABEL\} · Effective: \{PRIVACY_EFFECTIVE_DATE\}/)
  })

  it('carries the approved seven-year deletion-ledger language', () => {
    expect(PRIVACY_PAGE).toContain('We may retain a limited deletion audit record for up to seven years where reasonably necessary for security, fraud prevention, legal compliance, dispute resolution, and enforcement of our Terms.')
    expect(PRIVACY_PAGE).toContain('It does not contain the member&rsquo;s name, email address, profile information, messages, or other account content.')
  })

  it('10. leaves the Terms page byte-identical', () => {
    const h = require('node:crypto').createHash('sha256').update(readFileSync('app/terms/page.tsx')).digest('hex')
    expect(h).toBe(TERMS_PAGE_HASH)
  })
})
