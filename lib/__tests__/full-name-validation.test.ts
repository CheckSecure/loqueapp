import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  validateFullName,
  isValidFullName,
  normalizeFullName,
  resolveFullNameUpdate,
  pickOnboardingPrefillName,
  FULL_NAME_ERROR,
} from '@/lib/validation/fullName'
import { buildProfileUpdate } from '@/lib/profile/updatePayload'

// ── The shared validator ─────────────────────────────────────────────────────
describe('validateFullName — rules', () => {
  it('rejects one-word names', () => {
    for (const n of ['Eric', 'Eller', 'Smith', '   Madonna  ', 'X']) {
      const r = validateFullName(n)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe(FULL_NAME_ERROR)
    }
  })

  it('rejects blank / whitespace-only / nullish', () => {
    for (const n of ['', '   ', '\t\n', null, undefined]) {
      expect(validateFullName(n as any).ok).toBe(false)
    }
  })

  it('accepts two-word names and returns the normalized value', () => {
    const r = validateFullName('Eric Eller')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('Eric Eller')
  })

  it('normalizes leading/trailing and repeated internal whitespace', () => {
    const r = validateFullName('  Eric    Eller  ')
    expect(r).toEqual({ ok: true, value: 'Eric Eller' })
    expect(normalizeFullName('  a\t\t b \n c ')).toBe('a b c')
  })

  it('preserves middle names', () => {
    expect(validateFullName('Mary Ann Smith')).toEqual({ ok: true, value: 'Mary Ann Smith' })
  })

  it('preserves initials', () => {
    expect(validateFullName('John A. Doe')).toEqual({ ok: true, value: 'John A. Doe' })
    expect(validateFullName('J. R. R. Tolkien')).toEqual({ ok: true, value: 'J. R. R. Tolkien' })
  })

  it('preserves suffixes', () => {
    expect(validateFullName('Jane Smith Jr.')).toEqual({ ok: true, value: 'Jane Smith Jr.' })
    expect(validateFullName('Rev. Martin Luther King III')).toEqual({ ok: true, value: 'Rev. Martin Luther King III' })
  })

  it('preserves hyphenated names (a hyphenated single token still needs a second token)', () => {
    expect(validateFullName('Anne-Marie Johnson')).toEqual({ ok: true, value: 'Anne-Marie Johnson' })
    expect(validateFullName('Mary-Jane Watson-Parker')).toEqual({ ok: true, value: 'Mary-Jane Watson-Parker' })
    expect(validateFullName('Smith-Jones').ok).toBe(false) // one hyphenated token → still one token
  })

  it('preserves accented and non-ASCII names', () => {
    expect(validateFullName('José García')).toEqual({ ok: true, value: 'José García' })
    expect(validateFullName('Renée  Zellweger')).toEqual({ ok: true, value: 'Renée Zellweger' })
    expect(validateFullName('Björk Guðmundsdóttir')).toEqual({ ok: true, value: 'Björk Guðmundsdóttir' })
    expect(validateFullName("Anne-Marie O'Neil")).toEqual({ ok: true, value: "Anne-Marie O'Neil" })
  })
})

// ── Anti-downgrade (Phase 3) ─────────────────────────────────────────────────
describe('resolveFullNameUpdate — never downgrades a valid name', () => {
  it('keeps a valid existing name when the proposal is one-token/blank', () => {
    expect(resolveFullNameUpdate('Eric Eller', 'Eller')).toEqual({ value: 'Eric Eller', changed: false })
    expect(resolveFullNameUpdate('Eric Eller', '')).toEqual({ value: 'Eric Eller', changed: false })
    expect(resolveFullNameUpdate('Eric Eller', null)).toEqual({ value: 'Eric Eller', changed: false })
  })

  it('accepts a valid proposal (intentional rename), normalized', () => {
    expect(resolveFullNameUpdate('Eric Eller', 'Eric M. Eller')).toEqual({ value: 'Eric M. Eller', changed: true })
    expect(resolveFullNameUpdate('Eric Eller', '  Eric   Eller ')).toEqual({ value: 'Eric Eller', changed: false })
  })

  it('upgrades an invalid existing name when a valid one arrives', () => {
    expect(resolveFullNameUpdate('Eller', 'Eric Eller')).toEqual({ value: 'Eric Eller', changed: true })
    expect(resolveFullNameUpdate(null, 'Eric Eller')).toEqual({ value: 'Eric Eller', changed: true })
  })

  it('never fabricates: two invalid values keep the existing untouched', () => {
    expect(resolveFullNameUpdate('Eller', 'Smith')).toEqual({ value: 'Eller', changed: false })
    expect(resolveFullNameUpdate(null, 'Eller')).toEqual({ value: null, changed: false })
  })
})

