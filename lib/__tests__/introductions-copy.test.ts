import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Copy guard for the onboarding-recommendation wording refinement. A one-sided
 * recommendation must read as "recommended for you" (the other member may not have
 * seen you), while genuinely mutual states stay labeled as connections/intros.
 * These are JSX/string-literal copy changes only — asserted on source (this vitest
 * setup can't render the .tsx page). Locks the new strings and the preserved ones.
 */
const page = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
const button = readFileSync('components/RequestIntroButton.tsx', 'utf8')
const notifications = readFileSync('lib/notifications/index.ts', 'utf8')

describe('introductions page — one-sided recommendations read as recommendations', () => {
  it('section heading is "Recommended for you" (not "This Week\'s Introductions")', () => {
    expect(page).toContain('Recommended for you')
    expect(page).not.toMatch(/This Week.{0,8}Introductions/)
  })

  it('per-card reason label is "Why we recommended them" (not "Why we introduced you")', () => {
    expect(page).toContain('Why we recommended them')
    expect(page).not.toContain('Why we introduced you')
  })

  it('the clarifier states interest stays PRIVATE until mutual (no "we’ll let them know" leak)', () => {
    // Privacy correction: reciprocal interest is never revealed one-sided, so the copy must not
    // imply the other member is notified.
    expect(page).not.toContain('let them know')
    expect(page).toContain('Your interest stays private')
    expect(page).toContain('we connect you only when it') // "…when it’s mutual"
  })

  it('preserves genuinely mutual states unchanged', () => {
    expect(page).toContain('Introduced by Andrel')                 // admin/mutual section
    expect(page).toContain('Awaiting their response')              // pending → mutual copy
    expect(page).toContain('the moment interest is mutual')
  })
})

describe('RequestIntroButton — express-interest states clarify notification, keep label', () => {
  it('transient state is "Sharing your interest…" (not "Facilitating introduction…")', () => {
    expect(button).toContain('Sharing your interest')
    expect(button).not.toContain('Facilitating introduction')
  })

  it('done state says interest was sent and they were notified', () => {
    expect(button).toContain('Interest sent')
    expect(button).toContain('been notified')
    expect(button).not.toContain('Interest expressed') // old done-state copy is gone
  })

  it('keeps the button label "Express interest"', () => {
    expect(button).toContain('Express interest')
  })
})

describe('interest_received notification copy (shown to the target)', () => {
  it('uses the neutral, non-mutual-implying title + message', () => {
    expect(notifications).toContain("Someone's interested in connecting")
    expect(notifications).toContain('A member is interested in connecting with you. Open Introductions to see who and respond.')
  })

  it('drops the old "curated connection" wording', () => {
    expect(notifications).not.toContain('A curated connection is interested in meeting you.')
    expect(notifications).not.toContain('New connection interest')
  })
})
