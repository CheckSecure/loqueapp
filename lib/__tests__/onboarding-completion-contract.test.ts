import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildProfileUpdate } from '@/lib/profile/updatePayload'
import { validateLocation } from '@/lib/validation/location'
import { missingStep1CompletionFields, resolveWizardStartStep } from '@/lib/onboarding/steps'

/**
 * Regression: the legacy /dashboard/onboarding wizard could demand a field it gave no way to enter.
 *
 * INCIDENT. The wizard opened on the stored `onboarding_step` marker alone. A profile parked at
 * step 2 whose step-1 data was incomplete therefore opened straight onto OnboardingStep2 — goals,
 * introduction preferences, interests, Complete Profile — which has no title, company or location
 * input. Clicking Complete Profile failed POST /api/profile/complete on the stored location with
 * "Enter the city and state, region, or country where you are based.", and there was no way back
 * to the only screen that could supply one.
 *
 * The production profile that hit this was created 2026-07-15 and reached step 2 BEFORE physical
 * location became a completion requirement, so it carried a title and company but no location.
 * The completion route had been rejecting it silently all along; commit cab10fc (which made a
 * failed completion visible instead of navigating anyway) only surfaced the pre-existing mismatch.
 *
 * The invariants below: the wizard opens on the step the DATA supports, every field the completion
 * route requires is reachable on step 1, and a completion failure is always actionable.
 */

const COMPLETE_ROUTE = readFileSync('app/api/profile/complete/route.ts', 'utf8')
const STEP1 = readFileSync('components/OnboardingStep1.tsx', 'utf8')
const STEP2 = readFileSync('components/OnboardingStep2.tsx', 'utf8')
const WIZARD_PAGE = readFileSync('app/dashboard/onboarding/page.tsx', 'utf8')
const ONBOARDING_FORM = readFileSync('components/OnboardingForm.tsx', 'utf8')

/** The EXACT production shape of the profile that hit this: step 2, no location. */
const STUCK_PROFILE = {
  onboarding_step: 2,
  title: 'General Counsel',
  company: 'test',
  location: null,
}

const READY_PROFILE = {
  onboarding_step: 2,
  title: 'General Counsel',
  company: 'Acme Corp',
  location: 'Washington, DC',
}

