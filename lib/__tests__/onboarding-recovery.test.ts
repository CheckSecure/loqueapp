import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { evaluateReminder, isCatchupCandidate, classifyCatchup, STAGE_FLOORS_HOURS, type ReminderCandidate } from '@/lib/onboarding/reminderEligibility'
import { mintResumeToken, parseResumeToken, sha256, buildResumeLink, RESUME_TOKEN_BYTES, RESUME_GENERIC_RESPONSE } from '@/lib/invitations/resumeToken'

/**
 * Incomplete-onboarding recovery.
 *
 * Database behaviour (privileges under Supabase's inherited defaults, the atomic claim, rate-limit
 * windows, terminal invalidation, per-stage dedupe and concurrent claims) is proven in
 * scripts/verify-077-078-onboarding.sh — 47 assertions against a real PostgreSQL cluster that is
 * destroyed afterwards. These tests pin the pure logic and the source facts a future edit could
 * quietly remove.
 */

const H = 3_600_000
const NOW = Date.parse('2026-08-23T12:00:00Z')
const ago = (h: number) => new Date(NOW - h * H).toISOString()

/**
 * Executable code with comments stripped. These files deliberately DOCUMENT the defects they fix —
 * they legitimately contain the strings "forgot-password", "last_sign_in_at" and "23-48h" in prose
 * explaining what went wrong. Asserting against raw text would fail on the documentation.
 */
