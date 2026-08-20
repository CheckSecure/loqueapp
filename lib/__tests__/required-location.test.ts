import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  validateLocation,
  isValidLocation,
  isPlaceholderLocation,
  normalizeLocation,
  resolveLocationUpdate,
  LOCATION_ERROR,
  LOCATION_MAX_LENGTH,
  PLACEHOLDER_LOCATION_KEYS,
} from '@/lib/validation/location'
import { buildProfileUpdate } from '@/lib/profile/updatePayload'

// Regression cover for the required-physical-location work. Three completed profiles
// had reached profile_complete=true with no usable location (two NULL, one "Remote").

const ACTIONS = readFileSync('app/actions.ts', 'utf8')
const COMPLETE_ROUTE = readFileSync('app/api/profile/complete/route.ts', 'utf8')
const UPDATE_ROUTE = readFileSync('app/api/profile/update/route.ts', 'utf8')
const ONBOARDING_FORM = readFileSync('components/OnboardingForm.tsx', 'utf8')
const STEP1 = readFileSync('components/OnboardingStep1.tsx', 'utf8')
const PROFILE_FORM = readFileSync('components/ProfileForm.tsx', 'utf8')
const PROFILE_EDIT_FORM = readFileSync('components/ProfileEditForm.tsx', 'utf8')

const MIGRATION_061 = readFileSync('supabase/migrations/061_profiles_complete_requires_location.sql', 'utf8')

const fd = (entries: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.set(k, v)
  return f
}

// ── A faithful model of migration 061's CHECK ────────────────────────────────
// Written from the SQL semantics, NOT by importing the app validator, so the two
// implementations are genuinely independent and a divergence would surface here.
//
//   btrim(location, E' \t\n\r\f\v')          → sqlBtrim
//   length(...)                              → sqlLength (characters, not UTF-16)
//   regexp_replace(..., '[^<ascii alnum>]')  → strip, enumerated (no a-z ranges)
//   translate(..., 'A-Z', 'a-z')             → deterministic ASCII lowercase
//   <> ALL (ARRAY[...])                      → placeholder membership

const SQL_WHITESPACE = [' ', '\t', '\n', '\r', '\f', '\v']
const SQL_ASCII_ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const SQL_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const SQL_LOWER = 'abcdefghijklmnopqrstuvwxyz'

function sqlBtrim(s: string): string {
  let start = 0
  let end = s.length
  while (start < end && SQL_WHITESPACE.includes(s[start])) start++
  while (end > start && SQL_WHITESPACE.includes(s[end - 1])) end--
  return s.slice(start, end)
}

/** Postgres length() counts characters (code points), not UTF-16 code units. */
function sqlLength(s: string): number {
  return Array.from(s).length
}

/** regexp_replace to ASCII alphanumerics, then translate() to lowercase. */
function sqlPlaceholderKey(s: string): string {
  let out = ''
  for (const ch of Array.from(s)) {
    if (!SQL_ASCII_ALNUM.includes(ch)) continue
    const upper = SQL_UPPER.indexOf(ch)
    out += upper >= 0 ? SQL_LOWER[upper] : ch
  }
  return out
}

/** True when the row would SATISFY the CHECK constraint (i.e. the write is allowed). */
function sqlConstraintSatisfied(location: string | null, profileComplete: boolean): boolean {
  if (profileComplete !== true) return true // profile_complete IS NOT TRUE
  if (location === null) return false
  const trimmed = sqlBtrim(location)
  if (trimmed === '') return false
  if (sqlLength(trimmed) > 120) return false
  if (PLACEHOLDER_LOCATION_KEYS.includes(sqlPlaceholderKey(location))) return false
  return true
}

/** The exact examples the location contract must accept, across scripts. */
const CANONICAL_ACCEPTED = [
  'New York, NY',
  'Boston',
  'Asheville, NC',
  'London, UK',
  'Singapore',
  'São Paulo, Brazil',
  'Kraków',
  'München',
  '東京',
  '北京',
  'دبي',
  'ירושלים',
]

/** Every placeholder the contract must reject, in the wording the policy uses. */
const CANONICAL_PLACEHOLDERS = [
  'remote', 'remote only', 'anywhere', 'virtual', 'n/a', 'na', 'none',
  'not applicable', 'prefer not to say', 'tbd', 'wfh', 'work from home',
  'hybrid', 'fully remote', 'remote first', 'distributed', 'digital nomad',
  'nomad', 'online', 'internet', 'global', 'worldwide', 'everywhere',
  'nowhere', 'earth', 'unknown', 'undisclosed', 'tba',
  'prefer not to answer', 'decline to state',
]