// ─────────────────────────────────────────────────────────────────────────────
describe('completion contract — every required field is collectable', () => {
  /**
   * The audit, mechanized. POST /api/profile/complete rejects on exactly these fields, and each is
   * collected on wizard step 1. If someone adds a FOURTH requirement to that route without giving
   * the onboarding UI a way to satisfy it, this test fails — which is the whole point: a required
   * field must never again be invisible to the member who has to provide it.
   */
  const REQUIRED_AT_COMPLETION = ['title', 'company', 'location'] as const

  it('the completion route rejects on exactly the audited field set', () => {
    // Every 400 the route can return, by the stored field it guards.
    const guards = {
      title: /title\.length < 2/.test(COMPLETE_ROUTE),
      company: /company\.length < 2/.test(COMPLETE_ROUTE),
      location: /validateLocation\(identity\?\.location\)/.test(COMPLETE_ROUTE),
    }
    expect(guards).toEqual({ title: true, company: true, location: true })

    // The stored columns it reads == the fields it can reject on. A new column appearing in this
    // select is the signal that a new requirement may have been added.
    const selectMatch = COMPLETE_ROUTE.match(/select\('([^']*title[^']*)'\)/)
    expect(selectMatch).toBeTruthy()
    const selected = selectMatch![1].split(',').map(s => s.trim()).sort()
    expect(selected).toEqual([...REQUIRED_AT_COMPLETION].sort())
  })

  it('wizard step 1 collects or derives every required field', () => {
    // location + company are real inputs on step 1.
    expect(STEP1).toMatch(/name="location"/)
    expect(STEP1).toMatch(/name="company"/)
    // title is derived from the role-title selector and set explicitly before submit.
    expect(STEP1).toMatch(/formData\.set\('title'/)
  })

  it('wizard step 2 collects NONE of them — which is why opening on it was a dead end', () => {
    for (const field of REQUIRED_AT_COMPLETION) {
      expect(STEP2).not.toMatch(new RegExp(`name="${field}"`))
    }
  })

  it('the other onboarding flow (/onboarding) also supplies every required field', () => {
    // OnboardingForm is fully controlled and appends its fields explicitly.
    expect(ONBOARDING_FORM).toMatch(/fd\.append\('title'/)
    expect(ONBOARDING_FORM).toMatch(/fd\.append\('company'/)
    // location is derived server-side from city + state by completeOnboarding.
    expect(ONBOARDING_FORM).toMatch(/fd\.append\('city'/)
    expect(ONBOARDING_FORM).toMatch(/fd\.append\('state'/)
    expect(ONBOARDING_FORM).toMatch(/validateLocation/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('wizard opens on the step the DATA supports', () => {
  it('sends the stuck production profile back to step 1, where location lives', () => {
    expect(missingStep1CompletionFields(STUCK_PROFILE)).toEqual(['location'])
    expect(resolveWizardStartStep(STUCK_PROFILE)).toBe(1)
  })

  it('still opens on step 2 when step-1 data genuinely satisfies completion', () => {
    expect(missingStep1CompletionFields(READY_PROFILE)).toEqual([])
    expect(resolveWizardStartStep(READY_PROFILE)).toBe(2)
  })

  it('never advances a member past their own marker', () => {
    // A step-1 member with complete data still starts on step 1 — the rule only sends people back.
    expect(resolveWizardStartStep({ ...READY_PROFILE, onboarding_step: 1 })).toBe(1)
    expect(resolveWizardStartStep(null)).toBe(1)
    expect(resolveWizardStartStep({})).toBe(1)
  })

  it('reports every missing step-1 field, not just the first', () => {
    expect(missingStep1CompletionFields({ onboarding_step: 2 })).toEqual(['title', 'company', 'location'])
  })

  it('treats a placeholder location as missing, exactly like the server gate', () => {
    // "Remote" describes a work arrangement, not a place — the completion route refuses it, so the
    // wizard must not present the Complete Profile button for it either.
    expect(resolveWizardStartStep({ ...READY_PROFILE, location: 'Remote' })).toBe(1)
    expect(resolveWizardStartStep({ ...READY_PROFILE, location: '   ' })).toBe(1)
    expect(validateLocation('Remote').ok).toBe(false)
  })

  it('the wizard page derives its step from the data, not the raw marker', () => {
    expect(WIZARD_PAGE).toMatch(/resolveWizardStartStep\(profile\)/)
    expect(WIZARD_PAGE).not.toMatch(/setCurrentStep\(profile\?\.onboarding_step \|\| 1\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('location entered during onboarding is persisted', () => {
  const fd = (entries: Record<string, string>) => {
    const f = new FormData()
    for (const [k, v] of Object.entries(entries)) f.set(k, v)
    return f
  }

  it('a submitted location reaches the write payload verbatim (trim only)', () => {
    const built = buildProfileUpdate(fd({ location: '  Washington, DC  ' }), { profileComplete: false })
    expect('payload' in built).toBe(true)
    expect((built as any).payload.location).toBe('Washington, DC')
  })

  it('preserves international values without rewriting them', () => {
    for (const v of ['London, UK', 'Singapore', 'München', '東京']) {
      const built = buildProfileUpdate(fd({ location: v }), { profileComplete: false })
      expect((built as any).payload.location).toBe(v)
    }
  })

  it('rejects a placeholder rather than persisting it', () => {
    const built = buildProfileUpdate(fd({ location: 'Remote' }), { profileComplete: false })
    expect('error' in built).toBe(true)
  })

  it('a value persisted by step 1 then satisfies the completion gate', () => {
    const built = buildProfileUpdate(fd({ location: 'Washington, DC' }), { profileComplete: false })
    const stored = (built as any).payload.location
    // ...which is precisely what POST /api/profile/complete re-validates from storage.
    expect(validateLocation(stored).ok).toBe(true)
    expect(resolveWizardStartStep({ ...STUCK_PROFILE, location: stored })).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('completion succeeds for a validly completed onboarding form', () => {
  /** Mirrors the route's gate over a stored row (the route re-validates STORED values). */
  const completionOutcome = (row: { title?: string | null; company?: string | null; location?: string | null }) => {
    const title = (row.title || '').trim()
    const company = (row.company || '').trim()
    if (title.length < 2) return { status: 400, field: 'title' }
    if (company.length < 2) return { status: 400, field: 'company' }
    const loc = validateLocation(row.location)
    if (!loc.ok) return { status: 400, field: 'location' }
    return { status: 200, field: null }
  }

  it('returns 200 once step 1 has been validly completed', () => {
    expect(completionOutcome(READY_PROFILE)).toEqual({ status: 200, field: null })
  })

  it('is the missing location — and nothing else — that blocked the stuck profile', () => {
    expect(completionOutcome(STUCK_PROFILE)).toEqual({ status: 400, field: 'location' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('a completion failure is actionable', () => {
  it('step 2 offers a route back to the fields it cannot itself collect', () => {
    // The prop exists, is wired to the error state, and drives a real control.
    expect(STEP2).toMatch(/onBack\?:\s*\(\)\s*=>\s*void/)
    const errorBlock = STEP2.slice(STEP2.indexOf('{error && ('), STEP2.indexOf('{error && (') + 700)
    expect(errorBlock).toMatch(/onBack/)
    expect(errorBlock).toMatch(/Go back to edit your details/)
    expect(STEP2).toMatch(/role="alert"/)
  })

  it('the wizard page supplies onBack so the control is never inert', () => {
    expect(WIZARD_PAGE).toMatch(/onBack=\{\(\)\s*=>\s*setCurrentStep\(1\)\}/)
  })

  it('renders the back control and the goals screen without throwing', async () => {
    vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
    const { renderToStaticMarkup } = await import('react-dom/server')
    const React = await import('react')
    const { default: Step2 } = await import('@/components/OnboardingStep2')
    const html = renderToStaticMarkup(
      React.createElement(Step2 as any, { profile: null, onBack: () => {} }),
    )
    expect(html).toContain('These answers power your introductions')
    expect(html).toContain('Back')
    expect(html).toContain('Complete Profile')
  })

  it('still renders when no onBack is supplied (prop is optional)', async () => {
    vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
    const { renderToStaticMarkup } = await import('react-dom/server')
    const React = await import('react')
    const { default: Step2 } = await import('@/components/OnboardingStep2')
    const html = renderToStaticMarkup(React.createElement(Step2 as any, { profile: null }))
    expect(html).toContain('Complete Profile')
  })
})
