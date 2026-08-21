import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

// Reproduction harness for the recurring post-onboarding blank screen.
//
// Renders the EXACT client-component set that /dashboard/introductions mounts for a
// member who has just finished onboarding and has nothing yet — no suggestion, no
// pair, no incoming interest, no credits row — and asserts none of them throws.
// A RENDER throw here is what production surfaced as
// "Application error: a client-side exception has occurred" + a white screen, because the
// app shipped no error boundary for that segment. Render failures are now contained by
// app/dashboard/error.tsx — but boundaries do NOT catch event handlers, timers, rejected
// promises or realtime callbacks, so those paths are audited separately below.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  redirect: vi.fn(),
  usePathname: () => '/dashboard/introductions',
  useSearchParams: () => new URLSearchParams(),
}))

const render = async (el: any) => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  return renderToStaticMarkup(el)
}

/** The profile a member holds the instant completeOnboarding returns. */
const NEW_MEMBER = {
  id: '00000000-0000-4000-8000-000000000001',
  full_name: 'New Member',
  account_status: 'active',
  profile_complete: true,
  onboarding_step: 1,          // completeOnboarding never advances it
  is_test_account: false,
  matching_paused: false,
  is_admin: false,
  expertise: ['Privacy'],
  interests: null,
  intro_preferences: null,     // the optional preference steps were skipped
  purposes: null,
  subscription_tier: 'free',
  is_founding_member: true,
  founding_member_expires_at: null,
  created_at: new Date().toISOString(),
  intro_profile_prompt_dismissed_at: null,
}

describe('post-onboarding landing — the zero-data client set must not throw', () => {
  it('matchProfileCompletion tolerates the fresh profile and a null row', async () => {
    const { matchProfileCompletion } = await import('@/lib/matching/profile-completion')
    for (const p of [NEW_MEMBER, null, undefined, {}]) {
      const mc = matchProfileCompletion(p as any)
      expect(Array.isArray(mc.missing)).toBe(true)
      expect(Array.isArray(mc.fields)).toBe(true)
    }
    // The fresh member skipped the optional preference steps, so the prompt shows.
    expect(matchProfileCompletion(NEW_MEMBER).missing.length).toBeGreaterThan(0)
  })

  it('the Thursday banner resolves to a live countdown when NO suggestion exists this cycle', async () => {
    const { resolveThursdayBanner, canViewThursdayBanner } = await import('@/lib/introductions/thursdayBanner')
    const facts = {
      accountStatus: NEW_MEMBER.account_status,
      profileComplete: NEW_MEMBER.profile_complete,
      isTestAccount: NEW_MEMBER.is_test_account,
      matchingPaused: NEW_MEMBER.matching_paused,
      isAdmin: NEW_MEMBER.is_admin,
    }
    expect(canViewThursdayBanner(facts)).toBe(true)
    const view = resolveThursdayBanner({
      now: new Date('2026-08-18T12:00:00Z'),
      canView: true,
      receivedThisCycle: false, releasedThisCycle: true,   // brand-new member: nothing generated yet
      scheduleOnly: false,
    })
    expect(view).not.toBeNull()
    // This is the differential: only a member WITHOUT a suggestion runs the live countdown.
    expect(view!.kind).toBe('post_release')
    expect(view!.showCountdown).toBe(true)
  })

  it('renders ThursdayCountdownBanner for the new-member state', async () => {
    const React = await import('react')
    const { default: Banner } = await import('@/components/ThursdayCountdownBanner')
    const { resolveThursdayBanner } = await import('@/lib/introductions/thursdayBanner')
    const view = resolveThursdayBanner({
      now: new Date('2026-08-18T12:00:00Z'), canView: true, receivedThisCycle: false, releasedThisCycle: true,
    })!
    const html = await render(React.createElement(Banner as any, { ...view }))
    expect(html).toContain('Next introduction batch')
  })

  it('renders FoundingMemberWelcomeBanner, ImproveRecommendationsCard and PageHint', async () => {
    const React = await import('react')
    const { matchProfileCompletion } = await import('@/lib/matching/profile-completion')
    const { default: Founding } = await import('@/components/FoundingMemberWelcomeBanner')
    const { default: Improve } = await import('@/components/ImproveRecommendationsCard')
    const { default: PageHint } = await import('@/components/PageHint')

    await expect(render(React.createElement(Founding as any, { show: true }))).resolves.toBeTypeOf('string')
    const missing = matchProfileCompletion(NEW_MEMBER).missing.map((f) => ({ key: f.key, label: f.label }))
    await expect(render(React.createElement(Improve as any, { missing }))).resolves.toBeTypeOf('string')
    await expect(
      render(React.createElement(PageHint as any, { hintKey: 'introductions', children: 'hint' })),
    ).resolves.toBeTypeOf('string')
  })

  it('renders the shared Avatar for a member with no name and no photo', async () => {
    const React = await import('react')
    const { Avatar } = await import('@/components/ui/Avatar')
    const cases: any[] = [
      { id: NEW_MEMBER.id, name: NEW_MEMBER.full_name, src: null },
      { id: NEW_MEMBER.id, name: null, src: null },
      { id: '', name: null, src: null },       // empty id: gradientFromId must not throw
    ]
    for (const props of cases) {
      await expect(render(React.createElement(Avatar as any, props))).resolves.toBeTypeOf('string')
    }
  })
})