// ── The shared contract ───────────────────────────────────────────────────────

describe('location validator — missing and whitespace cannot satisfy the requirement', () => {
  it('rejects null, undefined, empty and whitespace-only', () => {
    for (const v of [null, undefined, '', ' ', '   ', '\t', '\n', ' \t \n ']) {
      expect(isValidLocation(v as any)).toBe(false)
      const r = validateLocation(v as any)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe(LOCATION_ERROR)
    }
  })

  it('rejects values carrying fewer than two letters', () => {
    for (const v of ['-', '--', '.', '...', '?', '123', '12345', ',', ', ,', 'x']) {
      expect(isValidLocation(v)).toBe(false)
    }
  })
})

describe('location validator — placeholders are not locations', () => {
  const REQUIRED_PLACEHOLDERS = [
    'remote',
    'remote only',
    'anywhere',
    'virtual',
    'n/a',
    'na',
    'none',
    'not applicable',
    'prefer not to say',
    'TBD',
  ]

  it('rejects every placeholder named in the policy, case-insensitively', () => {
    for (const p of REQUIRED_PLACEHOLDERS) {
      for (const variant of [p, p.toUpperCase(), p.toLowerCase(), ` ${p} `, p.replace(/ /g, '  ')]) {
        expect(isPlaceholderLocation(variant), `${JSON.stringify(variant)} should be a placeholder`).toBe(true)
        expect(isValidLocation(variant), `${JSON.stringify(variant)} should be invalid`).toBe(false)
      }
    }
  })

  it('rejects the exact production value that slipped through ("Remote")', () => {
    expect(isValidLocation('Remote')).toBe(false)
    expect(validateLocation('Remote')).toEqual({ ok: false, error: LOCATION_ERROR })
  })

  it('rejects punctuation/spacing variants of the same answer', () => {
    for (const v of ['N/A', 'n / a', 'N.A.', 'Remote-only', 'REMOTE ONLY', 'Work From Home', 'WFH', 'Hybrid']) {
      expect(isValidLocation(v), `${v} should be invalid`).toBe(false)
    }
  })

  it('matches placeholders only on the WHOLE value, never as a substring', () => {
    // Real places that merely contain a placeholder word must survive.
    for (const v of ['Virginia Beach, VA', 'Nanaimo, BC', 'Nashville, TN', 'Naples, Italy', 'Nantes, France']) {
      expect(isValidLocation(v), `${v} should be valid`).toBe(true)
    }
  })
})

describe('location validator — legitimate domestic and international formats pass', () => {
  const VALID = [
    'New York, NY',
    'Boston',
    'Asheville, NC',
    'London, UK',
    'Singapore',
    'San Francisco, CA',
    'Washington, D.C.',
    'St. Louis, MO',
    'Winston-Salem, NC',
    'LA',
    'Toronto, Ontario, Canada',
    'São Paulo, Brazil',
    'Zürich, Switzerland',
    'Kraków, Poland',
    'Mexico City',
    'Dubai, UAE',
    'Tel Aviv, Israel',
    'Auckland, New Zealand',
    'Bengaluru, India',
    '東京',
    'Seoul, South Korea',
    'Greater Chicago Area',
    'San Francisco Bay Area',
  ]

  it('accepts every legitimate format', () => {
    for (const v of VALID) {
      expect(isValidLocation(v), `${v} should be valid`).toBe(true)
    }
  })

  it('requires NO comma and NO US state', () => {
    for (const v of ['Boston', 'Singapore', 'Mexico City', 'Auckland']) {
      expect(v.includes(','), `${v} fixture should have no comma`).toBe(false)
      expect(isValidLocation(v)).toBe(true)
    }
  })

  it('enforces a reasonable maximum length', () => {
    expect(isValidLocation('a'.repeat(LOCATION_MAX_LENGTH))).toBe(true)
    const tooLong = validateLocation('a'.repeat(LOCATION_MAX_LENGTH + 1))
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.error).toMatch(new RegExp(String(LOCATION_MAX_LENGTH)))
  })
})

