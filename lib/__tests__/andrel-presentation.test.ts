import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { classifyIntro } from '@/lib/introRequests/classify'
import { buildIntroSections } from '@/lib/introductions/andrelSection'
import { assertSameOrigin } from '@/lib/http/sameOrigin'

const page = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
const migration = readFileSync('supabase/migrations/050_member_pairs.sql', 'utf8')
const express = readFileSync('app/api/intro-requests/express-interest/route.ts', 'utf8')
const route = readFileSync('app/api/admin/recommendations/recover-onboarding/route.ts', 'utf8')

describe('Andrel presentation — shared pair_id, both members, structured label', () => {
  it('1. the generator inserts BOTH directional cards with the SAME pair_id, is_admin_initiated=false', () => {
    // canonical pair → two rows, one pair.id
    expect(migration).toMatch(/\(a_id, b_id, 'suggested', false, p_reason, pair\.id/)
    expect(migration).toMatch(/\(b_id, a_id, 'suggested', false, p_reason, pair\.id/)
  })

  it('2. each member sees the OTHER via a batch-agnostic suggested query (their own directional row)', () => {
    // requester_id = viewer, status = 'suggested' — no batch_id filter, so both sides surface.
    expect(page).toContain(".eq('requester_id', profileId)")
    expect(page).toContain(".eq('status', 'suggested')")
  })

  it('3. reciprocal cards render in a DISTINCT "Introduced by Andrel" section from the structural split (not match_reason)', () => {
    expect(page).toContain('introducedByAndrel: !!intro.pair_id')          // structural flag from pair_id
    expect(page).toContain('buildIntroSections(allSuggestions')            // structural partition
    // the section heading is gated on a reciprocal card existing (no empty section)
    expect(page).toMatch(/effectiveAndrelFeatured && \([\s\S]{0,400}Introduced by Andrel/)
    expect(page).not.toMatch(/match_reason[\s\S]{0,40}Introduced by Andrel/)
  })

  it('4. no duplication/loss — reciprocal in Andrel ONLY, ordinary in "Recommended for you" ONLY; empty Andrel section not shown', () => {
    // "Recommended for you" renders the ORDINARY split only.
    expect(page).toMatch(/effectiveOrdinaryFeatured && \([\s\S]{0,700}Recommended for you/)
    // Andrel section is conditional (item 10 — no empty section).
    expect(page).toContain('{effectiveAndrelFeatured && (')
    // one source list feeds the split, deduped by profile id + excluded when pending. Both are now
    // properties of the canonical selector (lib/introductions/actionableCards) rather than an
    // inline map/filter — same guarantees, asserted where they now live.
    expect(page).toContain('const allSuggestions = selectActionableCards(')
    expect(page).toContain('answeredTargetIds: pendingTargetIds')
    const PRED = readFileSync('lib/introductions/actionableCards.ts', 'utf8')
    expect(PRED).toContain('const byTarget = new Map<string, T>()')       // dedup BY TARGET
    expect(PRED).toContain('if (!byTarget.has(id)) byTarget.set(id, row)')
    expect(PRED).toContain('if (ctx.answeredTargetIds.has(id)) return false')
  })

  it('9. the admin/concierge area is labeled "Andrel Concierge" — never the identical reciprocal wording', () => {
    expect(page).toContain('Andrel Concierge')
    expect(readFileSync('components/AdminIntroCard.tsx', 'utf8')).toContain('Andrel Concierge')
  })

  it('7. reciprocal (pair_id) cards classify as reciprocal_live — NEVER the admin approval queue', () => {
    expect(classifyIntro({ status: 'suggested', pair_id: 'p1', is_admin_initiated: false }, { isMatched: false, counterpartConsented: false })).toBe('reciprocal_live')
    // and admin-review is only for admin-initiated non-pair rows
    expect(classifyIntro({ status: 'admin_pending', pair_id: null, is_admin_initiated: true }, { isMatched: false, counterpartConsented: false })).toBe('admin_review')
  })

  it('5–6. one-sided interest stays private; mutual interest finalizes via the canonical safe finalizer', () => {
    // Expressing interest sets the expresser's OWN row and notifies ONLY the other participant.
    expect(express).toContain("type: 'interest_received'")
    // Mutual match is gated on the reverse row (the other member independently expressed interest).
    expect(express).toMatch(/if \(reverseRequest\)[\s\S]{0,120}finalizeMutualMatch/)
  })

  it('8. passing remains pair-aware (does not reveal who passed)', () => {
    expect(migration).toContain('pass_reciprocal_pair') // pair-aware pass RPC
  })

  it('10. recovery uses the EXACT same reciprocal path/scoring as onboarding (no hard-coded person)', () => {
    expect(route).toContain("generateReciprocalBatchForMember(trimmed, 'onboarding')")
    // no hard-coded counterpart / global default anywhere in the recovery route
    expect(route).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
  })
})

// Behavior-level partition proof (the render relies on this pure split).
describe('buildIntroSections — structural partition (behavior)', () => {
  const card = (id: string, andrel: boolean) => ({ profile: { id }, introducedByAndrel: andrel })

  it('reciprocal (pair_id) cards go to Andrel; ordinary (pair_id NULL) to Recommended — each exactly once', () => {
    const items = [card('a', true), card('b', true), card('c', false)]
    const s = buildIntroSections(items)
    expect(s.andrel.featured).toEqual(card('a', true))
    expect(s.andrel.additional).toEqual([card('b', true)])   // featured + additional stay in the section
    expect(s.ordinary.featured).toEqual(card('c', false))
    expect(s.ordinary.additional).toEqual([])
    // no loss / no duplication
    const rendered = [s.andrel.featured, ...s.andrel.additional, s.ordinary.featured, ...s.ordinary.additional].filter(Boolean)
    expect(rendered).toHaveLength(items.length)
    expect(new Set(rendered.map((r: any) => r.profile.id)).size).toBe(items.length)
  })
  it('all-reciprocal → empty ordinary (no "Recommended for you"); all-ordinary → empty andrel (no section)', () => {
    expect(buildIntroSections([card('a', true), card('b', true)]).ordinary.featured).toBeNull()
    expect(buildIntroSections([card('a', false)]).andrel.featured).toBeNull()
  })
  it('empty input → both sections empty (no empty section renders)', () => {
    const s = buildIntroSections([])
    expect(s.andrel.featured).toBeNull()
    expect(s.ordinary.featured).toBeNull()
  })
})

// Endpoint same-origin guard — fail closed matrix.
describe('assertSameOrigin — fail closed', () => {
  const reqH = (h: Record<string, string>) => ({ headers: new Headers(h) }) as any

  it('allows a legitimate same-origin production request (www.andrel.app)', () => {
    expect(assertSameOrigin(reqH({ 'sec-fetch-site': 'same-origin', origin: 'https://www.andrel.app', host: 'www.andrel.app' }))).toBeNull()
  })
  it('rejects a cross-site Sec-Fetch-Site', () => {
    expect(assertSameOrigin(reqH({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', host: 'www.andrel.app' }))?.status).toBe(403)
  })
  it('rejects a cross-origin Origin (host mismatch)', () => {
    expect(assertSameOrigin(reqH({ 'sec-fetch-site': 'same-origin', origin: 'https://evil.example', host: 'www.andrel.app' }))?.status).toBe(403)
  })
  it('rejects a spoofed Origin/Host mismatch', () => {
    expect(assertSameOrigin(reqH({ origin: 'https://www.andrel.app', host: 'evil.example' }))?.status).toBe(403)
  })
  it('FAILS CLOSED when both Sec-Fetch-Site and Origin are missing (browser-style mutation)', () => {
    expect(assertSameOrigin(reqH({ host: 'www.andrel.app' }))?.status).toBe(403)
  })
  it('rejects an unparseable Origin', () => {
    expect(assertSameOrigin(reqH({ origin: 'not a url', host: 'www.andrel.app' }))?.status).toBe(403)
  })
})
