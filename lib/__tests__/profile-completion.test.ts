import { describe, it, expect } from 'vitest'
import {
  computeProfileCompletionFields,
  completionPercent,
  isOnlyPhotoMissing,
  COMPLETION_ITEMS,
  type ProfileCompletionFields,
} from '@/lib/profileCompletion'
import { shouldShowPhotoReminder, type PhotoReminderState } from '@/lib/photoReminder'

const NOW = 1_700_000_000_000

const ALL_TRUE: ProfileCompletionFields = {
  photo: true, company: true, role: true, expertise: true, about: true, linkedin: true, location: true,
}
const allExcept = (missing: keyof ProfileCompletionFields): ProfileCompletionFields => ({
  ...ALL_TRUE,
  [missing]: false,
})

describe('shared completion calculation (single source of truth)', () => {
  it('computes field booleans from a profile row', () => {
    expect(
      computeProfileCompletionFields({
        avatar_url: 'x', company: 'Acme', role_type: 'Legal', expertise: ['AI'],
        bio: 'hi', linkedin_url: 'u', location: 'NYC',
      }),
    ).toEqual(ALL_TRUE)
  })
  it('treats blanks/whitespace/empty arrays as incomplete', () => {
    const f = computeProfileCompletionFields({ avatar_url: null, company: '  ', expertise: [] })
    expect(f.photo).toBe(false)
    expect(f.company).toBe(false)
    expect(f.expertise).toBe(false)
  })
  it('percent is 100 only when every field is present', () => {
    expect(completionPercent(ALL_TRUE)).toBe(100)
    expect(completionPercent(allExcept('photo'))).toBe(80)
  })
  it('keeps Profile photo in the shared checklist', () => {
    expect(COMPLETION_ITEMS.some((i) => i.key === 'photo' && i.label === 'Profile photo')).toBe(true)
  })
})

describe('expertise completeness across storage formats (Jeffrey Langer regression)', () => {
  // Every profile below has all OTHER fields complete; only the expertise
  // storage shape varies. The old Array.isArray check failed all string shapes.
  const base = {
    avatar_url: 'x', company: 'Acme', role_type: 'General Counsel',
    bio: 'hi', linkedin_url: 'https://linkedin.com/in/x', location: 'NYC',
  }
  const expertiseOf = (expertise: unknown) => computeProfileCompletionFields({ ...base, expertise })

  it('native string array → complete', () => {
    expect(expertiseOf(['Privacy', 'M&A']).expertise).toBe(true)
  })
  it('JSON-encoded array string → complete (was the bug)', () => {
    expect(expertiseOf('["Privacy","M&A"]').expertise).toBe(true)
  })
  it('comma-separated string → complete', () => {
    expect(expertiseOf('Privacy, M&A').expertise).toBe(true)
  })
  it('Postgres array literal → complete', () => {
    expect(expertiseOf('{Privacy,"M&A"}').expertise).toBe(true)
  })
  it('single non-array string value → complete', () => {
    expect(expertiseOf('Privacy').expertise).toBe(true)
  })

  it('null / empty array / empty string / "[]" / whitespace → incomplete', () => {
    for (const v of [null, undefined, [], '', '   ', '[]', '{}', '[ ]']) {
      expect(expertiseOf(v).expertise).toBe(false)
    }
  })
  it('malformed JSON falls back gracefully (treated as CSV, or empty)', () => {
    expect(expertiseOf('["Privacy"').expertise).toBe(true)   // recovers "Privacy"
    expect(expertiseOf('[,,]').expertise).toBe(false)         // no real values
  })

  it('an existing string-expertise user with all fields complete reaches 100% (banner hidden)', () => {
    const jeffrey = { ...base, expertise: '["Privacy","Regulatory","M&A"]' }
    const fields = computeProfileCompletionFields(jeffrey)
    expect(fields.expertise).toBe(true)
    expect(completionPercent(fields)).toBe(100)      // was 85 before the fix
    expect(isOnlyPhotoMissing(fields)).toBe(false)   // nothing missing at all
  })

  it('same user MINUS expertise stays at 85% (isolates the regressed field)', () => {
    const fields = computeProfileCompletionFields({ ...base, expertise: '[]' })
    expect(fields.expertise).toBe(false)
    expect(completionPercent(fields)).toBe(85)
  })
})