describe('location normalization — trims but never rewrites', () => {
  it('trims surrounding whitespace and collapses internal runs', () => {
    expect(normalizeLocation('  New York, NY  ')).toBe('New York, NY')
    expect(normalizeLocation('London,\tUK')).toBe('London, UK')
    const r = validateLocation('   Boston   ')
    expect(r).toEqual({ ok: true, value: 'Boston' })
  })

  it('preserves capitalization, punctuation, accents and script verbatim', () => {
    for (const v of ['boston', 'BOSTON', 'Washington, D.C.', 'São Paulo', "Coeur d'Alene, ID", '東京']) {
      const r = validateLocation(v)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value).toBe(v)
    }
  })

  it('never geocodes or expands — "Boston" does NOT become "Boston, MA"', () => {
    const r = validateLocation('Boston')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('Boston')
      expect(r.value).not.toMatch(/,\s*MA/)
    }
  })
})

// ── Draft vs complete ────────────────────────────────────────────────────────

describe('incomplete drafts may temporarily omit location; complete profiles may not lose it', () => {
  it('a draft may save with location blank', () => {
    expect(resolveLocationUpdate('', { profileComplete: false })).toEqual({ ok: true, value: null })
    expect(resolveLocationUpdate('   ', { profileComplete: false })).toEqual({ ok: true, value: null })
    expect(resolveLocationUpdate(null, { profileComplete: false })).toEqual({ ok: true, value: null })
  })

  it('a COMPLETE profile cannot clear its location', () => {
    for (const blank of ['', '   ', null, undefined]) {
      const r = resolveLocationUpdate(blank as any, { profileComplete: true })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe(LOCATION_ERROR)
    }
  })

  it('a COMPLETE profile cannot replace its location with a placeholder', () => {
    for (const p of ['Remote', 'N/A', 'anywhere', 'TBD', 'virtual']) {
      expect(resolveLocationUpdate(p, { profileComplete: true }).ok).toBe(false)
    }
  })

  it('a placeholder is refused on a DRAFT too — writing "Remote" is never an improvement', () => {
    for (const p of ['Remote', 'N/A', 'anywhere']) {
      expect(resolveLocationUpdate(p, { profileComplete: false }).ok).toBe(false)
    }
  })

  it('a valid value is accepted and stored normalized, in either state', () => {
    for (const complete of [true, false]) {
      expect(resolveLocationUpdate('  London, UK ', { profileComplete: complete }))
        .toEqual({ ok: true, value: 'London, UK' })
    }
  })
})

// ── The shared write-payload builder (profile edit) ──────────────────────────

describe('buildProfileUpdate — location rules at the edit boundary', () => {
  const err = (f: FormData, ctx?: { profileComplete?: boolean }) => {
    const r = buildProfileUpdate(f, ctx)
    return 'error' in r ? r.error : null
  }
  const payload = (f: FormData, ctx?: { profileComplete?: boolean }) => {
    const r = buildProfileUpdate(f, ctx)
    if ('error' in r) throw new Error('unexpected error: ' + r.error)
    return r.payload
  }

  it('omitting location/city/state leaves the stored value untouched', () => {
    const p = payload(fd({ bio: 'hi' }), { profileComplete: true })
    expect(p).not.toHaveProperty('location')
  })

  it('rejects a placeholder location whatever the completion state', () => {
    for (const complete of [true, false]) {
      expect(err(fd({ location: 'Remote' }), { profileComplete: complete })).toBe(LOCATION_ERROR)
      expect(err(fd({ location: 'N/A' }), { profileComplete: complete })).toBe(LOCATION_ERROR)
    }
  })

  it('rejects clearing the location of a COMPLETE profile', () => {
    expect(err(fd({ location: '' }), { profileComplete: true })).toBe(LOCATION_ERROR)
    expect(err(fd({ location: '   ' }), { profileComplete: true })).toBe(LOCATION_ERROR)
    expect(err(fd({ city: '', state: '' }), { profileComplete: true })).toBe(LOCATION_ERROR)
  })

  it('allows a DRAFT to save with the location blank', () => {
    expect(payload(fd({ location: '' }), { profileComplete: false }).location).toBeNull()
  })

  it('rejects a placeholder arriving via the city/state pair', () => {
    expect(err(fd({ city: 'Remote', state: '' }), { profileComplete: false })).toBe(LOCATION_ERROR)
    expect(err(fd({ city: 'Anywhere', state: '' }), { profileComplete: true })).toBe(LOCATION_ERROR)
  })

  it('stores the normalized value and still writes city/state independently', () => {
    const p = payload(fd({ city: ' Boston ', state: ' MA ' }), { profileComplete: true })
    expect(p).toMatchObject({ city: 'Boston', state: 'MA', location: 'Boston, MA' })
  })

  it('accepts international city/state pairs (no US state required)', () => {
    expect(payload(fd({ city: 'London', state: 'UK' }), { profileComplete: true }).location).toBe('London, UK')
    expect(payload(fd({ city: 'Singapore', state: '' }), { profileComplete: true }).location).toBe('Singapore')
  })

  it('defaults to the permissive draft case when no context is supplied', () => {
    // An omitted context must never be treated as "complete" (which would block
    // legitimate draft saves), and must never let a placeholder through either.
    expect(buildProfileUpdate(fd({ location: '' }))).toEqual({ payload: { location: null } })
    expect(err(fd({ location: 'Remote' }))).toBe(LOCATION_ERROR)
  })
})