describe('post-onboarding landing — the countdown clock cannot throw', () => {
  it('countdownState/formatCountdown are total over the whole cycle and past the target', async () => {
    const { countdownState, formatCountdown, nextBatch } = await import('@/lib/introductions/thursdaySchedule')
    const base = Date.UTC(2026, 7, 18, 12, 0, 0)
    for (let i = 0; i < 24 * 9; i++) {
      const now = new Date(base + i * 3600_000)
      const s = countdownState(now, nextBatch(now))
      expect(s.totalMs).toBeGreaterThanOrEqual(0)
      expect(typeof formatCountdown(s)).toBe('string')
    }
    // Past the target and at the target — clamped, never negative, never empty.
    const t = new Date('2026-08-20T14:00:00Z')
    for (const now of [new Date('2026-08-20T14:00:00Z'), new Date('2026-08-27T00:00:00Z')]) {
      const s = countdownState(now, t)
      expect(s.totalMs).toBe(0)
      expect(formatCountdown(s)).toBe('Arriving shortly')
    }
  })
})

// ── Objective 4: the state transition, fixed ─────────────────────────────────

describe('completion now advances onboarding_step in the SAME server-authorized write', () => {
  const ACTIONS = readFileSync('app/actions.ts', 'utf8')
  const COMPLETE_ROUTE = readFileSync('app/api/profile/complete/route.ts', 'utf8')

  const completeOnboardingBody = () =>
    ACTIONS.slice(
      ACTIONS.indexOf('export async function completeOnboarding'),
      ACTIONS.indexOf('export async function saveAvatarUrl'),
    )

  it('completeOnboarding writes profile_complete AND onboarding_step together', () => {
    const body = completeOnboardingBody()
    expect(body).toMatch(/profile_complete: true/)
    expect(body).toMatch(/onboarding_step: 2/)
    // Same object literal = same write = no window where one is set without the other.
    const upsertStart = body.indexOf(".from('profiles').upsert({")
    const upsertEnd = body.indexOf('}, { onConflict:', upsertStart)
    const payload = body.slice(upsertStart, upsertEnd)
    expect(payload).toMatch(/profile_complete: true/)
    expect(payload).toMatch(/onboarding_step: 2/)
  })

  it('both completion paths agree on the terminal step value', () => {
    expect(COMPLETE_ROUTE).toMatch(/profile_complete: true, onboarding_step: 2/)
    expect(completeOnboardingBody()).toMatch(/onboarding_step: 2/)
  })

  it('drafts keep their resumable step — onboarding_step is written ONLY on completion', () => {
    // The step endpoint remains the only other writer, and it still validates its input.
    const stepRoute = readFileSync('app/api/profile/onboarding-step/route.ts', 'utf8')
    expect(stepRoute).toMatch(/Invalid step/)
    // updateProfile (profile edit) must never touch it.
    const updateBody = ACTIONS.slice(
      ACTIONS.indexOf('export async function updateProfile'),
      ACTIONS.indexOf('export async function submitIntroRequest'),
    )
    expect(updateBody).not.toMatch(/onboarding_step/)
  })
})