const codeOf = (path: string) =>
  readFileSync(path, 'utf8').split('\n')
    .filter(l => { const t = l.trimStart(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') })
    .join('\n')

/** SQL with `--` comments stripped. The migrations document the defects they fix, so they
 *  legitimately contain the old predicates in prose. */
const sqlCode = (path: string) =>
  readFileSync(path, 'utf8').split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

const base = (o: Partial<ReminderCandidate> = {}): ReminderCandidate => ({
  waitlistId: 'w1',
  reminderEnrollmentAt: ago(200),
  invitedAt: ago(200),
  waitlistStatus: 'invited',
  authUserCount: 1,
  profileExists: false,
  profileComplete: null,
  suppressed: false,
  stagesAlreadyClaimed: [],
  ...o,
})

describe('prospective enrollment is the whole safeguard for the 117', () => {
  it('an unenrolled (historical) invitation is never automatically eligible', () => {
    const r = evaluateReminder(base({ reminderEnrollmentAt: null }), NOW)
    expect(r).toEqual({ eligible: false, reason: 'not_enrolled' })
  })

  it('is checked FIRST, so no other property can make a historical row eligible', () => {
    // perfect in every other respect, still excluded
    const r = evaluateReminder(base({ reminderEnrollmentAt: null, invitedAt: ago(48) }), NOW)
    expect(r).toEqual({ eligible: false, reason: 'not_enrolled' })
  })

  it('an enrolled invitation past the first floor IS eligible', () => {
    expect(evaluateReminder(base({ invitedAt: ago(25) }), NOW)).toEqual({ eligible: true, stage: 'onboarding_reminder_1' })
  })

  it('the worker also filters at the QUERY level, not only in the predicate', () => {
    const w = readFileSync('lib/onboarding/reminderWorker.ts', 'utf8')
    expect(w).toMatch(/\.not\('reminder_enrollment_at', 'is', null\)/)
    expect(w).toMatch(/Two independent gates/)
  })

  it('enrollment is stamped only on a genuine first invite, never backfilled', () => {
    const route = readFileSync('app/api/admin/send-invite/route.ts', 'utf8')
    expect(route).toMatch(/reminder_enrollment_at: stampedAt/)
    const mig = readFileSync('supabase/migrations/077_onboarding_reminder_stages.sql', 'utf8')
    expect(mig).not.toMatch(/^\s*UPDATE public\.waitlist/m)
    expect(mig).toMatch(/There is NO BACKFILL, deliberately/)
  })
})

describe('stages are floors, so a missed run cannot strand anyone', () => {
  it('uses 24h / 3d / 7d', () => {
    expect(STAGE_FLOORS_HOURS).toEqual({
      onboarding_reminder_1: 24, onboarding_reminder_2: 72, onboarding_reminder_3: 168,
    })
  })

  it('before the first floor → too_early, not permanently excluded', () => {
    expect(evaluateReminder(base({ invitedAt: ago(23) }), NOW)).toEqual({ eligible: false, reason: 'too_early' })
  })

  it('MISSED-DAY RECOVERY: 10 days old with nothing sent still gets stage 1', () => {
    // the old 23-48h WINDOW made this person permanently unreachable
    expect(evaluateReminder(base({ invitedAt: ago(240) }), NOW)).toEqual({ eligible: true, stage: 'onboarding_reminder_1' })
  })

  it('advances one stage at a time as each is claimed', () => {
    const c = base({ invitedAt: ago(240) })
    expect(evaluateReminder({ ...c, stagesAlreadyClaimed: ['onboarding_reminder_1'] }, NOW))
      .toEqual({ eligible: true, stage: 'onboarding_reminder_2' })
    expect(evaluateReminder({ ...c, stagesAlreadyClaimed: ['onboarding_reminder_1', 'onboarding_reminder_2'] }, NOW))
      .toEqual({ eligible: true, stage: 'onboarding_reminder_3' })
  })

  it('stops after stage 3', () => {
    const c = base({ invitedAt: ago(500), stagesAlreadyClaimed: ['onboarding_reminder_1', 'onboarding_reminder_2', 'onboarding_reminder_3'] })
    expect(evaluateReminder(c, NOW)).toEqual({ eligible: false, reason: 'all_stages_sent' })
  })

  it('a claimed stage whose successor floor has not passed waits', () => {
    const c = base({ invitedAt: ago(30), stagesAlreadyClaimed: ['onboarding_reminder_1'] })
    expect(evaluateReminder(c, NOW)).toEqual({ eligible: false, reason: 'too_early' })
  })
})

describe('eligibility ends at COMPLETION, never at sign-in', () => {
  it('a completed profile terminates the sequence', () => {
    expect(evaluateReminder(base({ profileComplete: true }), NOW)).toEqual({ eligible: false, reason: 'completed' })
  })

  it('having signed in does NOT disqualify — this is the 18-person defect', () => {
    // last_sign_in_at is deliberately absent from the candidate shape entirely
    const c = base({ invitedAt: ago(240), profileExists: true, profileComplete: false })
    expect(evaluateReminder(c, NOW)).toEqual({ eligible: true, stage: 'onboarding_reminder_1' })
    expect(Object.keys(c)).not.toContain('lastSignInAt')
  })

  it('stops on revocation, decline, deactivation, ambiguity and suppression', () => {
    expect(evaluateReminder(base({ waitlistStatus: 'revoked' }), NOW)).toEqual({ eligible: false, reason: 'revoked_or_declined' })
    expect(evaluateReminder(base({ waitlistStatus: 'declined' }), NOW)).toEqual({ eligible: false, reason: 'revoked_or_declined' })
    expect(evaluateReminder(base({ accountStatus: 'deactivated' }), NOW)).toEqual({ eligible: false, reason: 'deactivated' })
    expect(evaluateReminder(base({ authUserCount: 2 }), NOW)).toEqual({ eligible: false, reason: 'ambiguous_identity' })
    expect(evaluateReminder(base({ authUserCount: 0 }), NOW)).toEqual({ eligible: false, reason: 'ambiguous_identity' })
    expect(evaluateReminder(base({ suppressed: true }), NOW)).toEqual({ eligible: false, reason: 'suppressed' })
  })

  it('excludes admin and test accounts unless explicitly allowlisted', () => {
    expect(evaluateReminder(base({ isAdmin: true }), NOW)).toEqual({ eligible: false, reason: 'admin_or_test' })
    expect(evaluateReminder(base({ isTestAccount: true }), NOW)).toEqual({ eligible: false, reason: 'admin_or_test' })
    expect(evaluateReminder(base({ isAdmin: true, allowlistedForTesting: true }), NOW).eligible).toBe(true)
  })

  it('does not nudge someone who was editing their profile in the last 24h', () => {
    expect(evaluateReminder(base({ profileUpdatedAt: ago(2) }), NOW)).toEqual({ eligible: false, reason: 'recent_activity' })
    expect(evaluateReminder(base({ profileUpdatedAt: ago(30) }), NOW).eligible).toBe(true)
  })
})

describe('the historical catch-up cohort requires a prior sign-in', () => {
  const hist = (o: Partial<ReminderCandidate> = {}) =>
    base({ reminderEnrollmentAt: null, lastSignInAt: ago(100), ...o })

  it('matches unenrolled, invited, incomplete, unambiguous people WHO SIGNED IN', () => {
    expect(classifyCatchup(hist())).toBe('ready')
    expect(isCatchupCandidate(hist())).toBe(true)
  })

  it('EXCLUDES someone who never signed in, with its own classification', () => {
    // This was the defect: with no lastSignInAt field at all, the predicate matched essentially the
    // whole historical population instead of the people who started and stalled.
    expect(classifyCatchup(hist({ lastSignInAt: null }))).toBe('never_signed_in')
    expect(classifyCatchup(hist({ lastSignInAt: undefined }))).toBe('never_signed_in')
    expect(isCatchupCandidate(hist({ lastSignInAt: null }))).toBe(false)
  })

  it('never matches someone the automatic worker owns', () => {
    expect(classifyCatchup(hist({ reminderEnrollmentAt: ago(1) }))).toBe('prospectively_enrolled')
  })

  it('excludes completed, non-invited, ambiguous, suppressed, admin and deactivated', () => {
    expect(classifyCatchup(hist({ profileComplete: true }))).toBe('completed')
    expect(classifyCatchup(hist({ waitlistStatus: 'revoked' }))).toBe('not_invited_status')
    expect(classifyCatchup(hist({ waitlistStatus: 'declined' }))).toBe('not_invited_status')
    expect(classifyCatchup(hist({ authUserCount: 2 }))).toBe('ambiguous_identity')
    expect(classifyCatchup(hist({ suppressed: true }))).toBe('suppressed')
    expect(classifyCatchup(hist({ isAdmin: true }))).toBe('admin_or_test')
    expect(classifyCatchup(hist({ accountStatus: 'deactivated' }))).toBe('deactivated')
  })

  it('PRODUCTION-PROPORTION FIXTURE: only the signed-in incomplete cohort is ready', () => {
    // Shaped from the corrected production audit — 117 historical incomplete invitees, of whom 18
    // signed in. No production identity appears; only the proportions do.
    const cohort: ReminderCandidate[] = [
      ...Array.from({ length: 18 }, (_, i) =>
        hist({ waitlistId: `signed-${i}`, lastSignInAt: ago(200) })),
      ...Array.from({ length: 99 }, (_, i) =>
        hist({ waitlistId: `never-${i}`, lastSignInAt: null })),
      ...Array.from({ length: 100 }, (_, i) =>
        hist({ waitlistId: `done-${i}`, lastSignInAt: ago(300), profileComplete: true })),
      ...Array.from({ length: 4 }, (_, i) =>
        hist({ waitlistId: `revoked-${i}`, waitlistStatus: 'revoked' })),
      ...Array.from({ length: 10 }, (_, i) =>
        hist({ waitlistId: `declined-${i}`, waitlistStatus: 'declined' })),
      hist({ waitlistId: 'suppressed-0', suppressed: true }),
    ]

    const tally = cohort.reduce<Record<string, number>>((acc, c) => {
      const k = classifyCatchup(c); acc[k] = (acc[k] ?? 0) + 1; return acc
    }, {})

    expect(tally.ready).toBe(18)                 // the approved cohort, exactly
    expect(tally.never_signed_in).toBe(99)       // the 117 minus the 18 — NOT contacted
    expect(tally.completed).toBe(100)
    expect(tally.not_invited_status).toBe(14)    // 4 revoked + 10 declined
    expect(tally.suppressed).toBe(1)
    expect(cohort.filter(isCatchupCandidate)).toHaveLength(18)
    // and the ready set is exactly the signed-in one
    expect(cohort.filter(isCatchupCandidate).every(c => c.waitlistId.startsWith('signed-'))).toBe(true)
  })

  it('a prior sign-in is NOT required for automatic reminders', () => {
    // The opposite rule, deliberately: disqualifying on sign-in is the original defect, and the
    // automatic sequence must still reach people invited prospectively who never came back.
    const c = base({ invitedAt: ago(25), lastSignInAt: null })
    expect(evaluateReminder(c, NOW)).toEqual({ eligible: true, stage: 'onboarding_reminder_1' })
    // evaluateReminder's BODY must not consult it. The field exists on the shared candidate
    // because classifyCatchup needs it — the point is that the automatic path never reads it.
    const code = codeOf('lib/onboarding/reminderEligibility.ts')
    const fn = code.slice(code.indexOf('export function evaluateReminder'), code.indexOf('export function classifyCatchup'))
    expect(fn).not.toMatch(/lastSignInAt/)
  })

  it('is defined without reference to any production identity', () => {
    const src = readFileSync('lib/onboarding/reminderEligibility.ts', 'utf8')
    expect(src).not.toMatch(/@[a-z0-9.-]+\.(com|io|app|net|org)/i)
    expect(src).not.toMatch(/\b(navid|april|alexander|arato)\b/i)
  })
})

describe('resume tokens are not credentials', () => {
  it('mints 32 random bytes and returns base64url', () => {
    const { token, tokenSha256 } = mintResumeToken()
    expect(Buffer.from(token, 'base64url').length).toBe(RESUME_TOKEN_BYTES)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(tokenSha256.length).toBe(32)
  })

  it('two mints never collide', () => {
    const s = new Set(Array.from({ length: 200 }, () => mintResumeToken().token))
    expect(s.size).toBe(200)
  })

  it('the stored value is the digest, and the digest does not contain the token', () => {
    const { token, tokenSha256 } = mintResumeToken()
    expect(tokenSha256.equals(sha256(token))).toBe(true)
    expect(tokenSha256.toString('hex')).not.toContain(token)
    expect(tokenSha256.toString('base64url')).not.toBe(token)
  })

  it('rejects malformed tokens before they reach the database', () => {
    expect(parseResumeToken(undefined)).toBeNull()
    expect(parseResumeToken('')).toBeNull()
    expect(parseResumeToken('short')).toBeNull()
    expect(parseResumeToken('a'.repeat(200))).toBeNull()
    expect(parseResumeToken('has spaces and +/=')).toBeNull()
    expect(parseResumeToken(mintResumeToken().token)).not.toBeNull()
  })

  it('puts the token in the FRAGMENT, never a query parameter', () => {
    const { token } = mintResumeToken()
    const link = buildResumeLink('https://www.andrel.app', token)
    expect(link).toMatch(/^https:\/\/www\.andrel\.app\/resume#token=/)
    expect(link.split('#')[0]).not.toContain(token)   // nothing before the fragment carries it
    expect(link).not.toContain('?')
  })

  it('never persists a plaintext token anywhere in the source', () => {
    for (const f of ['lib/onboarding/reminderWorker.ts', 'app/api/onboarding/resume/route.ts',
                     'app/api/admin/onboarding-catchup/route.ts']) {
      const src = readFileSync(f, 'utf8')
      // the only column ever written is the hash
      expect(src).not.toMatch(/token_plaintext|token:\s*token\b|resume_token:\s*token/)
      if (src.includes('invitation_resume_tokens')) expect(src).toMatch(/token_sha256/)
    }
  })
})

describe('the resume endpoint is not an account oracle', () => {
  const route = readFileSync('app/api/onboarding/resume/route.ts', 'utf8')

  it('has NO GET handler — a scanner cannot cause a send', () => {
    expect(route).not.toMatch(/export async function GET/)
    expect(route).toMatch(/POST ONLY, DELIBERATELY/)
  })

  it('returns one identical body for success and every failure', () => {
    const generic = (route.match(/return generic\(\)/g) ?? []).length
    expect(generic).toBeGreaterThanOrEqual(5)
    expect(route).toMatch(/if \(status !== 'ok' \|\| !row\?\.out_waitlist_id\) return generic\(\)/)
  })

  it('never returns an auth/recovery URL to the browser', () => {
    expect(route).not.toMatch(/hashedToken|hashed_token|recoveryUrl|action_link/)
    expect(route).toMatch(/never returns a Supabase authentication or recovery URL/)
  })

  it('resolves the recipient from the invitation, not from the request', () => {
    // The route now passes only the claim's server-derived ids to the sender, which re-resolves the
    // address itself. The only read here is the rollout gate, and that address is not forwarded.
    expect(route).toMatch(/sendResumeAccessEmail\(admin, \{\s*\n?\s*waitlistId: row\.out_waitlist_id, authUserId: row\.out_auth_user_id,/)
    expect(route).toMatch(/The recipient is NEVER taken from the request/)
    expect(route).toMatch(/is read server-side purely for this check and is not passed to the sender/)
  })

  it('logs no token, address or raw error', () => {
    // Array.from: the project's tsconfig target predates iterating a matchAll result directly.
    for (const m of Array.from(route.matchAll(/console\.(error|log)\(([\s\S]*?)\)\n/g))) {
      expect(m[2]).not.toMatch(/token|email|\.message/)
    }
  })

  it('re-checks eligibility inside the atomic claim, closing the TOCTOU window', () => {
    expect(route).toMatch(/claim_invitation_resume_request/)
    expect(route).toMatch(/closes the TOCTOU window/)
  })
})

describe('the resume page causes no side effects on load', () => {
  const page = readFileSync('app/resume/page.tsx', 'utf8')

  it('captures from the fragment and scrubs history immediately', () => {
    expect(page).toMatch(/window\.location\.hash/)
    expect(page).toMatch(/safeReplaceState\(window\.location\.pathname, 'resume'\)/)
  })

  it('sends nothing until a deliberate button press', () => {
    expect(page).toMatch(/NOTHING HAPPENS ON LOAD/)
    expect(page).toMatch(/onClick=\{handleContinue\}/)
    expect(page).toMatch(/Continue setting up/)
    // no fetch outside the click handler
    const beforeHandler = page.slice(0, page.indexOf('async function handleContinue'))
    expect(beforeHandler).not.toMatch(/fetch\(/)
  })

  it('never renders the token into the DOM', () => {
    expect(page).toMatch(/tokenRef/)
    expect(page).not.toMatch(/\{token\}|\{tokenRef\.current\}/)
  })

  it('guards re-entrancy and degrades in in-app browsers', () => {
    expect(page).toMatch(/if \(phase === 'sending'\) return/)
    expect(page).toMatch(/open it in Safari or Chrome/)
  })
})

describe('email copy', () => {
  const email = readFileSync('lib/email.ts', 'utf8') + readFileSync('lib/email/secureInvite.ts', 'utf8')

  it('uses the approved subjects', () => {
    expect(email).toMatch(/onboarding_reminder_1: 'Finish setting up your Andrel profile'/)
    expect(email).toMatch(/onboarding_reminder_2: 'Your Andrel profile is still unfinished'/)
    expect(email).toMatch(/onboarding_reminder_3: 'Last reminder: complete your Andrel profile'/)
  })

  it('never says reset-your-password and never links to /auth/forgot-password', () => {
    const code = codeOf('lib/email.ts')
    const fn = code.slice(code.indexOf('export async function sendOnboardingReminder'))
    const body = fn.slice(0, fn.indexOf('\nexport '))
    expect(body).not.toMatch(/reset your password/i)
    expect(body).not.toMatch(/forgot-password/)
    // "you don't need to remember a password" is fine — it tells them there ISN'T one to reset
    expect(body).toMatch(/don&rsquo;t need to remember a password/)
  })

  it('the deprecated reminders that linked there are gone entirely', () => {
    expect(email).not.toMatch(/export async function sendInviteReminder[12]/)
  })

  it('explains the mechanism and never promises the old link still works', () => {
    expect(email).toMatch(/lets us email you a fresh, secure sign-in link/)
    expect(email).toMatch(/Nothing is sent until you\s*\n?\s*press it/)
    expect(email).toMatch(/you can simply ignore this email/)
    expect(email).not.toMatch(/your (original|previous) link|still valid/i)
  })

  it('promises no acceptance, matches or introductions', () => {
    const fn = email.slice(email.indexOf('const REMINDER_LEAD'), email.indexOf('export async function sendOnboardingReminder'))
    expect(fn).not.toMatch(/accept|match|introduc/i)
  })
})

describe('canonical origin', () => {
  it('is https://www.andrel.app, defined once', () => {
    const cfg = readFileSync('lib/config/siteUrl.ts', 'utf8')
    expect(cfg).toMatch(/export const CANONICAL_SITE_URL = 'https:\/\/www\.andrel\.app'/)
    expect(cfg).toMatch(/return raw \|\| CANONICAL_SITE_URL/)
  })

  it('is not hardcoded in the new code paths', () => {
    for (const f of ['lib/onboarding/reminderWorker.ts', 'app/api/onboarding/resume/route.ts',
                     'app/api/admin/onboarding-catchup/route.ts', 'lib/invitations/resumeToken.ts']) {
      const src = readFileSync(f, 'utf8')
      const code = src.split('\n').filter(l => !l.trimStart().startsWith(('*')) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('/*')).join('\n')
      expect(code).not.toMatch(/https:\/\/(www\.)?andrel\.app/)
    }
  })
})

describe('the five root-cause fixes', () => {
  it('1. no reminder links to /auth/forgot-password', () => {
    const email = readFileSync('lib/email.ts', 'utf8') + readFileSync('lib/email/secureInvite.ts', 'utf8')
    const code = email.split('\n').filter(l => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//')).join('\n')
    expect(code).not.toMatch(/auth\/forgot-password/)
  })

  it('2. eligibility ends at completion, not first sign-in', () => {
    // Scoped to evaluateReminder's BODY. lastSignInAt legitimately exists on the shared candidate
    // because classifyCatchup requires it; the property being asserted is that the AUTOMATIC path
    // never reads it.
    const code = codeOf('lib/onboarding/reminderEligibility.ts')
    const fn = code.slice(code.indexOf('export function evaluateReminder'), code.indexOf('export function classifyCatchup'))
    expect(fn.length).toBeGreaterThan(200)
    expect(fn).not.toMatch(/last_sign_in_at|lastSignInAt/)
    expect(fn).toMatch(/reason: 'completed'/)
    expect(readFileSync('lib/onboarding/reminderEligibility.ts', 'utf8'))
      .toMatch(/Eligibility now ends at COMPLETION, never at sign-in/)
  })

  it('3. floors replace the 23-48h window', () => {
    expect(readFileSync('lib/onboarding/reminderEligibility.ts', 'utf8')).toMatch(/Stages are now FLOORS/)
    // no window arithmetic survives in the executable code
    const code = codeOf('lib/onboarding/reminderEligibility.ts')
    expect(code).not.toMatch(/cutoff48h|48 \* 60|23 \* 60/)
    expect(code).toMatch(/onboarding_reminder_1: 24,/)
  })

  it('4. middleware fails closed on an RPC error', () => {
    const mw = readFileSync('middleware.ts', 'utf8')
    expect(mw).toMatch(/const \{ data: myRows, error: profileError \} = await supabase\.rpc\('get_my_profile'\)/)
    expect(mw).toMatch(/if \(profileError\) \{/)
    expect(mw).toMatch(/return response/)
    // the error branch must come BEFORE the redirect decision
    expect(mw.indexOf('if (profileError)')).toBeLessThan(mw.indexOf('dashboardRedirect('))
  })

  it('5. onboarding-step cannot report success on zero rows', () => {
    const src = readFileSync('app/api/profile/onboarding-step/route.ts', 'utf8')
    expect(src).toMatch(/\.select\('id'\)/)
    expect(src).toMatch(/if \(!data \|\| data\.length === 0\)/)
    expect(src).toMatch(/status: 409/)
    expect(src).toMatch(/\.select\(\) IS LOAD-BEARING/)
    // and it no longer returns the raw database message
    expect(src).not.toMatch(/error: error\.message/)
  })
})

describe('the admin catch-up campaign cannot fire by accident', () => {
  const route = readFileSync('app/api/admin/onboarding-catchup/route.ts', 'utf8')

  it('uses a FIXED, documented campaign key defined outside the route module', () => {
    // A Next.js route module may only export handlers, so the constant lives in its own file.
    const key = readFileSync('lib/onboarding/catchupCampaign.ts', 'utf8')
    expect(key).toMatch(/export const CATCHUP_CAMPAIGN_KEY = 'onboarding-catchup-2026-08'/)
    expect(key).toMatch(/FIXED AND DOCUMENTED, never generated/)
    expect(key).toMatch(/idempotent by definition/)
    expect(route).toMatch(/import \{ CATCHUP_CAMPAIGN_KEY \} from '@\/lib\/onboarding\/catchupCampaign'/)
    expect(route).not.toMatch(/Date\.now\(\).*campaign|randomUUID\(\).*campaign/)
  })

  it('defaults to a dry run', () => {
    expect(route).toMatch(/const dryRun = body\.dryRun !== false/)
  })

  it('requires BOTH dryRun:false and confirmFullCampaign:true for a full send', () => {
    expect(route).toMatch(/if \(!dryRun && !testRecipient && !confirmed\)/)
    expect(route).toMatch(/confirmation_required/)
  })

  it('requires an authenticated admin verified server-side', () => {
    expect(route).toMatch(/const \{ data: \{ user \} \} = await supa\.auth\.getUser\(\)/)
    expect(route).toMatch(/if \(me\?\.is_admin !== true\) return NextResponse\.json\(\{ error: 'Forbidden' \}/)
  })

  it('targets ONLY the unenrolled historical cohort', () => {
    expect(route).toMatch(/\.is\('reminder_enrollment_at', null\)/)
    expect(route).toMatch(/historical cohort ONLY, by construction/)
  })

  it('reclassifies immediately before sending (TOCTOU)', () => {
    expect(route).toMatch(/const recheck = await classify\(admin, w, email\)/)
    expect(route).toMatch(/if \(recheck\.cls !== 'ready' \|\| !recheck\.authUserId\) \{ counts\[recheck\.cls\]\+\+; continue \}/)
    expect(route.indexOf('const recheck')).toBeLessThan(route.indexOf('const ok = await sendOne'))
  })

  it('emits only masked recipients and no raw identifier in logs', () => {
    expect(route).toMatch(/const mask = /)
    expect(route).toMatch(/recipients,\s*\/\/ masked addresses only/)
    const log = route.slice(route.indexOf('console.log(JSON.stringify({'), route.indexOf('return NextResponse.json({\n    ok: true'))
    expect(log).not.toMatch(/email|recipients:|waitlist_id/)
  })

  it('is bounded and deadline-aware', () => {
    expect(route).toMatch(/const MAX_BATCH = 25/)
    expect(route).toMatch(/Date\.now\(\) > deadline \|\| sent >= MAX_BATCH/)
  })

  it('classifies every required outcome', () => {
    for (const c of ['ready', 'completed', 'revoked_or_declined', 'suppressed', 'ambiguous',
                     'no_longer_incomplete', 'already_sent', 'excluded', 'not_selected']) {
      expect(route).toContain(`'${c}'`)
    }
  })

  it('is not scheduled anywhere', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'))
    expect((vercel.crons as { path: string }[]).some(c => c.path.includes('catchup'))).toBe(false)
  })
})

describe('the daily maintenance run hosts the worker, with no new cron', () => {
  it('adds no Vercel cron entry', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'))
    const paths = (vercel.crons as { path: string }[]).map(c => c.path)
    expect(paths).not.toContain('/api/cron/onboarding-reminders')
    expect(paths).toContain('/api/cron/engagement-reminders')
  })

  it('runs once, last, on its own budget', () => {
    const cron = readFileSync('app/api/cron/engagement-reminders/route.ts', 'utf8')
    expect((cron.match(/await runOnboardingReminderStage\(/g) ?? []).length).toBe(1)
    expect(cron).toMatch(/budgetMs: REMINDER_STAGE_BUDGET_MS/)
    expect(cron).toMatch(/try \{[\s\S]*?\} catch \{[\s\S]*?onboarding_reminder_stage_failed/)
    expect(cron).toMatch(/if \(auth !== `Bearer \$\{process\.env\.CRON_SECRET\}`\) \{/)
  })

  it('the old activation-reminders cron can no longer send anything', () => {
    const old = readFileSync('app/api/cron/activation-reminders/route.ts', 'utf8')
    expect(old).toMatch(/SUPERSEDED/)
    expect(old).not.toMatch(/sendInviteReminder|resend\.emails\.send/)
    expect(old).toMatch(/sent: 0/)
  })
})

describe('blocker corrections — source invariants', () => {
  const worker = readFileSync('lib/onboarding/reminderWorker.ts', 'utf8')
  const catchup = readFileSync('app/api/admin/onboarding-catchup/route.ts', 'utf8')
  const m077 = readFileSync('supabase/migrations/077_onboarding_reminder_stages.sql', 'utf8')
  const m078 = readFileSync('supabase/migrations/078_invitation_resume_tokens.sql', 'utf8')
  const m079 = readFileSync('supabase/migrations/079_discovery_requires_complete_profile.sql', 'utf8')

  it('B2: every token insert binds auth_user_id', () => {
    for (const src of [worker, catchup]) {
      const inserts = Array.from(src.matchAll(/from\('invitation_resume_tokens'\)\s*\n?\s*\.insert\(\{([\s\S]*?)\}\)/g))
      expect(inserts.length).toBeGreaterThan(0)
      for (const m of inserts) expect(m[1]).toMatch(/auth_user_id/)
    }
    expect(m078).toMatch(/auth_user_id\s+uuid NOT NULL/)
  })

  it('B2: the claim binds identity and requires exactly "invited"', () => {
    expect(m078).toMatch(/IF v_authid <> t\.auth_user_id THEN/)
    expect(m078).toMatch(/'identity_changed'/)
    expect(m078).toMatch(/IF v_wstatus <> 'invited' THEN/)
    expect(m078).toMatch(/WHERE p\.id = v_authid/)
    // the old, always-NULL predicate survives only in the comment explaining it
    expect(sqlCode('supabase/migrations/078_invitation_resume_tokens.sql'))
      .not.toMatch(/WHERE p\.id = t\.auth_user_id/)
  })

  it('B3: no one-live-token constraint, and nothing supersedes on issuance', () => {
    expect(m078).not.toMatch(/invitation_resume_tokens_live_uniq/)
    expect(worker).not.toMatch(/superseded_at/)          // only admin rotation supersedes
    expect(catchup).not.toMatch(/superseded_at/)
    expect(worker).toMatch(/EARLIER TOKENS ARE LEFT LIVE/)
  })

  it('B4: the global bucket is incremented AFTER every eligibility and per-token check', () => {
    const fn = m078.slice(m078.indexOf('CREATE OR REPLACE FUNCTION public.claim_invitation_resume_request'))
    const globalAt = fn.indexOf('INSERT INTO public.invitation_resume_rate')
    for (const earlier of ['FOR UPDATE', "IF v_wstatus <> 'invited'", 'v_authid <> t.auth_user_id',
                           "'completed'", "'suppressed'", 'v_allowed := ']) {
      expect(fn.indexOf(earlier)).toBeLessThan(globalAt)
    }
    // and the per-token consumption happens only after the global check
    expect(globalAt).toBeLessThan(fn.indexOf('SET window_started_at = pg_catalog.now(), window_count = 1'))
    expect(fn).toMatch(/per-token allowance is deliberately NOT consumed/)
  })

  it('B5: only "failed" is retryable, in both the index and the queries', () => {
    expect(m077).toMatch(/AND status <> 'failed'/)
    expect(worker).toMatch(/\.neq\('status', 'failed'\)/)
    expect(catchup).toMatch(/\.neq\('status', 'failed'\)/)
    expect(worker).toMatch(/if \(send\.uncertain\) return 'sent'/)   // uncertain stays consumed
  })

  it('B6: the resolver replaces the paged fallback everywhere', () => {
    expect(m078).toMatch(/FUNCTION public\.lookup_auth_identity\(p_email text\)/)
    for (const src of [worker, catchup, readFileSync('app/api/profile/initialize/route.ts', 'utf8')]) {
      expect(src).toMatch(/rpc\('lookup_auth_identity'/)
    }
    // the paged fallback is gone from the CODE; it survives only in comments explaining why
    for (const f of ['lib/onboarding/reminderWorker.ts', 'app/api/admin/onboarding-catchup/route.ts',
                     'app/api/profile/initialize/route.ts']) {
      expect(codeOf(f)).not.toMatch(/listUsers\(/)
    }
  })

  it('B6: every lookup failure fails closed rather than assuming zero', () => {
    expect(worker).toMatch(/if \(idErr\) return null/)
    expect(worker).toMatch(/if \(pErr\) return null/)
    expect(worker).toMatch(/if \(cErr\) return null/)
    expect(worker).toMatch(/skipped\['lookup_unavailable'\]/)
    expect(catchup).toMatch(/return no\('lookup_unavailable'\)/)
  })

  it('logs carry a correlation id, never a member identifier', () => {
    const route = readFileSync('app/api/onboarding/resume/route.ts', 'utf8')
    for (const m of Array.from(route.matchAll(/console\.(error|log)\(JSON\.stringify\(\{([^}]*)\}/g))) {
      expect(m[2]).not.toMatch(/waitlist_id|email|token|user_id/)
      expect(m[2]).toMatch(/cid/)
    }
  })

  it('canonical origin appears nowhere as the apex', () => {
    const cfg = readFileSync('lib/config/siteUrl.ts', 'utf8')
    expect(cfg).not.toMatch(/https:\/\/andrel\.app/)
    expect(cfg).toMatch(/NEXT_PUBLIC_SITE_URL=https:\/\/www\.andrel\.app in production/)
  })

  it('suppression semantics are documented as ANY, and implemented as ANY', () => {
    expect(m078).toMatch(/Deliberately ANY historical bounce\/block\/complaint, not merely the latest/)
    const code = sqlCode('supabase/migrations/078_invitation_resume_tokens.sql')
    const q = code.slice(code.indexOf('SELECT pg_catalog.count(*) INTO v_supp'))
    expect(q.slice(0, 400)).toMatch(/d\.status IN \('bounced', 'blocked', 'complained'\)/)
    // ANY, not latest: no ordering, no single-row narrowing
    expect(q.slice(0, 400)).not.toMatch(/ORDER BY|LIMIT/)
  })

  it('079 keeps the self branch and adds completeness to the relationship branch only', () => {
    expect(m079).toMatch(/auth\.uid\(\) = member_id\s*\n\s*OR \(/)
    expect(m079).toMatch(/tgt\.profile_complete IS TRUE/)
    expect(m079).toMatch(/tgt\.is_test_account IS NOT TRUE/)
    expect(m079).toMatch(/account_status is NOT folded in/)
  })
})

describe('profile initialization preserves progress safely', () => {
  const init = readFileSync('app/api/profile/initialize/route.ts', 'utf8')
  const step = readFileSync('app/api/profile/onboarding-step/route.ts', 'utf8')

  it('binds exclusively to the verified session and accepts nothing from the client', () => {
    expect(init).toMatch(/const \{ data: \{ user \} \} = await supa\.auth\.getUser\(\)/)
    expect(init).toMatch(/id: user\.id/)
    expect(init).not.toMatch(/await req\.json\(\)/)
  })

  it('requires exactly one INVITED waitlist identity, via the shared resolver', () => {
    expect(init).toMatch(/rpc\('lookup_waitlist_identity'/)
    expect(init).toMatch(/if \(\(wl\.invited_count \?\? 0\) !== 1 \|\| !wl\.invited_id\) return denied\(\)/)
  })

  it('sets profile_complete false explicitly and leaves location NULL (migration 061)', () => {
    expect(init).toMatch(/profile_complete: false,\s+\/\/ EXPLICIT/)
    expect(codeOf('app/api/profile/initialize/route.ts')).not.toMatch(/location:/)
    expect(init).toMatch(/061 permits it while profile_complete is not true/)
  })

  it('uses the service-role boundary, never a browser profile write', () => {
    expect(init).toMatch(/admin\.from\('profiles'\)\.insert\(/)
    expect(init).toMatch(/migration 055 revoked INSERT and/)
  })

  it('is idempotent and concurrency-safe', () => {
    expect(init).toMatch(/if \(existing\) \{/)
    expect(init).toMatch(/=== '23505'/)
    expect(init).toMatch(/a concurrent request won the race/)
  })

  it('fails closed on every read or write error', () => {
    expect((init.match(/unavailable\(\)/g) ?? []).length).toBeGreaterThanOrEqual(6)
    expect(init).toMatch(/const unavailable = \(\) => NextResponse\.json\(\{ error: 'unavailable' \}, \{ status: 503 \}\)/)
    expect(init).toMatch(/if \(exErr\) return unavailable\(\)/)
    expect(init).toMatch(/if \(wlErr\) return unavailable\(\)/)
    expect(init).toMatch(/if \(idErr\) return unavailable\(\)/)
  })

  it('onboarding-step updates exactly one row or fails closed', () => {
    expect(step).toMatch(/if \(data && data\.length > 1\)/)
    expect(step).toMatch(/if \(!data \|\| data\.length === 0\)/)
    expect(step).toMatch(/initialize: '\/api\/profile\/initialize'/)
  })
})

describe('the FIRST invitation carries a durable fallback', () => {
  const orch = readFileSync('lib/invitations/secureInvite.ts', 'utf8')
  const route = readFileSync('app/api/admin/send-invite/route.ts', 'utf8')
  const email = readFileSync('lib/email.ts', 'utf8') + readFileSync('lib/email/secureInvite.ts', 'utf8')
  const store = readFileSync('lib/invitations/resumeTokenStore.ts', 'utf8')

  it('mints a resume token inside the invitation ceremony, bound to the resolved identity', () => {
    expect(orch).toMatch(/mintResumeLink\?: \(authUserId: string\)/)
    expect(orch).toMatch(/resume = await deps\.mintResumeLink\(resolvedUserId\)/)
    // minted AFTER generateLink (so an identity exists) and BEFORE the send (so it can be included)
    expect(orch.indexOf('deps.generateLink(type, email)')).toBeLessThan(orch.indexOf('deps.mintResumeLink('))
    expect(orch.indexOf('deps.mintResumeLink(')).toBeLessThan(orch.indexOf('const send = await deps.sendEmail'))
  })

  it('the initial-invite route supplies it', () => {
    expect(route).toMatch(/mintResumeLink: \(authUserId\) =>\s*\n?\s*mintBoundResumeLink\(admin, \{ waitlistId: entryId, authUserId, siteUrl: getSiteUrl\(\) \}\)/)
    expect(route).toMatch(/resumeLink: a\.resumeLink \?\? null/)
  })

  it('stores only a digest, with a bound auth_user_id and no address', () => {
    expect(store).toMatch(/auth_user_id: args\.authUserId/)
    expect(store).toMatch(/token_sha256: `\\\\x\$\{tokenSha256\.toString\('hex'\)\}`/)
    expect(store).not.toMatch(/email/i)
    expect(codeOf('lib/invitations/resumeTokenStore.ts')).not.toMatch(/token,\s*$/m)  // plaintext never inserted
  })

  it('the email carries a secondary recovery link on the canonical origin', () => {
    expect(email).toMatch(/<a href="\$\{resume\}"[^>]*>\s*send me a working link/)
    expect(email).toMatch(/that one doesn't expire/)
    // and degrades to the previous copy when no token could be minted
    expect(email).toMatch(/\$\{resume \? `/)
  })

  it('distinguishes the two kinds of link in its own documentation', () => {
    expect(email).toMatch(/`link` is a Supabase AUTHENTICATION link/)
    expect(email).toMatch(/`resumeLink` authenticates nobody/)
  })

  it('a DEFINITE send failure revokes the orphan token; an UNCERTAIN one keeps it', () => {
    const fail = orch.slice(orch.indexOf('// DEFINITE failure:'))
    expect(fail).toMatch(/deps\.revokeResumeToken\(resume\.tokenId\)/)
    const unc = orch.slice(orch.indexOf('if (send.uncertain) {'), orch.indexOf('// DEFINITE failure:'))
    expect(unc).not.toMatch(/revokeResumeToken/)
    expect(unc).toMatch(/the resume token stays LIVE/)
  })

  it('never reuses one idempotency key with a different token payload', () => {
    expect(orch).toMatch(/const idempotencyKey = `invite:\$\{claim\.deliveryId\}`/)
    expect(orch).toMatch(/this claim minted THIS token/)
    // the key is derived after the token is minted, from the same claim
    expect(orch.indexOf('deps.mintResumeLink(')).toBeLessThan(orch.indexOf('const idempotencyKey'))
  })

  it('enrollment is still stamped only on provider acceptance', () => {
    const accepted = route.slice(route.indexOf('// Provider ACCEPTED'))
    expect(accepted).toMatch(/reminder_enrollment_at: stampedAt/)
  })

  it('an access-resend ADDS a token and never rotates', () => {
    const fw = readFileSync('lib/invitations/sendForWaitlist.ts', 'utf8')
    expect(fw).toMatch(/ADD a durable fallback; never rotate/)
    expect(fw).not.toMatch(/superseded_at|finalize_resume_rotation/)
  })
})

describe('initializer authorization ordering', () => {
  const init = readFileSync('app/api/profile/initialize/route.ts', 'utf8')
  const code = codeOf('app/api/profile/initialize/route.ts')

  it('checks identity and invitation BEFORE looking at the profile', () => {
    const idAt = code.indexOf("rpc('lookup_auth_identity'")
    const wlAt = code.indexOf("rpc('lookup_waitlist_identity'")
    const profAt = code.indexOf(".from('profiles').select('id, profile_complete')")
    expect(idAt).toBeGreaterThan(-1)
    expect(idAt).toBeLessThan(wlAt)
    expect(wlAt).toBeLessThan(profAt)          // the ordering defect, pinned
  })

  it('requires the resolved uuid to be the session uuid', () => {
    expect(code).toMatch(/if \(id\.auth_user_id !== user\.id\) return denied\(\)/)
  })

  it('requires exactly one invited row and refuses conflicts', () => {
    expect(code).toMatch(/if \(\(wl\.invited_count \?\? 0\) !== 1 \|\| !wl\.invited_id\) return denied\(\)/)
    expect(code).toMatch(/if \(wl\.has_revoked \|\| wl\.has_declined \|\| wl\.has_other_status\) return denied\(\)/)
    expect(code).toMatch(/if \(\(wl\.total_rows \?\? 0\) !== 1\) return denied\(\)/)
  })

  it('uses the shared normalized contract, never ILIKE', () => {
    expect(code).not.toMatch(/ilike/i)
    expect(init).toMatch(/`%` and `_` are wildcards/)
  })

  it('an incomplete profile no longer bypasses invitation state', () => {
    // the early-return on `existing` now sits AFTER every denial
    expect(code.indexOf('if (existing)')).toBeGreaterThan(code.lastIndexOf('return denied()'))
    expect(init).toMatch(/Existence\s*\n \* of a row is not authorization/)
  })

  it('fails closed on every transient lookup failure', () => {
    expect(code).toMatch(/if \(idErr\) return unavailable\(\)/)
    expect(code).toMatch(/if \(wlErr\) return unavailable\(\)/)
    expect(code).toMatch(/if \(exErr\) return unavailable\(\)/)
    expect(code).toMatch(/if \(!id\) return unavailable\(\)/)
    expect(code).toMatch(/if \(!wl\) return unavailable\(\)/)
  })

  it('is concurrency-safe and makes no authenticated base-profile write', () => {
    expect(code).toMatch(/=== '23505'/)
    expect(code).toMatch(/admin\.from\('profiles'\)\.insert\(/)
    expect(code).not.toMatch(/supa\.from\('profiles'\)/)
  })
})

describe('admin rotation is implemented, narrow, resumable and never implicit', () => {
  const rot = readFileSync('app/api/admin/invitations/rotate-resume/route.ts', 'utf8')
  const m078 = readFileSync('supabase/migrations/078_invitation_resume_tokens.sql', 'utf8')
  const m077 = readFileSync('supabase/migrations/077_onboarding_reminder_stages.sql', 'utf8')

  it('is POST-only, admin-verified and explicitly confirmed', () => {
    expect(rot).not.toMatch(/export async function GET/)
    expect(rot).toMatch(/if \(me\?\.is_admin !== true\) return NextResponse\.json\(\{ error: 'Forbidden' \}/)
    expect(rot).toMatch(/if \(body\.confirmRotate !== true\)/)
  })

  it('C: has its OWN delivery purpose, not access_resend', () => {
    expect(rot).toMatch(/const ROTATION_PURPOSE = 'resume_rotation'/)
    expect(rot).not.toMatch(/ROTATION_PURPOSE = 'access_resend'/)
    expect(m077).toMatch(/'resume_rotation'/)
    expect(m077).toMatch(/'resume_access'/)
  })

  it('C: rotation and resume rows stay out of the one-per-purpose lock', () => {
    expect(m077).toMatch(/WHY resume_access AND resume_rotation ROWS CARRY waitlist_id = NULL/)
    expect(rot).toMatch(/waitlist_id: null/)
    // The resume-access insert now lives INSIDE claim_resume_access_attempt(), so the sender
    // contains no insert at all — the NULL waitlist_id is set by the database function.
    expect(m078).toMatch(/VALUES \(NULL, p_auth_user_id, v_norm, 'resume_access', 'claimed', 'pending', 1\)/)
    expect(readFileSync('lib/invitations/sendResumeAccess.ts', 'utf8'))
      .toMatch(/rpc\('claim_resume_access_attempt'/)
  })

  it('D: prepare → send → finalize, with acceptance recorded before finalization', () => {
    const prep = rot.indexOf("rpc('begin_resume_rotation'")
    const send = rot.indexOf('const send = await sendSecureInviteEmail')
    const acc = rot.indexOf("p_state: 'accepted_pending_finalize'")
    // lastIndexOf: the resume path calls finalize() earlier in the file, and that call is exactly
    // the one that must NOT be preceded by a send.
    const fin = rot.lastIndexOf('const fin = await finalize(admin, op.out_operation_id, cid)')
    expect(prep).toBeLessThan(send)
    expect(send).toBeLessThan(acc)
    expect(acc).toBeLessThan(fin)
  })

  it('D: an accepted-but-unfinalized operation resumes WITHOUT sending again', () => {
    const resume = rot.slice(rot.indexOf("if (!op.out_created && op.out_state === 'accepted_pending_finalize')"))
    expect(resume.slice(0, 400)).toMatch(/await finalize\(admin, op\.out_operation_id, cid\)/)
    expect(resume.slice(0, 400)).not.toMatch(/sendSecureInviteEmail|generateLink/)
    expect(m078).toMatch(/completed by calling this again, with no second email/)
  })

  it('D: the operation durably records everything a retry needs', () => {
    for (const col of ['waitlist_id', 'auth_user_id', 'replacement_token_id', 'delivery_id', 'event_key', 'state']) {
      expect(m078).toMatch(new RegExp(`\\n  ${col}\\s`))
    }
    expect(m078).toMatch(/CREATE TABLE IF NOT EXISTS public\.invitation_rotation_operations/)
    expect(m078).toMatch(/invitation_rotation_operations_active_uniq/)
  })

  it('D: the operation table is service-role only with zero browser policies', () => {
    expect(m078).toMatch(/ALTER TABLE public\.invitation_rotation_operations ENABLE ROW LEVEL SECURITY/)
    expect(m078).toMatch(/REVOKE ALL ON public\.invitation_rotation_operations FROM service_role;/)
    expect(m078).toMatch(/GRANT SELECT, INSERT, UPDATE ON public\.invitation_rotation_operations TO service_role;/)
    expect(m078).not.toMatch(/CREATE POLICY[^;]*invitation_rotation_operations/)
  })

  it('a definite failure revokes only the replacement; uncertain changes nothing', () => {
    const fail = rot.slice(rot.indexOf('if (!send.success)'))
    expect(fail).toMatch(/revokeResumeToken\(admin, op\.out_replacement_token_id\)/)
    expect(fail).toMatch(/p_state: 'failed'/)
    const unc = rot.slice(rot.indexOf('if (send.uncertain)'), rot.indexOf('if (!send.success)'))
    expect(unc).not.toMatch(/revokeResumeToken|finalize_resume_rotation/)
    expect(unc).toMatch(/Change NOTHING/)
  })

  it('reuses the operation\'s STABLE event key as the idempotency key', () => {
    expect(rot).toMatch(/idempotencyKey: op\.out_event_key/)
  })

  it('E: no identifier appears in any rotation log', () => {
    for (const m of Array.from(rot.matchAll(/console\.(error|log)\(JSON\.stringify\(\{([^}]*)\}/g))) {
      expect(m[2]).not.toMatch(/email|token|auth_user_id|waitlist_id|delivery_id|deliveryId|operation_id|link/)
      expect(m[2]).toMatch(/cid/)
    }
  })

  it('rotation is reachable ONLY here', () => {
    // The ROTATION-OPERATION machinery stays exclusive to the admin route, sendResumeAccess
    // included: routing member-triggered requests through begin_resume_rotation would converge them
    // onto an admin's in-flight operation whose replacement plaintext they never held. Migration 094
    // gives the resume path its own retirement function instead, so this guard keeps full strength.
    for (const f of ['lib/onboarding/reminderWorker.ts', 'app/api/admin/onboarding-catchup/route.ts',
                     'app/api/onboarding/resume/route.ts', 'lib/invitations/sendForWaitlist.ts',
                     'lib/invitations/sendResumeAccess.ts']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/finalize_resume_rotation|begin_resume_rotation|superseded_at/)
    }
    // TOKEN RETIREMENT of any kind remains forbidden on the paths that only ADD tokens — reminders,
    // the catch-up route and first invites still accumulate nothing to retire (migration 078). Only
    // the resume-access resend, which replaces the fallback it just invalidated, may retire.
    for (const f of ['lib/onboarding/reminderWorker.ts', 'app/api/admin/onboarding-catchup/route.ts',
                     'app/api/onboarding/resume/route.ts', 'lib/invitations/sendForWaitlist.ts']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/supersede_other_resume_tokens/)
    }
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'))
    expect((vercel.crons as { path: string }[]).some(c => c.path.includes('rotate'))).toBe(false)
  })
})

describe('B: the durable fallback fails closed', () => {
  const orch = readFileSync('lib/invitations/secureInvite.ts', 'utf8')

  it('a token that cannot be persisted stops the send BEFORE the provider call', () => {
    const at = orch.indexOf('if (!resume) {')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(orch.indexOf('const send = await deps.sendEmail'))
    expect(orch.slice(at, at + 500)).toMatch(/markFailed\(claim\.deliveryId, 'resume_token_unavailable'\)/)
    expect(orch.slice(at, at + 500)).toMatch(/state: 'error', sent: false/)
  })

  it('an unresolved identity also fails closed', () => {
    expect(orch).toMatch(/markFailed\(claim\.deliveryId, 'resume_identity_unresolved'\)/)
  })

  it('says plainly why the previous "send anyway" reasoning was wrong', () => {
    expect(orch).toMatch(/was wrong once the durable fallback became the approved product/)
    expect(orch).toMatch(/leaves invited_at and\n   \* reminder_enrollment_at unstamped/)
  })

  it('invited_at and enrollment are stamped only after acceptance', () => {
    const route = readFileSync('app/api/admin/send-invite/route.ts', 'utf8')
    const accepted = route.slice(route.indexOf('// Provider ACCEPTED'))
    expect(accepted).toMatch(/invited_at: stampedAt, reminder_enrollment_at: stampedAt/)
    // and the fail-closed return happens before any send, so neither can be reached
    expect(orch.indexOf("markFailed(claim.deliveryId, 'resume_token_unavailable')"))
      .toBeLessThan(orch.indexOf('const send = await deps.sendEmail'))
  })
})

describe('E: no new-feature log leaks an identifier', () => {
  const FILES = ['app/api/onboarding/resume/route.ts', 'app/api/admin/invitations/rotate-resume/route.ts',
    'app/api/admin/onboarding-catchup/route.ts', 'app/api/profile/initialize/route.ts',
    'app/api/profile/onboarding-step/route.ts', 'lib/onboarding/reminderWorker.ts',
    'lib/invitations/sendResumeAccess.ts', 'lib/invitations/resumeTokenStore.ts']
  const BAD = /\b(waitlist_?[iI]d|auth_?[uU]ser_?[iI]d|delivery_?[iI]d|operation_?[iI]d|email|token|link|user_?[iI]d)\b/

  it.each(FILES)('%s logs only cid / event / class / counts', (f) => {
    const src = readFileSync(f, 'utf8')
    for (const m of Array.from(src.matchAll(/console\.(error|log|warn)\(([\s\S]{0,400}?)\)\s*\n/g))) {
      expect(m[2]).not.toMatch(BAD)
      expect(m[2]).not.toMatch(/\.message|error\.details|error\.hint/)   // no raw provider/db error
    }
  })
})