// ── Server authority: every profile_complete=true boundary validates ─────────

describe('server boundaries — profile_complete can never be set on an invalid location', () => {
  it('completeOnboarding validates the derived location BEFORE the upsert that sets profile_complete', () => {
    expect(ACTIONS).toMatch(/validateLocation\(derivedLocation\)/)
    const gate = ACTIONS.indexOf('const locationCheck = validateLocation(derivedLocation)')
    const upsert = ACTIONS.indexOf('profile_complete: true')
    expect(gate).toBeGreaterThan(-1)
    expect(upsert).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(upsert)
    // The validated value is what gets stored — not the raw form input.
    expect(ACTIONS).toMatch(/const location = locationCheck\.value/)
  })

  it('/api/profile/complete re-validates the STORED location, so a skipped client cannot bypass it', () => {
    expect(COMPLETE_ROUTE).toMatch(/validateLocation\(identity\?\.location\)/)
    expect(COMPLETE_ROUTE).toMatch(/select\('title, company, location'\)/)
    const gate = COMPLETE_ROUTE.indexOf('validateLocation(identity?.location)')
    const write = COMPLETE_ROUTE.indexOf('profile_complete: true')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(write)
  })

  it('/api/profile/update passes the row’s real completion state to the shared builder', () => {
    expect(UPDATE_ROUTE).toMatch(/buildProfileUpdate\(formData, \{ profileComplete \}\)/)
    expect(UPDATE_ROUTE).toMatch(/select\('profile_complete'\)/)
  })

  it('updateProfile (profile edit) guards location and never sets profile_complete', () => {
    expect(ACTIONS).toMatch(/resolveLocationUpdate\(formData\.get\('location'\)/)
    const updateProfileBody = ACTIONS.slice(
      ACTIONS.indexOf('export async function updateProfile'),
      ACTIONS.indexOf('export async function submitIntroRequest'),
    )
    // It READS profile_complete (to decide whether a blank is an allowed draft
    // state) but must never WRITE it — profile edits cannot complete a profile.
    expect(updateProfileBody).not.toMatch(/profile_complete:\s*(true|false)/)
    expect(updateProfileBody).toMatch(/profileComplete: priorRow\?\.profile_complete === true/)
  })

  it('both completion paths use the ONE shared authority, not a local copy', () => {
    expect(ACTIONS).toMatch(/from '@\/lib\/validation\/location'/)
    expect(COMPLETE_ROUTE).toMatch(/from '@\/lib\/validation\/location'/)
    expect(UPDATE_ROUTE + ACTIONS + COMPLETE_ROUTE).not.toMatch(/PLACEHOLDER_LOCATION_KEYS\s*=/)
  })
})

// ── Client UX ────────────────────────────────────────────────────────────────

describe('onboarding UX — location is required, labelled and accessible', () => {
  it('the top-level onboarding form gates advancing AND submitting on location', () => {
    expect(ONBOARDING_FORM).toMatch(/if \(!checkLocation\(\)\) return/)
    expect(ONBOARDING_FORM).toMatch(/const locationCheck = validateLocation\(derivedLocation\(\)\)/)
    // Derivation mirrors the server exactly.
    expect(ONBOARDING_FORM).toMatch(/c && s \? `\$\{c\}, \$\{s\}` : c \|\| s \|\| ''/)
  })

  it('the top-level onboarding form labels the group "Location" and marks it required', () => {
    expect(ONBOARDING_FORM).toMatch(/<legend[^>]*>\s*Location/)
    expect(ONBOARDING_FORM).toMatch(/aria-required="true"/)
    // The required marker now comes from the ONE shared component (components/ui/RequiredMark),
    // so every form marks a required field identically instead of hand-rolling the markup. The
    // accessibility contract this line has always protected is unchanged and is asserted at its
    // new source: the asterisk is aria-hidden and the requirement is carried by real sr-only text,
    // so it is never communicated by colour or glyph alone.
    expect(ONBOARDING_FORM).toMatch(/Location<RequiredMark \/>/)
    const REQUIRED_MARK = readFileSync('components/ui/RequiredMark.tsx', 'utf8')
    expect(REQUIRED_MARK).toMatch(/<span className="sr-only">\(required\)<\/span>/)
    expect(REQUIRED_MARK).toMatch(/aria-hidden="true"/)
    expect(ONBOARDING_FORM).toMatch(/id="onboarding-location-error"/)
    expect(ONBOARDING_FORM).toMatch(/role="alert"/)
    expect(ONBOARDING_FORM).toMatch(/cityInputRef\.current\?\.focus\(\)/)
  })

  it('the dashboard onboarding step requires location with error association', () => {
    expect(STEP1).toMatch(/const locationCheck = validateLocation\(formData\.get\('location'\) as string\)/)
    expect(STEP1).toMatch(/id="step1-location-error"/)
    expect(STEP1).toMatch(/aria-required="true"/)
    expect(STEP1).toMatch(/locationInputRef\.current\?\.focus\(\)/)
    expect(STEP1).toMatch(/role="alert"/)
  })

  it('both onboarding surfaces show international-friendly guidance, never a US-only shape', () => {
    expect(ONBOARDING_FORM).toMatch(/London, UK/)
    expect(STEP1).toMatch(/London, UK/)
    // The second box accepts a region or country, so no member is forced into a US state.
    expect(ONBOARDING_FORM).toMatch(/State, region, or country/)
  })

  it('no onboarding or profile surface labels location as optional', () => {
    for (const [name, src] of Object.entries({ ONBOARDING_FORM, STEP1, PROFILE_FORM, PROFILE_EDIT_FORM })) {
      const near = src.match(/.{0,160}[Ll]ocation.{0,160}/g) || []
      for (const window of near) {
        expect(window.toLowerCase(), `${name}: "optional" must not appear beside a location field`)
          .not.toMatch(/optional/)
      }
    }
  })

  it('no surface asks for a street or home address', () => {
    for (const src of [ONBOARDING_FORM, STEP1, PROFILE_FORM, PROFILE_EDIT_FORM]) {
      expect(src).not.toMatch(/street|home address|mailing address|postal code|zip code/i)
    }
  })

  it('no copy claims the location was verified', () => {
    for (const src of [ONBOARDING_FORM, STEP1, PROFILE_FORM, PROFILE_EDIT_FORM]) {
      expect(src).not.toMatch(/location (is |was )?(verified|confirmed)/i)
      expect(src).not.toMatch(/we (verify|confirm) your location/i)
    }
  })
})

describe('profile-edit UX — a complete profile cannot quietly drop its location', () => {
  it('ProfileForm validates before calling the server action', () => {
    expect(PROFILE_FORM).toMatch(/const locationCheck = validateLocation\(formData\.get\('location'\) as string\)/)
    const gate = PROFILE_FORM.indexOf('const locationCheck = validateLocation')
    const call = PROFILE_FORM.indexOf('await updateProfile(formData)')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(call)
    expect(PROFILE_FORM).toMatch(/id="profile-location-error"/)
  })

  it('ProfileEditForm validates the derived location before POSTing', () => {
    expect(PROFILE_EDIT_FORM).toMatch(/const locationCheck = validateLocation\(derivedLocation\)/)
    const gate = PROFILE_EDIT_FORM.indexOf('const locationCheck = validateLocation')
    const post = PROFILE_EDIT_FORM.indexOf("fetch('/api/profile/update'")
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(post)
    expect(PROFILE_EDIT_FORM).toMatch(/id="edit-location-error"/)
  })
})

// ── Unicode parity: TypeScript validator vs migration 061's CHECK ────────────

describe('Unicode parity — every canonical example passes BOTH engines', () => {
  it.each(CANONICAL_ACCEPTED)('accepts %s in TypeScript AND in the modeled SQL constraint', (value) => {
    expect(isValidLocation(value), `${value}: TypeScript must accept`).toBe(true)
    expect(sqlConstraintSatisfied(value, true), `${value}: SQL CHECK must be satisfied`).toBe(true)
  })

  it('accepts non-Latin scripts because their placeholder key is empty in BOTH engines', () => {
    for (const value of ['東京', '北京', 'دبي', 'ירושלים']) {
      expect(sqlPlaceholderKey(value)).toBe('')
      expect(isPlaceholderLocation(value)).toBe(false)
      expect(isValidLocation(value)).toBe(true)
      expect(sqlConstraintSatisfied(value, true)).toBe(true)
    }
  })

  it('never transliterates or folds accents — the stored value is returned verbatim', () => {
    for (const value of ['São Paulo, Brazil', 'Kraków', 'München', '東京', 'ירושלים']) {
      const r = validateLocation(value)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value).toBe(value)
    }
    // The accent-stripped forms are an internal lookup key only; they must never
    // become the stored value.
    expect(validateLocation('München')).toEqual({ ok: true, value: 'München' })
    expect(sqlPlaceholderKey('München')).toBe('mnchen')
  })
})

