import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Every field a member MUST complete during signup / onboarding carries a visible required
 * marker, and no optional field carries one.
 *
 * WHY THIS IS A TEST AND NOT A STYLE NOTE: the marker had drifted per field — location and the
 * password/full-name fields were marked, everything else that was equally required (company,
 * role title, seniority, expertise, bio) was not. A member could only discover those
 * requirements by failing to submit. These tests pin the marker to the ACTUAL requirement, so a
 * field that becomes required without being marked (or a marker on an optional field) fails.
 *
 * SCOPE: labelling only. Nothing here asserts, adds, or relaxes validation — the separate
 * "validation is unchanged" block below pins the real gates so this UI pass cannot have moved them.
 */

const STEP1 = readFileSync('components/OnboardingStep1.tsx', 'utf8')
const STEP2 = readFileSync('components/OnboardingStep2.tsx', 'utf8')
const FORM = readFileSync('components/OnboardingForm.tsx', 'utf8')
const MARK = readFileSync('components/ui/RequiredMark.tsx', 'utf8')
const AUTH_RESET = readFileSync('app/auth/reset-password/page.tsx', 'utf8')
const DASH_RESET = readFileSync('app/dashboard/reset-password/page.tsx', 'utf8')
const SIGNUP = readFileSync('app/signup/page.tsx', 'utf8')

/**
 * A label is marked when <RequiredMark /> is rendered inside the SAME label/legend/heading as
 * the given text. Scans EVERY occurrence (the same words can appear in a comment or a heading),
 * and reports marked when any real label carries it.
 */
const labelMarked = (src: string, label: string): boolean => {
  let from = 0
  let found = false
  for (;;) {
    const i = src.indexOf(label, from)
    if (i === -1) break
    found = true
    from = i + label.length
    const rest = src.slice(i, i + 300)
    const end = rest.search(/<\/(label|legend|h3)>/)
    if (end === -1) continue // not inside a label element (comment/heading text)
    if (/<RequiredMark\s*\/>/.test(rest.slice(0, end))) return true
  }
  if (!found) throw new Error(`label not found: ${label}`)
  return false
}

describe('the required marker itself', () => {
  it('is defined once and shared, so styling cannot drift between forms', () => {
    expect(MARK).toMatch(/export function RequiredMark/)
    expect(MARK).toMatch(/text-red-500/)
  })

  it('does not communicate the requirement by colour or glyph alone', () => {
    // the asterisk is decorative; assistive tech gets real text
    expect(MARK).toMatch(/aria-hidden="true"/)
    expect(MARK).toMatch(/sr-only/)
    expect(MARK).toMatch(/\(required\)/)
  })

  it('every form that shows markers imports the shared component', () => {
    for (const src of [STEP1, FORM, AUTH_RESET, DASH_RESET]) {
      expect(src).toMatch(/from '@\/components\/ui\/RequiredMark'/)
    }
  })

  it('no form hand-rolls its own asterisk any more', () => {
    for (const src of [STEP1, FORM, AUTH_RESET, DASH_RESET]) {
      // a bare red asterisk span outside the shared component would be drift
      expect(src).not.toMatch(/<span className="text-red-500">\*<\/span>/)
    }
  })
})

