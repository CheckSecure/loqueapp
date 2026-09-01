import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const ACTIONS = readFileSync('app/actions.ts', 'utf8')
const PAGE = readFileSync('app/dashboard/admin/members/page.tsx', 'utf8')
const CLIENT = readFileSync('components/AdminMembersClient.tsx', 'utf8')
const INTROS = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')

describe('admin can pause a member from matching', () => {
  it('adminUpdateUser accepts the field through its allow-list', () => {
    // Every field is copied individually and browser DML on profiles is revoked (055), so an
    // unlisted field silently does nothing rather than writing.
    expect(ACTIONS).toContain('matching_paused?: boolean')
    expect(ACTIONS).toContain('if (updates.matching_paused !== undefined) profileUpdates.matching_paused = updates.matching_paused')
  })

  it('the members page reads the column', () => {
    expect(PAGE).toContain('matching_paused')
  })

  it('the list shows who is paused without opening a member', () => {
    expect(CLIENT).toContain('PAUSED')
    expect(CLIENT).toContain('user.matching_paused === true')
  })

  it('the toggle writes through the existing quick-edit path', () => {
    expect(CLIENT).toContain("handleQuickEdit(selectedUser.id, 'matching_paused', e.target.checked)")
  })

  it('the copy distinguishes a pause from deactivation', () => {
    // Conflating the two is the expensive mistake: deactivation is not reversible in the same way
    // and has entirely different consequences for the member.
    expect(CLIENT).toContain('Reversible.')
    expect(CLIENT).toMatch(/account, messages and existing introductions are unaffected/i)
  })
})

describe('a paused member sees a neutral state, not silence', () => {
  it('renders an explanation when paused', () => {
    expect(INTROS).toContain('Introductions are paused')
    expect(INTROS).toContain('matchingPausedView')
  })

  it('is derived from the profile row, and excludes admins', () => {
    // canViewThursdayBanner already grants an admin the schedule view; showing both would
    // contradict itself.
    expect(INTROS).toContain("(profileRow as any)?.matching_paused === true && !isAdminViewer")
  })

  it('assigns no fault and gives no reason', () => {
    // RENDERED copy only. The comment above the block quotes the phrasings it rejects
    // ("you were removed"), so a raw slice matches the very words this asserts are absent.
    const raw = INTROS.slice(INTROS.indexOf('{matchingPausedView && ('), INTROS.indexOf('{thursdayBanner && ('))
    const block = raw.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join(' ').replace(/\s+/g, ' ')   // JSX wraps the copy across lines; compare on one line
    for (const blame of ['removed', 'violation', 'not a fit', 'ineligible', 'suspended']) {
      expect(block.toLowerCase()).not.toContain(blame)
    }
    expect(block).toContain('existing connections are unaffected')
  })
})

describe('the referral campaign deliberately still reaches paused members', () => {
  it('matching_paused is absent from the campaign column list, on purpose', () => {
    const ELIG = readFileSync('lib/referralCampaign/eligibility.ts', 'utf8')
    const code = ELIG.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toContain('matching_paused')
    // The reasoning is recorded next to the column list so this reads as a decision, not a gap.
    expect(ELIG).toContain('matching_paused is DELIBERATELY ABSENT')
  })
})
