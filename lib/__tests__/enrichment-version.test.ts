import { describe, it, expect } from 'vitest'
import {
  classifyCompany,
  needsEnrichment,
  requiresForce,
  ENRICHMENT_VERSION,
} from '@/lib/company/enrichment/version'

const DAY = 24 * 60 * 60 * 1000
const now = 1_000_000_000_000
const fresh = new Date(now - DAY).toISOString() // 1 day ago (inside 7-day cooldown)
const old = new Date(now - 10 * DAY).toISOString() // 10 days ago (past cooldown)
const V = ENRICHMENT_VERSION

describe('classifyCompany', () => {
  it('missing row → missing', () => {
    expect(classifyCompany(null)).toBe('missing')
    expect(classifyCompany(undefined)).toBe('missing')
  })
  it('status NULL → never_enriched', () => {
    expect(classifyCompany({ enrichment_status: null })).toBe('never_enriched')
  })
  it('maps terminal states directly', () => {
    expect(classifyCompany({ enrichment_status: 'failed' })).toBe('failed')
    expect(classifyCompany({ enrichment_status: 'not_found' })).toBe('not_found')
    expect(classifyCompany({ enrichment_status: 'in_progress' })).toBe('in_progress')
    expect(classifyCompany({ enrichment_status: 'partial' })).toBe('partial')
  })
  it('enriched at current version → up_to_date', () => {
    expect(classifyCompany({ enrichment_status: 'enriched', enrichment_version: V })).toBe('up_to_date')
  })
  it('enriched with null/older version → outdated_version (when versioning enabled)', () => {
    expect(classifyCompany({ enrichment_status: 'enriched', enrichment_version: null })).toBe('outdated_version')
    expect(classifyCompany({ enrichment_status: 'enriched', enrichment_version: V - 1 })).toBe('outdated_version')
  })
  it('versioning disabled → enriched is up_to_date regardless of stamp (pre-migration)', () => {
    expect(classifyCompany({ enrichment_status: 'enriched', enrichment_version: null }, { versioningEnabled: false })).toBe('up_to_date')
  })
  it('unknown/legacy status → treated as never_enriched', () => {
    expect(classifyCompany({ enrichment_status: 'weird' })).toBe('never_enriched')
  })
})

describe('needsEnrichment', () => {
  const opts = { now }
  it('always processes missing / never_enriched / outdated', () => {
    expect(needsEnrichment(null, opts)).toBe(true)
    expect(needsEnrichment({ enrichment_status: null }, opts)).toBe(true)
    expect(needsEnrichment({ enrichment_status: 'enriched', enrichment_version: V - 1 }, opts)).toBe(true)
  })
  it('never processes up_to_date', () => {
    expect(needsEnrichment({ enrichment_status: 'enriched', enrichment_version: V }, opts)).toBe(false)
  })
  it('never processes admin_edited, even if otherwise eligible', () => {
    expect(needsEnrichment({ enrichment_status: null, admin_edited: true }, opts)).toBe(false)
    expect(needsEnrichment({ enrichment_status: 'enriched', enrichment_version: V - 1, admin_edited: true }, opts)).toBe(false)
  })
  it('retries failed/not_found/partial only after the cooldown window', () => {
    expect(needsEnrichment({ enrichment_status: 'not_found', enrichment_attempted_at: fresh }, opts)).toBe(false)
    expect(needsEnrichment({ enrichment_status: 'not_found', enrichment_attempted_at: old }, opts)).toBe(true)
    expect(needsEnrichment({ enrichment_status: 'failed', enrichment_attempted_at: fresh }, opts)).toBe(false)
    expect(needsEnrichment({ enrichment_status: 'partial', enrichment_attempted_at: old }, opts)).toBe(true)
  })
  it('not_found with no attempt timestamp is immediately retryable', () => {
    expect(needsEnrichment({ enrichment_status: 'not_found' }, opts)).toBe(true)
  })
})

describe('requiresForce', () => {
  it('only outdated enriched rows require force', () => {
    expect(requiresForce({ enrichment_status: 'enriched', enrichment_version: V - 1 })).toBe(true)
    expect(requiresForce({ enrichment_status: 'enriched', enrichment_version: V })).toBe(false)
    expect(requiresForce({ enrichment_status: null })).toBe(false)
    expect(requiresForce({ enrichment_status: 'not_found' })).toBe(false)
    expect(requiresForce(null)).toBe(false)
  })
})
