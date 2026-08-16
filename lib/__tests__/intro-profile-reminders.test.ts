import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Introductions-page profile-reminder UX: the single "Improve your recommendations"
 * card (driven by matchProfileCompletion, dismissible), the per-member dismissal
 * endpoint (UI-only, no matching change), and the simplified empty state.
 */

// ── Visibility logic (matchProfileCompletion drives the card) ────────────────
import { matchProfileCompletion } from '@/lib/matching/profile-completion'

describe('card visibility is driven by matching-profile completeness', () => {
  it('a completed matching profile has no missing areas → card does not show', () => {
    const mc = matchProfileCompletion({ intro_preferences: ['a'], purposes: ['b'], expertise: ['c'], interests: ['d'] })
    expect(mc.complete).toBe(true)
    expect(mc.missing).toHaveLength(0) // showImproveCard = missing.length > 0 → false
  })

  it('an incomplete member gets ONLY their actual missing areas (already-added fields are not suggested)', () => {
    const mc = matchProfileCompletion({ expertise: ['AI'], interests: ['Privacy'] }) // intro_preferences + purposes missing
    expect(mc.complete).toBe(false)
    expect(mc.missing.map((f) => f.key)).toEqual(['intro_preferences', 'purposes'])
    expect(mc.missing.map((f) => f.label)).toEqual(['Who you want to meet', 'Your goals'])
    // completed fields are NOT in the missing list
    expect(mc.missing.map((f) => f.key)).not.toContain('expertise')
    expect(mc.missing.map((f) => f.key)).not.toContain('interests')
  })
})

// ── Dismiss endpoint (persist per member, UI-only) ───────────────────────────
const h = vi.hoisted(() => ({
  user: { id: 'u1' } as any,
  lastUpdate: null as any,
  updateError: null as any,
}))

// Session comes from the server client; the profiles WRITE runs via the admin (service_role) client
// (browser UPDATE on profiles is revoked, migration 055).
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      update: (payload: any) => {
        h.lastUpdate = { table, payload, eq: null as any }
        return { eq: (c: string, v: any) => { h.lastUpdate.eq = [c, v]; return Promise.resolve({ error: h.updateError }) } }
      },
    }),
  }),
}))

import { POST as DISMISS } from '@/app/api/profile/dismiss-intro-prompt/route'

// Same-origin request — the route now enforces assertSameOrigin.
const dreq = () => new Request('http://x/api/profile/dismiss-intro-prompt', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })

beforeEach(() => { h.user = { id: 'u1' }; h.lastUpdate = null; h.updateError = null })

describe('dismiss endpoint — persists per member, touches nothing else', () => {
  it('writes ONLY intro_profile_prompt_dismissed_at on the member profile', async () => {
    const res = await DISMISS(dreq())
    expect(res.status).toBe(200)
    expect((await res.json())).toMatchObject({ ok: true, persisted: true })
    expect(h.lastUpdate.table).toBe('profiles')
    expect(Object.keys(h.lastUpdate.payload)).toEqual(['intro_profile_prompt_dismissed_at']) // no matching/eligibility fields
    expect(h.lastUpdate.eq).toEqual(['id', 'u1'])
  })

  it('does not alter matching eligibility (no other table/column written)', async () => {
    await DISMISS(dreq())
    expect(h.lastUpdate.table).toBe('profiles')
    expect(h.lastUpdate.payload).not.toHaveProperty('account_status')
    expect(h.lastUpdate.payload).not.toHaveProperty('matching_paused')
    expect(h.lastUpdate.payload).not.toHaveProperty('profile_complete')
  })

  it('rejects unauthenticated callers', async () => {
    h.user = null
    expect((await DISMISS(dreq())).status).toBe(401)
  })

  it('fails open when migration 039 is not applied (missing column → best-effort no-op)', async () => {
    h.updateError = { code: '42703', message: 'column profiles.intro_profile_prompt_dismissed_at does not exist' }
    const res = await DISMISS(dreq())
    expect(res.status).toBe(200)
    expect((await res.json())).toMatchObject({ ok: true, persisted: false })
  })
})

// ── Structural: page + components ────────────────────────────────────────────
describe('Introductions page + card structure', () => {
  const page = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
  const card = readFileSync('components/ImproveRecommendationsCard.tsx', 'utf8')
  const profilePage = readFileSync('app/dashboard/profile/page.tsx', 'utf8')
  const matchCard = readFileSync('components/MatchProfileCompletionCard.tsx', 'utf8')

  it('renders at most ONE prominent guidance card (the old multi-card cluster is gone)', () => {
    expect(page).toContain('<ImproveRecommendationsCard')
    for (const removed of ['ProfileCompletionCard', 'ProfilePhotoReminder', 'BroadenPreferencesNotice', 'MatchProfileCompletionCard']) {
      expect(page).not.toContain(removed)
    }
  })

  it('gates the card on missing recommendation fields AND non-dismissal', () => {
    expect(page).toMatch(/showImproveCard = mc\.missing\.length > 0 && !introPromptDismissed/)
    expect(page).toContain('intro_profile_prompt_dismissed_at') // fail-open dismissal read
  })

  it('the "fewer high-quality matches" / under-served warning was removed', () => {
    expect(page).not.toContain('fewer high-quality matches')
    expect(page).not.toContain('underServed')
    expect(page).not.toContain('perRecipientIntroLimit')
  })

  it('empty state is neutral with NO duplicate "Complete your profile" CTA and no notification promise', () => {
    expect(page).toContain('Your next introduction is being curated')
    expect(page).toContain('Check back Thursday for the next curated introduction batch.')
    expect(page).not.toContain('notify you') // no notification promise
    expect(page).not.toContain('Complete your profile')
  })

  it('the card is dismissible ("Not now" → dismiss endpoint) and shows the required copy', () => {
    expect(card).toContain('Improve your recommendations')
    expect(card).toContain('Improve profile')
    expect(card).toContain('Not now')
    expect(card).toContain('/api/profile/dismiss-intro-prompt')
    expect(card).toMatch(/missing\.length === 0.*return null|hidden \|\| missing\.length === 0/)
  })

  it('Profile page keeps the persistent reminder that auto-hides when complete', () => {
    expect(profilePage).toContain('MatchProfileCompletionCard')
    expect(matchCard).toContain('if (m.complete) return null') // disappears when complete
    expect(matchCard).toContain('Improve your recommendations')
  })
})
