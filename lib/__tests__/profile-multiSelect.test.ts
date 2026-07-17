import { describe, it, expect } from 'vitest'
import { parseMultiSelectField, serializeMultiSelectField } from '@/lib/profile/multiSelect'

// The full persistence pipeline for goals (purposes) + interests is:
//   UI array → serializeMultiSelectField → FormData string → parseMultiSelectField
//   → stored array → API (select '*') → UI (profile.X || [])
// so a round-trip through serialize+parse must return the identical array.
const roundTrip = (arr: string[]) => parseMultiSelectField(serializeMultiSelectField(arr))

describe('serializeMultiSelectField (client) — array → FormData string', () => {
  it('empty / single / multiple / null', () => {
    expect(serializeMultiSelectField([])).toBe('')
    expect(serializeMultiSelectField(['Sports'])).toBe('Sports')
    expect(serializeMultiSelectField(['Find customers', 'Raise capital'])).toBe('Find customers,Raise capital')
    expect(serializeMultiSelectField(null)).toBe('')
    expect(serializeMultiSelectField(undefined)).toBe('')
  })
})

describe('parseMultiSelectField (server) — FormData string → stored array', () => {
  it('empty selection → empty array', () => {
    expect(parseMultiSelectField('')).toEqual([])
    expect(parseMultiSelectField(null)).toEqual([])
    expect(parseMultiSelectField(undefined)).toEqual([])
  })
  it('single / multiple selections', () => {
    expect(parseMultiSelectField('Sports')).toEqual(['Sports'])
    expect(parseMultiSelectField('Sports,Travel,Music')).toEqual(['Sports', 'Travel', 'Music'])
  })
  it('malformed / legacy values: extra commas + whitespace are cleaned', () => {
    expect(parseMultiSelectField(' Sports , , Travel ,')).toEqual(['Sports', 'Travel'])
    expect(parseMultiSelectField(',,,')).toEqual([])
  })
})

describe('round-trip persistence (array → DB → API → UI → identical array)', () => {
  const ALL_PURPOSES = ['Find customers', 'Raise capital', 'Hire talent', 'Learn & grow', 'Expand network', 'Give back / mentor', 'Explore opportunities']
  const ALL_INTERESTS = ['Sports', 'Travel', 'Food & wine', 'Arts & culture', 'Technology', 'Fitness', 'Reading', 'Music', 'Volunteering']

  it('empty selection round-trips to []', () => {
    expect(roundTrip([])).toEqual([])
  })
  it('single selection round-trips identically', () => {
    expect(roundTrip(['Hire talent'])).toEqual(['Hire talent'])
  })
  it('multiple selections round-trip identically', () => {
    expect(roundTrip(['Find customers', 'Learn & grow'])).toEqual(['Find customers', 'Learn & grow'])
  })
  it('ALL purposes round-trip identically', () => {
    expect(roundTrip(ALL_PURPOSES)).toEqual(ALL_PURPOSES)
  })
  it('ALL interests round-trip identically', () => {
    expect(roundTrip(ALL_INTERESTS)).toEqual(ALL_INTERESTS)
  })
  it('save → reload → identical values (idempotent under repeated round-trips)', () => {
    const selection = ['Sports', 'Technology', 'Reading']
    expect(roundTrip(roundTrip(selection))).toEqual(selection)
  })
})

describe("Jeffery Langer's exact production case", () => {
  it('purposes=[] and interests=null both start empty and persist a new selection', () => {
    // Before the fix his stored values were purposes:[] and interests:null.
    expect(serializeMultiSelectField([])).toBe('')          // empty goals render nothing
    expect(parseMultiSelectField(null)).toEqual([])          // null interests → [] in the UI

    // He selects goals + interests; they now round-trip and persist.
    const goals = ['Learn & grow', 'Expand network']
    const interests = ['Technology', 'Reading']
    expect(roundTrip(goals)).toEqual(goals)
    expect(roundTrip(interests)).toEqual(interests)
  })
})