describe('Unicode parity — every placeholder fails BOTH engines', () => {
  it.each(CANONICAL_PLACEHOLDERS)('rejects "%s" in TypeScript AND in the modeled SQL constraint', (value) => {
    for (const variant of [value, value.toUpperCase(), ` ${value} `, value.replace(/ /g, '  ')]) {
      expect(isValidLocation(variant), `${variant}: TypeScript must reject`).toBe(false)
      expect(sqlConstraintSatisfied(variant, true), `${variant}: SQL CHECK must be violated`).toBe(false)
    }
  })

  it('covers every placeholder named in the policy — no gaps in the shared key list', () => {
    for (const value of CANONICAL_PLACEHOLDERS) {
      expect(PLACEHOLDER_LOCATION_KEYS, `${value} must have a key entry`)
        .toContain(sqlPlaceholderKey(value))
    }
  })
})

describe('Unicode parity — a placeholder-looking substring never rejects a real place', () => {
  const REAL_PLACES_RESEMBLING_PLACEHOLDERS = [
    'Virginia Beach, VA',   // contains "virtual"-ish prefix
    'Nashville, TN',        // "na…"
    'Naples, Italy',        // "na…"
    'Nantes, France',
    'Nanaimo, BC',
    'Nome, AK',             // one letter from "none"
    'Nome',
    'Normal, IL',
    'Globe, AZ',            // real Arizona town vs "global"
    'Earth, TX',            // real Texas town vs "earth"
    'Hybrid Park, CA',
    'Remoteness Bay',       // starts with "remote"
    'Onlineville',
    'Distributed Springs',
  ]

  it.each(REAL_PLACES_RESEMBLING_PLACEHOLDERS)('keeps %s in BOTH engines', (value) => {
    expect(isValidLocation(value), `${value}: TypeScript must accept`).toBe(true)
    expect(sqlConstraintSatisfied(value, true), `${value}: SQL CHECK must be satisfied`).toBe(true)
  })
})