describe('introductions-page banner decision (end-to-end from a profile row)', () => {
  // Mirrors app/dashboard/introductions/page.tsx exactly:
  //   isOnlyPhotoMissing → ProfilePhotoReminder (separate prompt)
  //   else percent < 100 (and not dismissed) → "Complete your profile" banner
  //   else → nothing (ProfileCompletionCard self-hides at 100%)
  function bannerFor(
    row: any,
    completionDismissed = false,
  ): 'photo-reminder' | 'complete-your-profile-banner' | 'none' {
    const fields = computeProfileCompletionFields(row)
    if (isOnlyPhotoMissing(fields)) return 'photo-reminder'
    return completionPercent(fields) < 100 && !completionDismissed
      ? 'complete-your-profile-banner'
      : 'none'
  }

  // Jeffery Langer's ACTUAL stored value (verified in Supabase): a JSON-encoded
  // array held as a text string.
  const JEFFERY_EXPERTISE =
    '["Legal","M&A","Corporate Governance","Intellectual Property","Lobbying","Technology","Cybersecurity"]'
  const complete = {
    avatar_url: 'https://cdn/x.jpg', company: 'Acme Legal', role_type: 'General Counsel',
    bio: 'Seasoned GC.', linkedin_url: 'https://linkedin.com/in/jl', location: 'Chicago, IL',
  }

  it('all fields + string-stored expertise → banner does NOT render', () => {
    expect(bannerFor({ ...complete, expertise: JEFFERY_EXPERTISE })).toBe('none')
  })

  it('missing expertise → "Complete your profile" banner DOES render', () => {
    expect(bannerFor({ ...complete, expertise: '[]' })).toBe('complete-your-profile-banner')
    expect(bannerFor({ ...complete, expertise: null })).toBe('complete-your-profile-banner')
  })

  it('missing ONLY a photo → the separate photo prompt, never the completion banner', () => {
    const decision = bannerFor({ ...complete, avatar_url: null, expertise: JEFFERY_EXPERTISE })
    expect(decision).toBe('photo-reminder')
    expect(decision).not.toBe('complete-your-profile-banner')
  })
})

describe('percentage consistency across surfaces', () => {
  // The banner (introductions page) and the checklist (ProfileCompletionCard)
  // both derive from computeProfileCompletionFields → completionPercent, so a
  // given row yields ONE percentage everywhere. Verify string vs array agree.
  it('array-stored and JSON-string-stored versions of the same profile match', () => {
    const asArray = computeProfileCompletionFields({
      avatar_url: 'x', company: 'Acme', role_type: 'GC', bio: 'hi',
      linkedin_url: 'u', location: 'NYC', expertise: ['Privacy', 'M&A'],
    })
    const asString = computeProfileCompletionFields({
      avatar_url: 'x', company: 'Acme', role_type: 'GC', bio: 'hi',
      linkedin_url: 'u', location: 'NYC', expertise: '["Privacy","M&A"]',
    })
    expect(completionPercent(asArray)).toBe(completionPercent(asString))
    expect(completionPercent(asArray)).toBe(100)
  })
})

describe('which prompt renders (mutual exclusion)', () => {
  // Mirrors the Introductions page decision exactly.
  function decide(
    fields: ProfileCompletionFields,
    reminderState: PhotoReminderState | null,
    completionDismissed: boolean,
    now = NOW,
  ): 'photo-reminder' | 'completion-card' | 'none' {
    if (isOnlyPhotoMissing(fields)) {
      return shouldShowPhotoReminder(fields.photo, reminderState, now) ? 'photo-reminder' : 'none'
    }
    return completionPercent(fields) < 100 && !completionDismissed ? 'completion-card' : 'none'
  }

  it('missing photo + other missing fields → completion card only', () => {
    const fields = { ...ALL_TRUE, photo: false, company: false }
    expect(isOnlyPhotoMissing(fields)).toBe(false)
    expect(decide(fields, null, false)).toBe('completion-card')
  })

  it('missing photo with every other field complete → photo reminder only', () => {
    const fields = allExcept('photo')
    expect(isOnlyPhotoMissing(fields)).toBe(true)
    expect(decide(fields, null, false)).toBe('photo-reminder')
  })

  it('existing photo → no photo reminder', () => {
    // photo present, one other gap → completion card; never the photo reminder
    expect(decide(allExcept('company'), null, false)).toBe('completion-card')
    // fully complete → nothing
    expect(decide(ALL_TRUE, null, false)).toBe('none')
  })

  it('snoozed reminder (only photo missing) → neither renders', () => {
    const fields = allExcept('photo')
    const snoozed: PhotoReminderState = { count: 1, hiddenUntil: NOW + 21 * 24 * 60 * 60 * 1000 }
    expect(decide(fields, snoozed, false)).toBe('none') // not the completion card either
  })

  it('NO field/state combination ever renders both prompts at once', () => {
    const keys: (keyof ProfileCompletionFields)[] = [
      'photo', 'company', 'role', 'expertise', 'about', 'linkedin', 'location',
    ]
    const states: (PhotoReminderState | null)[] = [
      null,
      { count: 1, hiddenUntil: NOW + 1 },
      { count: 3, hiddenUntil: null },
    ]
    for (let mask = 0; mask < 1 << keys.length; mask++) {
      const fields = {} as ProfileCompletionFields
      keys.forEach((k, i) => { (fields[k] as boolean) = Boolean(mask & (1 << i)) })
      for (const st of states) {
        for (const dismissed of [false, true]) {
          const photoReminderActive =
            isOnlyPhotoMissing(fields) && shouldShowPhotoReminder(fields.photo, st, NOW)
          const completionCardActive =
            !isOnlyPhotoMissing(fields) && completionPercent(fields) < 100 && !dismissed
          expect(photoReminderActive && completionCardActive).toBe(false)
        }
      }
    }
  })
})