// ── Objective 5: failure containment ─────────────────────────────────────────

describe('render-failure containment — accurately scoped', () => {
  const DASH = readFileSync('app/dashboard/error.tsx', 'utf8')
  const GLOBAL = readFileSync('app/global-error.tsx', 'utf8')
  const ONB = readFileSync('app/onboarding/error.tsx', 'utf8')

  it('the dashboard segment, onboarding, and the root all have a RENDER boundary', () => {
    for (const src of [DASH, GLOBAL, ONB]) {
      expect(src).toMatch(/'use client'/)
      expect(src).toMatch(/reset: \(\) => void/)
      expect(src).toMatch(/Try again/)
    }
    expect(GLOBAL).toMatch(/<html/)
    expect(GLOBAL).toMatch(/<body/)
  })

  it('each boundary DOCUMENTS what it cannot catch — no total-containment claim', () => {
    // The review blocker: these must not be presented as catching every client error.
    for (const src of [DASH, GLOBAL]) {
      expect(src).toMatch(/event handler/i)
      expect(src).toMatch(/setInterval|timer/i)
      expect(src).toMatch(/reject(ed|ion)/i)   // 'rejected promises' / 'unhandled promise rejections'
      expect(src).toMatch(/realtime|WebSocket/i)
    }
    expect(ONB).toMatch(/event handler/i)
    // And no file may claim it catches everything.
    for (const src of [DASH, GLOBAL, ONB]) {
      expect(src).not.toMatch(/catches (any|all|every) client(-| )error/i)
    }
  })

  it('renders no stack trace and no error message; the opaque digest is shown as a reference', () => {
    for (const src of [DASH, GLOBAL, ONB]) {
      expect(src).not.toMatch(/\{error\.message\}/)
      expect(src).not.toMatch(/\{error\.stack\}/)
      expect(src).not.toMatch(/error\.stack/)
      // digest IS displayed — an opaque correlation id carrying no member data.
      expect(src).toMatch(/error\.digest/)
      expect(src).toMatch(/Reference:/)
    }
  })

  it('diagnostics reach the server ONLY via the existing hardened beacon, not console', () => {
    for (const src of [DASH, GLOBAL, ONB]) {
      // console.error is browser-only and must be documented as such.
      expect(src).toMatch(/console\.error/)
      expect(src).toMatch(/does NOT reach Vercel|Browser-only/i)
      // The beacon is the actual channel, via the pre-existing /api/metrics facility.
      expect(src).toMatch(/emitMetric\('client_error_boundary'/)
      // Coarse dimensions only — never the message.
      expect(src).toMatch(/errorClass: error\?\.name/)
      expect(src).not.toMatch(/message: error/)
    }
  })

  it('the beacon reuses the existing allowlist — no new vendor, dependency, or endpoint', () => {
    const metrics = readFileSync('lib/metrics.ts', 'utf8')
    expect(metrics).toMatch(/'client_error_boundary'/)
    expect(metrics).toMatch(/ALLOWED_METRICS/)
    // Still the same beacon target and the same sanitizer.
    expect(metrics).toMatch(/'\/api\/metrics'/)
    expect(metrics).toMatch(/sanitizeDims/)
    // The endpoint kept its hardening.
    const route = readFileSync('app/api/metrics/route.ts', 'utf8')
    expect(route).toMatch(/rateLimited/)
    expect(route).toMatch(/isAllowedMetric/)
  })

  it('every boundary offers a forward path, so a member is never stranded', () => {
    for (const src of [DASH, ONB, GLOBAL]) expect(src).toMatch(/\/dashboard\/introductions/)
  })
})

describe('async hazards on the new-member path are handled where they occur', () => {
  it('the countdown TIMER degrades instead of throwing (timers are outside boundaries)', () => {
    const src = readFileSync('components/ThursdayCountdownBanner.tsx', 'utf8')
    const tick = src.slice(src.indexOf('const tick ='), src.indexOf('const start ='))
    expect(tick).toMatch(/try \{/)
    expect(tick).toMatch(/catch/)
    expect(tick).toMatch(/stop\(\)/)          // stops the clock rather than re-throwing every second
    expect(tick).toMatch(/console\.error/)    // not swallowed silently
  })

  it('the onboarding SUBMIT handler handles its own failure (event handlers are outside boundaries)', () => {
    const src = readFileSync('components/OnboardingForm.tsx', 'utf8')
    const submit = src.slice(src.indexOf('const handleSubmit'), src.indexOf('const steps ='))
    expect(submit).toMatch(/try \{/)
    expect(submit).toMatch(/catch \(err\)/)
    expect(submit).toMatch(/console\.error/)
    expect(submit).toMatch(/setSaving\(false\)/)      // form is re-enabled, not left spinning
    expect(submit).toMatch(/try again/i)               // explicit, actionable message
    expect(submit).toMatch(/completeOnboarding\(fd\)/)
  })

  it('the realtime callback is contained (WebSocket callbacks are outside boundaries)', () => {
    const src = readFileSync('components/NotificationBell.tsx', 'utf8')
    expect(src).toMatch(/try \{[\s\S]{0,400}isOwnNotification/)
    expect(src).toMatch(/\[NotificationBell\] realtime payload handling failed/)
  })

  it('PresenceHeartbeat and the layout presence write already handle their own rejections', () => {
    expect(readFileSync('components/PresenceHeartbeat.tsx', 'utf8'))
      .toMatch(/fetch\('\/api\/profile\/heartbeat'[^)]*\)\.catch\(/)
    // The layout's fire-and-forget upsert passes an explicit rejection handler.
    expect(readFileSync('app/dashboard/layout.tsx', 'utf8')).toMatch(/\(\) => \{\},/)
  })

  it('the Tutorial guards every localStorage access', () => {
    const src = readFileSync('components/Tutorial.tsx', 'utf8')
    const reads = src.match(/localStorage\.(getItem|setItem)/g) || []
    expect(reads.length).toBeGreaterThan(0)
    // Each access sits inside a try block.
    expect((src.match(/try \{/g) || []).length).toBeGreaterThanOrEqual(reads.length)
  })
})

describe('the unguarded banner lookup is hardened', () => {
  it('an unknown banner kind falls back instead of throwing', async () => {
    const React = await import('react')
    const { default: Banner } = await import('@/components/ThursdayCountdownBanner')
    const src = readFileSync('components/ThursdayCountdownBanner.tsx', 'utf8')
    expect(src).toMatch(/ACCENT\[kind\] \?\? ACCENT\.pre_release/)
    // Render with a kind the map does not contain — must not throw.
    const html = await render(React.createElement(Banner as any, {
      kind: 'a_state_that_does_not_exist',
      title: 'Next introduction batch: Thursday',
      subtitle: null,
      targetIso: '2026-08-20T14:00:00.000Z',
      showCountdown: true,
      initialCountdownText: '2 days, 2 hours remaining',
    }))
    expect(html).toContain('Next introduction batch')
  })
})

// ── Objective 7: invite vs recovery vs legacy password copy ──────────────────

describe('password copy distinguishes invite, recovery, and legacy — server-derived', () => {
  it('a first-time invitee with NO profile row is told to create a password', async () => {
    const { resolvePasswordSetupMode, passwordSetupCopy } = await import('@/lib/auth/passwordSetupCopy')
    expect(resolvePasswordSetupMode({ profile: null })).toBe('create')
    expect(resolvePasswordSetupMode({ profile: undefined })).toBe('create')
    expect(passwordSetupCopy('create').heading).toBe('Create your password')
    expect(passwordSetupCopy('create').heading).not.toMatch(/reset/i)
  })

  it('an invitee with an INCOMPLETE profile is still "create", not "reset"', async () => {
    const { resolvePasswordSetupMode } = await import('@/lib/auth/passwordSetupCopy')
    expect(resolvePasswordSetupMode({ profile: { profile_complete: false } })).toBe('create')
    expect(resolvePasswordSetupMode({ profile: {} })).toBe('create')
  })

  it('an established completed member keeps "Reset your password"', async () => {
    const { resolvePasswordSetupMode, passwordSetupCopy } = await import('@/lib/auth/passwordSetupCopy')
    expect(resolvePasswordSetupMode({ profile: { profile_complete: true } })).toBe('reset')
    expect(passwordSetupCopy('reset').heading).toBe('Reset your password')
  })

  it('a genuine legacy temporary-password account gets its own wording, and the flag wins', async () => {
    const { resolvePasswordSetupMode, passwordSetupCopy } = await import('@/lib/auth/passwordSetupCopy')
    expect(resolvePasswordSetupMode({ profile: { password_reset_required: true } })).toBe('legacy')
    // Even when the profile is also complete, the legacy gate takes precedence.
    expect(resolvePasswordSetupMode({
      profile: { profile_complete: true, password_reset_required: true },
    })).toBe('legacy')
    expect(passwordSetupCopy('legacy').heading).toBe('Set your password')
  })

  it('the mode is derived server-side and never from the URL or sessionStorage', () => {
    const route = readFileSync('app/api/auth/password-context/route.ts', 'utf8')
    const page = readFileSync('app/auth/reset-password/page.tsx', 'utf8')
    // Server: authenticated self read via the A3 RPC, never a base-table read.
    expect(route).toMatch(/auth\.getUser\(\)/)
    expect(route).toMatch(/rpc\('get_my_profile'\)/)
    expect(route).not.toMatch(/\.from\('profiles'\)/)
    // Returns ONLY the mode — every NextResponse.json body in the route is { mode }.
    const bodies = route.match(/NextResponse\.json\(([^)]*)\)/g) || []
    expect(bodies.length).toBeGreaterThan(0)
    for (const b of bodies) expect(b).toMatch(/\{ mode: /)
    for (const b of bodies) expect(b).not.toMatch(/email|full_name|id\b/)
    // Client: mode comes from the endpoint, not from the fragment or storage.
    expect(page).toMatch(/fetch\('\/api\/auth\/password-context'\)/)
    expect(page).not.toMatch(/copyMode[^\n]*sessionStorage/)
    expect(page).not.toMatch(/copyMode[^\n]*location\.hash/)
  })

  it('an unauthenticated caller learns nothing — the neutral default, never an error', () => {
    const route = readFileSync('app/api/auth/password-context/route.ts', 'utf8')
    expect(route).toMatch(/if \(!user\) return NextResponse\.json\(\{ mode: DEFAULT_MODE \}\)/)
  })

  it('the neutral default is "unknown" — true in all three cases, never a wrong assertion', async () => {
    const { DEFAULT_MODE, passwordSetupCopy } = await import('@/lib/auth/passwordSetupCopy')
    expect(DEFAULT_MODE).toBe('unknown')
    const neutral = passwordSetupCopy(DEFAULT_MODE)
    expect(neutral.heading).toBe('Choose your password')
    // Neutral copy must not assert reset OR create.
    expect(neutral.heading).not.toMatch(/reset/i)
    expect(neutral.heading).not.toMatch(/create/i)
  })

  it('an unrecognised payload degrades to neutral instead of throwing', async () => {
    const { passwordSetupCopy, isPasswordSetupMode } = await import('@/lib/auth/passwordSetupCopy')
    for (const bad of [undefined, null, '', 'nonsense', 42, {}]) {
      expect(isPasswordSetupMode(bad)).toBe(false)
      expect(passwordSetupCopy(bad as any).heading).toBe('Choose your password')
    }
  })

  it('the copy request cannot loop, gate a phase, or become an unhandled rejection', () => {
    const page = readFileSync('app/auth/reset-password/page.tsx', 'utf8')
    // Exactly one CALL SITE (prose mentions don't count), inside the one mount effect.
    expect((page.match(/fetch\('\/api\/auth\/password-context'\)/g) || []).length).toBe(1)
    // A rejection handler is present, so it can never surface as an unhandled rejection.
    expect(page).toMatch(/password-context'\)[\s\S]{0,300}\.catch\(/)
    // Only the mode narrows; no setPhase, no retry loop.
    expect(page).not.toMatch(/password-context[\s\S]{0,300}setPhase/)
    // The value is validated before it is applied — no arbitrary string reaches state.
    expect(page).toMatch(/isPasswordSetupMode\(d\?\.mode\)/)
  })

  it('first paint uses the neutral copy, so there is no flash of incorrect wording', () => {
    const page = readFileSync('app/auth/reset-password/page.tsx', 'utf8')
    // Initial state is DEFAULT_MODE ('unknown'), identical server-side and on first client
    // render → no hydration mismatch and no wrong-wording flash; it only ever narrows.
    expect(page).toMatch(/useState<PasswordSetupDisplayMode>\(DEFAULT_MODE\)/)
  })

  it('the security-critical reset machinery is untouched', () => {
    const page = readFileSync('app/auth/reset-password/page.tsx', 'utf8')
    // Server-side password set + flag clear, and the display-only marker contract.
    expect(page).toMatch(/\/api\/auth\/complete-reset/)
    expect(page).toMatch(/mode: 'finalize'/)
    expect(page).toMatch(/DISPLAY ONLY/)
    // The copy fetch must not gate any phase transition.
    expect(page).not.toMatch(/password-context[^\n]*setPhase/)
  })

  it('the pre-verification confirm screen stays neutral (no session ⇒ no server signal)', () => {
    const recover = readFileSync('app/auth/recover/page.tsx', 'utf8')
    expect(recover).toMatch(/Confirm it&rsquo;s you/)
    expect(recover).not.toMatch(/Confirm password reset/)
    // JSX button label only — prose in comments is not member-facing.
    const buttonLabels = (recover.match(/>\s*Continue[^<]*</g) || []).join('|')
    expect(buttonLabels).not.toMatch(/Continue password reset/)
    // Token verification is unchanged.
    expect(recover).toMatch(/RecoveryFlow/)
  })
})

// ── Objective 9: nothing else regressed ──────────────────────────────────────

describe('preserved behaviour', () => {
  it('required-location enforcement and migration 061 are intact', () => {
    const actions = readFileSync('app/actions.ts', 'utf8')
    expect(actions).toMatch(/validateLocation\(derivedLocation\)/)
    expect(readFileSync('supabase/migrations/061_profiles_complete_requires_location.sql', 'utf8'))
      .toMatch(/profiles_complete_requires_location_chk/)
  })

  it('no authenticated direct base-profile read or write was introduced', () => {
    for (const f of ['app/api/auth/password-context/route.ts', 'app/dashboard/error.tsx', 'app/global-error.tsx', 'app/onboarding/error.tsx']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/\.from\('profiles'\)/)
    }
  })

  it('the fail-closed onboarding gate and no-profile invitee fix are intact', () => {
    expect(readFileSync('lib/onboarding/steps.ts', 'utf8')).toMatch(/if \(args\.error\) return \{ kind: 'error' \}/)
    expect(readFileSync('app/onboarding/page.tsx', 'utf8')).toMatch(/rpc\('get_my_profile'\)/)
  })

  it('Thursday countdown behaviour and the Andrel/Recommended separation survive', () => {
    expect(readFileSync('lib/introductions/thursdayBanner.ts', 'utf8')).toMatch(/receivedThisCycle === true/)
    expect(readFileSync('lib/introductions/andrelSection.ts', 'utf8')).toMatch(/export function buildIntroSections/)
  })
})