describe('Unicode parity — the DB floor is NEVER stricter than the validator', () => {
  // The one invariant that actually protects members: if TypeScript let a value be
  // saved, the constraint must not then reject the row.
  const CORPUS = [
    ...CANONICAL_ACCEPTED,
    ...CANONICAL_PLACEHOLDERS,
    'New York, NY', 'Washington, D.C.', "Coeur d'Alene, ID", 'Winston-Salem, NC',
    'St. Louis, MO', 'Toronto, Ontario, Canada', 'Zürich, Switzerland',
    'Tel Aviv, Israel', 'Bengaluru, India', 'Greater Chicago Area', 'LA',
    'Seoul, South Korea', 'Mexico City', 'Dubai, UAE', 'Auckland, New Zealand',
    '  Boston  ', 'London,\tUK', 'a'.repeat(LOCATION_MAX_LENGTH),
    'a'.repeat(LOCATION_MAX_LENGTH + 1), '', '   ', '-', '--', '...', '123', 'x',
    'N/A', 'n / a', 'N.A.', 'Remote-only', 'REMOTE ONLY', 'WFH', '東 京',
  ]

  it.each(CORPUS)('TypeScript-accepted implies SQL-satisfied for %j', (value) => {
    if (isValidLocation(value)) {
      expect(sqlConstraintSatisfied(value, true), `${value}: accepted by TS but rejected by the CHECK`).toBe(true)
    }
  })

  it('the reverse asymmetry is intentional: SQL is the coarser floor', () => {
    // Values the constraint tolerates but the application refuses. This is the
    // documented trade — the letter-count rule stays server-side because it cannot
    // be expressed locale-independently in SQL.
    for (const value of ['-', '--', '...', '123', 'x']) {
      expect(sqlConstraintSatisfied(value, true), `${value}: SQL floor tolerates it`).toBe(true)
      expect(isValidLocation(value), `${value}: TypeScript refuses it`).toBe(false)
    }
  })

  it('astral characters can only make TypeScript stricter, never the database', () => {
    // JS .length counts UTF-16 code units (2 per astral char); Postgres length()
    // counts 1. So the app hits the 120 cap first — never the other way round.
    const astral = '𝒩𝑒𝓌 𝒴𝑜𝓇𝓀'
    expect(astral.length).toBeGreaterThan(sqlLength(astral))
    const long = '𝒩'.repeat(70) // 140 UTF-16 units, 70 characters
    expect(isValidLocation(long)).toBe(false)          // TS: over the cap
    expect(sqlConstraintSatisfied(long, true)).toBe(true) // SQL: within the cap
  })
})