describe('wizard step 1 — required fields are marked', () => {
  // Required by: HTML required, the client gate in handleSubmit, and/or the server
  // (buildProfileUpdate rejects an empty submitted value; /api/profile/complete re-validates).
  // 'Company or organization' moved out of the unconditional list: since employment status is
  // asked directly, the organisation is required only for "Currently employed". Its own test is
  // below, and it asserts the marker is CONDITIONAL rather than absent.
  const REQUIRED = ['Full name', 'Location', 'Bio', 'Seniority', 'Role title']
  for (const label of REQUIRED) {
    it(`marks "${label}"`, () => expect(labelMarked(STEP1, label)).toBe(true))
  }
  it('marks the Expertise group (server rejects an empty expertise list)', () => {
    expect(labelMarked(STEP1, 'Expertise')).toBe(true)
  })

  it('marks the organisation field only when the member says they are employed', () => {
    // the label itself is now driven by the chosen status …
    expect(STEP1).toContain("employmentStatusOption(currentStatus)?.companyLabel ?? 'Company or organization'")
    // … and both the marker and the browser-level requirement are conditional on 'employed'
    expect(STEP1).toMatch(/\{currentStatus === 'employed' && <RequiredMark \/>\}/)
    expect(STEP1).toContain("required={currentStatus === 'employed'}")
  })

  it('marks the new Employment status question as required', () => {
    const FIELD = readFileSync('components/profile/EmploymentStatusField.tsx', 'utf8')
    expect(FIELD).toMatch(/Employment status\{required &&/)
  })
  it('shows the legend explaining the asterisk', () => {
    expect(STEP1).toMatch(/<RequiredLegend\s*\/>/)
  })
  it('does NOT mark the optional Links group', () => {
    expect(labelMarked(STEP1, '>Links (optional)')).toBe(false)
  })
})

describe('/onboarding form — required fields are marked', () => {
  const REQUIRED = [
    'New password', 'Confirm password', 'Full name',
    'Company or organization', 'Location', 'Role title', 'Seniority level', 'Areas of expertise',
  ]
  for (const label of REQUIRED) {
    it(`marks "${label}"`, () => expect(labelMarked(FORM, label)).toBe(true))
  }
  it('shows the legend on both the password and profile steps', () => {
    expect(FORM.match(/<RequiredLegend\s*\/>/g)?.length).toBe(2)
  })

  // Optional by construction — nothing validates them anywhere.
  const OPTIONAL = ['Short bio', 'Who do you want to meet?', 'Specific connections', "What's the purpose?", 'Current focus areas']
  for (const label of OPTIONAL) {
    it(`does NOT mark optional "${label}"`, () => expect(labelMarked(FORM, `>${label}`)).toBe(false))
  }

  it('does NOT mark "State, region, or country" — city alone satisfies the location rule', () => {
    expect(labelMarked(FORM, 'State, region, or country')).toBe(false)
  })
})

describe('wizard step 2 — nothing on it is required, so nothing is marked', () => {
  it('carries no required markers', () => {
    expect(STEP2).not.toMatch(/<RequiredMark\s*\/>/)
  })
  it('its three groups really are optional (no validation references them)', () => {
    // completion requires only title/company/location; none of step 2's fields appear there.
    const COMPLETE = readFileSync('app/api/profile/complete/route.ts', 'utf8')
    for (const f of ['purposes', 'interests', 'intro_preferences']) {
      expect(COMPLETE).not.toMatch(new RegExp(`${f}[^\\n]*required`, 'i'))
    }
  })
})

describe('password-set pages used when joining', () => {
  it('marks both password fields on the secure invite page', () => {
    expect(labelMarked(AUTH_RESET, 'New password')).toBe(true)
    expect(labelMarked(AUTH_RESET, 'Confirm password')).toBe(true)
  })
  it('marks both password fields on the legacy temp-password gate', () => {
    expect(labelMarked(DASH_RESET, '>New Password')).toBe(true)
    expect(labelMarked(DASH_RESET, '>Confirm Password')).toBe(true)
  })
})

describe('there is no public signup form to audit', () => {
  it('/signup redirects (the network is invite-only)', () => {
    expect(SIGNUP).toMatch(/redirect\(/)
    expect(SIGNUP).not.toMatch(/<form/)
  })
})

describe('validation behaviour is unchanged by this labelling pass', () => {
  it('step 1 still enforces its client gates', () => {
    expect(STEP1).toMatch(/if \(!roleType\.trim\(\)\)/)
    expect(STEP1).toMatch(/isValidFullName/)
    expect(STEP1).toMatch(/validateLocation\(formData\.get\('location'\)/)
  })

  it('step 1 keeps required + aria-required on the location input', () => {
    const i = STEP1.indexOf('name="location"')
    const block = STEP1.slice(i, i + 500)
    expect(block).toMatch(/\brequired\b/)
    expect(block).toMatch(/aria-required="true"/)
  })

  it('the /onboarding form still enforces every field gate it had', () => {
    for (const gate of [
      /isValidFullName\(fullName\)/,
      /title\.trim\(\)\.length < 2/,
      /company\.trim\(\)\.length < 2/,
      /!roleType\.trim\(\)/,
      /!seniority\.trim\(\)/,
      /expertise\.filter\(Boolean\)\.length === 0/,
    ]) expect(FORM).toMatch(gate)
  })

  it('no NEW html required attribute was added to a previously-optional field', () => {
    // company in /onboarding is validated in JS, not by the browser — marking it must not
    // have silently turned it into an HTML-blocking field.
    const i = FORM.indexOf('Company or organization')
    const block = FORM.slice(i, i + 420)
    expect(block).not.toMatch(/\brequired\b/)
  })
})