// ── Onboarding prefill authority (Phase 2) ───────────────────────────────────
describe('pickOnboardingPrefillName — profile → waitlist → blank', () => {
  it('uses an existing valid profile name first', () => {
    expect(pickOnboardingPrefillName('Ada Lovelace', 'Someone Else')).toBe('Ada Lovelace')
  })

  it('falls back to a valid waitlist name when the profile name is missing/one-word (Eric)', () => {
    expect(pickOnboardingPrefillName(null, 'Eric Eller')).toBe('Eric Eller')
    expect(pickOnboardingPrefillName('Eller', 'Eric Eller')).toBe('Eric Eller')
    expect(pickOnboardingPrefillName('', '  Eric   Eller ')).toBe('Eric Eller')
  })

  it('never prefills a one-word value and blanks when nothing valid is known', () => {
    expect(pickOnboardingPrefillName(null, null)).toBe('')
    expect(pickOnboardingPrefillName(null, 'Eller')).toBe('') // one-word waitlist not used
  })
})

// ── Profile-update payload builder (server, pure) ────────────────────────────
describe('buildProfileUpdate — obeys the same validation', () => {
  const fd = (entries: Record<string, string>) => {
    const f = new FormData()
    for (const [k, v] of Object.entries(entries)) f.set(k, v)
    return f
  }

  it('rejects a one-word full_name', () => {
    const r = buildProfileUpdate(fd({ full_name: 'Eller' }))
    expect(r).toEqual({ error: FULL_NAME_ERROR })
  })

  it('accepts and normalizes a two-word full_name', () => {
    const r = buildProfileUpdate(fd({ full_name: '  Eric   Eller ' }))
    expect('payload' in r && r.payload.full_name).toBe('Eric Eller')
  })

  it('leaves full_name untouched when the field is not submitted (partial update)', () => {
    const r = buildProfileUpdate(fd({ title: 'GC' }))
    expect('payload' in r).toBe(true)
    if ('payload' in r) expect('full_name' in r.payload).toBe(false)
  })
})

// ── Structural: every write path shares the one validator ────────────────────
describe('all write paths use the shared validator', () => {
  const actions = readFileSync('app/actions.ts', 'utf8')
  const updatePayload = readFileSync('lib/profile/updatePayload.ts', 'utf8')
  const referral = readFileSync('app/api/referrals/submit/route.ts', 'utf8')
  const bulk = readFileSync('app/api/admin/bulk-invite/route.ts', 'utf8')
  const onboardingPage = readFileSync('app/onboarding/page.tsx', 'utf8')
  const onboardingForm = readFileSync('components/OnboardingForm.tsx', 'utf8')
  const step1 = readFileSync('components/OnboardingStep1.tsx', 'utf8')
  const waitlistForm = readFileSync('components/WaitlistForm.tsx', 'utf8')
  const referralForm = readFileSync('app/dashboard/referrals/ReferralForm.tsx', 'utf8')

  it('completeOnboarding, updateProfile, and submitWaitlist validate on the server', () => {
    expect(actions).toContain("import { validateFullName } from '@/lib/validation/fullName'")
    // one call per server write path (updateProfile, completeOnboarding, submitWaitlist)
    expect((actions.match(/validateFullName\(/g) || []).length).toBeGreaterThanOrEqual(3)
    expect(actions).toContain('full_name: nameCheck.value')
    expect(actions).toContain('full_name: wlNameCheck.value')
  })

  it('profile-update API (updatePayload) validates', () => {
    expect(updatePayload).toContain('validateFullName')
  })

  it('referral submission validates the nominee name', () => {
    expect(referral).toContain('validateFullName')
    expect(referral).toContain('nomineeNameCheck.value')
  })

  it('admin bulk invite rejects present one-word names and normalizes valid ones', () => {
    expect(bulk).toContain('isValidFullName')
    expect(bulk).toContain('normalizeFullName')
  })

  it('onboarding prefills from waitlist when no valid profile name (server component)', () => {
    expect(onboardingPage).toContain('pickOnboardingPrefillName')
    expect(onboardingPage).toContain("from('waitlist')")
    expect(onboardingForm).toContain('initialFullName')
  })

  it('client forms mirror the same rule', () => {
    for (const src of [onboardingForm, step1, waitlistForm, referralForm]) {
      expect(src).toContain('isValidFullName')
      expect(src).toContain('FULL_NAME_ERROR')
    }
  })
})