describe('migration 061 — the SQL matches the shared contract literally', () => {
  // The ENFORCED constraint body only — sliced from ADD CONSTRAINT to the
  // NOT VALID that terminates it. `indexOf('NOT VALID')` alone would hit the
  // header commentary first and yield an empty string, which would make the
  // assertions below pass vacuously.
  const enforcedCheck = () => {
    const start = MIGRATION_061.indexOf('ADD CONSTRAINT')
    const end = MIGRATION_061.indexOf('NOT VALID;', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return MIGRATION_061.slice(start, end)
  }

  const arraysInSql = () => {
    const out: string[][] = []
    const re = /ARRAY\[([^\]]*)\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(MIGRATION_061)) !== null) {
      const keys = (m[1].match(/'([a-z0-9]+)'/g) || []).map((s) => s.replace(/'/g, ''))
      if (keys.length) out.push(keys)
    }
    return out
  }

  it('every placeholder ARRAY in the migration equals the exported TypeScript list', () => {
    const arrays = arraysInSql()
    expect(arrays.length).toBeGreaterThanOrEqual(2) // the CHECK + preflight A
    for (const keys of arrays) {
      expect([...keys].sort()).toEqual([...PLACEHOLDER_LOCATION_KEYS].sort())
    }
  })

  it('uses locale-independent constructs only — no ranges, no lower(), no bare btrim', () => {
    const body = MIGRATION_061
    // Enumerated character class, never a collation-dependent a-z / A-Z range.
    expect(body).toMatch(/\[\^abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\]/)
    expect(body).not.toMatch(/\[\^a-zA-Z0-9\]/)
    // translate() rather than lower(), which is locale-sensitive (Turkish I).
    expect(body).toMatch(/translate\(/)
    expect(body).not.toMatch(/lower\(regexp_replace/)
    // Explicit whitespace set: bare btrim() strips spaces only.
    expect(body).toMatch(/btrim\(location, E' \\t\\n\\r\\f\\v'\)/)
    // The letter-count rule must NOT appear in the enforced CHECK.
    const check = enforcedCheck()
    expect(check.length).toBeGreaterThan(200)
    expect(check).not.toMatch(/\[\[:alpha:\]\]|\[\[:punct:\]\]|\[\[:digit:\]\]/)
  })

  it('enforces exactly the three shared rules, and lets drafts through', () => {
    const check = enforcedCheck()
    expect(check).toMatch(/profile_complete IS NOT TRUE/)
    expect(check).toMatch(/location IS NOT NULL/)
    expect(check).toMatch(/<> ''/)
    expect(check).toMatch(/<= 120/)
    expect(check).toMatch(/<> ALL \(ARRAY\[/)
  })

  it('is additive, idempotent and rolls out NOT VALID → VALIDATE', () => {
    expect(MIGRATION_061).toMatch(/IF NOT EXISTS \(/)
    expect(MIGRATION_061).toMatch(/FROM pg_constraint/)
    expect(MIGRATION_061).toMatch(/NOT VALID;/)
    expect(MIGRATION_061).toMatch(/VALIDATE CONSTRAINT profiles_complete_requires_location_chk/)
    expect(MIGRATION_061).not.toMatch(/\bDROP COLUMN\b|\bALTER COLUMN\b|\bADD COLUMN\b/)
  })

  it('scopes the idempotency guard to public.profiles, not to the constraint name alone', () => {
    // pg_constraint is unique per relation (conrelid + contypid + conname), so a
    // name-only existence check would match an identically-named constraint on an
    // unrelated table and skip protecting profiles entirely.
    const guard = MIGRATION_061.slice(
      MIGRATION_061.indexOf('IF NOT EXISTS ('),
      MIGRATION_061.indexOf(') THEN'),
    )
    expect(guard.length).toBeGreaterThan(40)
    expect(guard).toMatch(/FROM pg_constraint/)
    expect(guard).toMatch(/conname = 'profiles_complete_requires_location_chk'/)
    expect(guard).toMatch(/conrelid = 'public\.profiles'::regclass/)
    // Both predicates must be ANDed together in the same lookup.
    expect(guard).toMatch(
      /conname = 'profiles_complete_requires_location_chk'\s+AND\s+conrelid = 'public\.profiles'::regclass/,
    )
    // And the guard must not be a bare name-only lookup anywhere in the file.
    expect(MIGRATION_061).not.toMatch(
      /FROM pg_constraint\s+WHERE conname = 'profiles_complete_requires_location_chk'\s*\)/,
    )
  })

  it('carries NO member-specific IDs or data changes — corrections stay separate', () => {
    expect(MIGRATION_061).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(MIGRATION_061).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i)
    expect(MIGRATION_061).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\s/im)
  })

  it('the required preflight mirrors the CHECK, and the advisory one is labelled best-effort', () => {
    expect(MIGRATION_061).toMatch(/PREFLIGHT A — REQUIRED, READ-ONLY/)
    expect(MIGRATION_061).toMatch(/PREFLIGHT B — ADVISORY/)
    expect(MIGRATION_061).toMatch(/BEST EFFORT ONLY/)
    // Advisory only: the locale-dependent classes appear solely in preflight B.
    const advisory = MIGRATION_061.slice(MIGRATION_061.indexOf('PREFLIGHT B'))
    expect(advisory).toMatch(/\[\[:space:\]\[:digit:\]\[:punct:\]\]/)
  })
})

// ── Security posture must be unchanged ───────────────────────────────────────

describe('security posture is preserved', () => {
  it('no authenticated direct profiles mutation is reintroduced — writes stay service_role', () => {
    for (const [name, src] of Object.entries({ UPDATE_ROUTE, COMPLETE_ROUTE })) {
      // Every profiles write in these routes goes through the admin (service_role) client.
      const writes = src.match(/\.from\('profiles'\)\s*\n?\s*\.update\(/g) || []
      expect(writes.length, `${name} should still write profiles`).toBeGreaterThan(0)
      expect(src).toMatch(/createAdminClient\(\)/)
    }
    // The new self-read of profile_complete is a service_role read scoped to user.id,
    // not a restored authenticated base-table read.
    expect(UPDATE_ROUTE).toMatch(/createAdminClient\(\)\s*\n?\s*\.from\('profiles'\)\s*\n?\s*\.select\('profile_complete'\)/)
    expect(UPDATE_ROUTE).toMatch(/\.eq\('id', user\.id\)/)
  })

  it('the same-origin guard still fronts both write routes', () => {
    expect(UPDATE_ROUTE).toMatch(/assertSameOrigin\(req\)/)
    expect(COMPLETE_ROUTE).toMatch(/assertSameOrigin\(req\)/)
  })

  it('the top-level no-profile invitee onboarding fix is intact (get_my_profile RPC, not a base read)', () => {
    const page = readFileSync('app/onboarding/page.tsx', 'utf8')
    expect(page).toMatch(/supabase\.rpc\('get_my_profile'\)/)
    expect(page).toMatch(/selfProfileFromRpc/)
    expect(page).not.toMatch(/\.from\('profiles'\)\s*\n?\s*\.select/)
  })

  it('the onboarding gate still fails closed on a lookup error', () => {
    const steps = readFileSync('lib/onboarding/steps.ts', 'utf8')
    expect(steps).toMatch(/if \(args\.error\) return \{ kind: 'error' \}/)
  })

  it('no location work touched the protected migrations 048/058/059/060', () => {
    for (const f of [
      'supabase/migrations/048_drop_profiles_last_active_at.sql',
      'supabase/migrations/058_revoke_authenticated_profiles_select.sql',
      'supabase/migrations/059_harden_security_definer_functions.sql',
      'supabase/migrations/060_restore_is_admin_authenticated_execute.sql',
    ]) {
      const sql = readFileSync(f, 'utf8')
      expect(sql).not.toMatch(/location/i)
    }
  })
})
