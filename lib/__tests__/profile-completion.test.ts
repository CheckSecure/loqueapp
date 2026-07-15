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
