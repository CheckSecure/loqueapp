import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { RESUME_GENERIC_RESPONSE } from '@/lib/invitations/resumeMessages'

/** Executable code only — these files DOCUMENT the classifier defect they avoid, so the prose
 *  legitimately names sendSecureInvite() and hasProfile. */
const codeOf = (p: string) =>
  readFileSync(p, 'utf8').split('\n')
    .filter(l => { const t = l.trimStart(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') })
    .join('\n')

/**
 * End-to-end coverage for the sender that /api/onboarding/resume actually uses.
 *
 * ─── THE DEFECT THIS EXISTS TO PREVENT ────────────────────────────────────────────────────────
 * The route previously delegated to sendSecureInvite(), whose NEW-INVITATION classifier marks a
 * target `active` — and refuses to send — when last_sign_in_at is set OR a profiles row exists:
 *
 *     if (user) activated = !!user.last_sign_in_at || (await deps.hasProfile(user.id))
 *
 * The approved catch-up cohort is *defined* as people who signed in and did not finish. Every one
 * of them satisfied that test, so all 18 could press "Continue setting up", receive the generic
 * success message, and get no email at all.
 *
 * These tests drive the REAL sender against a fake Supabase surface. They do not stub out
 * classification — there is none to stub, which is the point.
 */

const state = vi.hoisted(() => ({
  waitlist: null as any,
  identity: { identity_count: 1, auth_user_id: 'auth-1', last_sign_in_at: null as string | null },
  profile: null as any,
  suppressions: [] as any[],
  /** what claim_resume_access_attempt returns — the DATABASE decides this, not the sender */
  claimState: 'created' as string,
  /** what begin_resume_dispatch returns — false models a lost race or a failed marker update */
  markerOk: true as boolean,
  markerError: false as boolean,
  /** inject an error into a specific post-provider transition */
  updateErrorOn: null as null | 'accepted' | 'failed' | 'uncertain',
  providerCalls: 0,
  claims: [] as any[],
  generateLinkFails: false,
  sendResult: { success: true, messageId: 'msg-1' } as any,
  emails: [] as any[],
  updates: [] as any[],
  mintedTokens: [] as any[],
  supersedeCalls: [] as any[],
  revoked: [] as any[],
  mintFails: false,
}))

vi.mock('@/lib/email', () => ({
  sendSecureInviteEmail: async (a: any) => { state.providerCalls++; state.emails.push(a); return state.sendResult },
}))
vi.mock('@/lib/config/siteUrl', () => ({
  getSiteUrl: () => 'https://www.andrel.app',
  getRecoveryRedirectUrl: () => 'https://www.andrel.app/auth/recover',
}))

import { sendResumeAccessEmail } from '@/lib/invitations/sendResumeAccess'

/** Minimal Supabase-shaped fake. Only what the sender touches. */
const admin = {
  rpc: async function (fn: string, _args?: any) {
    if (fn === 'lookup_auth_identity') return { data: [state.identity], error: null }
    if (fn === 'begin_resume_dispatch') {
      if (state.markerError) return { data: null, error: { code: 'XX000' } }
      return { data: state.markerOk, error: null }
    }
    if (fn === 'supersede_other_resume_tokens') {
      state.supersedeCalls.push(_args)
      return { data: 1, error: null }
    }
    if (fn === 'claim_resume_access_attempt') {
      // Mirrors the real function's contract: a coarse state plus an id only when created.
      const created = state.claimState === 'created'
      if (created) state.claims.push({ table: 'rpc', row: { purpose: 'resume_access', waitlist_id: null, auth_user_id: 'auth-1' } })
      return { data: [{ out_state: state.claimState, out_delivery_id: created ? 'claim-1' : null }], error: null }
    }
    return { data: null, error: null }
  },
  auth: { admin: { generateLink: async () => state.generateLinkFails
    ? { data: null, error: { message: 'nope' } }
    : { data: { properties: { hashed_token: 'HASHED' } }, error: null } } },
  from(table: string) {
    const q: any = {
      _table: table, _filters: {} as any,
      select() { return q }, eq(k: string, v: any) { q._filters[k] = v; return q },
      in() { return q }, gte() { return q }, limit() { return q.__resolve() },
      maybeSingle() { return q.__resolve(true) },
      insert(row: any) {
        if (table === 'invitation_resume_tokens') state.mintedTokens.push(row)
        else state.claims.push({ table, row })
        q._inserted = row; return q
      },
      update(row: any) {
        state.updates.push({ table, row })
        const inject =
          (state.updateErrorOn === 'accepted' && row.status === 'accepted') ||
          (state.updateErrorOn === 'failed' && row.status === 'failed' && row.dispatch_state === 'dispatched') ||
          (state.updateErrorOn === 'uncertain' && row.dispatch_state === 'uncertain')
        const result = { error: inject ? { code: 'XX000' } : null }
        // revokeResumeToken finishes .update().eq().is(); the delivery updates stop at .eq().
        const eqNode: any = Promise.resolve(result)
        eqNode.is = async () => { state.revoked.push(row); return result }
        return { eq: () => eqNode }
      },
      __resolve(single = false) {
        if (q._inserted) {
          if (table === 'invitation_resume_tokens') {
            return Promise.resolve(state.mintFails
              ? { data: null, error: { code: 'XX000' } }
              : { data: { id: `tok-${state.mintedTokens.length}` }, error: null })
          }
          return Promise.resolve({ data: { id: `claim-${state.claims.length}` }, error: null })
        }
        if (table === 'waitlist') return Promise.resolve({ data: state.waitlist, error: null })
        if (table === 'profiles') return Promise.resolve({ data: state.profile, error: null })
        if (table === 'invitation_deliveries') return Promise.resolve({ data: state.suppressions, error: null })
        return Promise.resolve({ data: single ? null : [], error: null })
      },
      then(res: any) { return q.__resolve().then(res) },
    }
    return q
  },
} as any

beforeEach(() => {
  state.waitlist = { id: 'wl-1', email: ' Member@Example.COM ', full_name: 'Member', status: 'invited' }
  state.identity = { identity_count: 1, auth_user_id: 'auth-1', last_sign_in_at: null }
  state.profile = null
  state.suppressions = []; state.claims = []; state.updates = []; state.claimState = 'created'
  state.markerOk = true; state.markerError = false; state.updateErrorOn = null; state.providerCalls = 0
  state.generateLinkFails = false
  state.mintedTokens = []; state.supersedeCalls = []; state.revoked = []; state.mintFails = false
  state.sendResult = { success: true, messageId: 'msg-1' }
  state.emails = []
})

const send = () => sendResumeAccessEmail(admin, { waitlistId: 'wl-1', authUserId: 'auth-1' })

describe('the intended cohort actually receives a fresh authentication email', () => {
  it('SIGNED IN + NO PROFILE → sent', async () => {
    state.identity.last_sign_in_at = '2026-08-01T00:00:00Z'
    state.profile = null
    await expect(send()).resolves.toEqual({ state: 'sent' })
    expect(state.emails).toHaveLength(1)
    expect(state.emails[0].link).toMatch(/^https:\/\/www\.andrel\.app\/auth\/recover#/)
  })

  it('SIGNED IN + INCOMPLETE PROFILE → sent (the 18-person cohort)', async () => {
    state.identity.last_sign_in_at = '2026-08-01T00:00:00Z'
    state.profile = { profile_complete: false }
    await expect(send()).resolves.toEqual({ state: 'sent' })
    expect(state.emails).toHaveLength(1)
  })

  it('NEVER SIGNED IN but otherwise valid → sent', async () => {
    state.identity.last_sign_in_at = null
    await expect(send()).resolves.toEqual({ state: 'sent' })
    expect(state.emails).toHaveLength(1)
  })

  it('uses a RECOVERY link, not an invite link', async () => {
    await send()
    expect(state.emails[0].link).toContain('type=recovery')
  })

  it('sends to the address on the INVITATION, normalized — never to caller input', async () => {
    await send()
    expect(state.emails[0].to).toBe('member@example.com')
  })
})

describe('terminal and unsafe states send nothing', () => {
  it('COMPLETE profile → ineligible', async () => {
    state.profile = { profile_complete: true }
    await expect(send()).resolves.toEqual({ state: 'ineligible' })
    expect(state.emails).toHaveLength(0)
  })

  it.each(['revoked', 'declined', 'pending', 'joined'])('status %s → ineligible', async (s) => {
    state.waitlist.status = s
    await expect(send()).resolves.toEqual({ state: 'ineligible' })
    expect(state.emails).toHaveLength(0)
  })

  it('IDENTITY REPLACED → ineligible', async () => {
    state.identity.auth_user_id = 'auth-2'      // recreated at the same address
    await expect(send()).resolves.toEqual({ state: 'ineligible' })
    expect(state.emails).toHaveLength(0)
  })

  it('AMBIGUOUS identity → ineligible', async () => {
    state.identity = { identity_count: 2, auth_user_id: null as any, last_sign_in_at: null }
    await expect(send()).resolves.toEqual({ state: 'ineligible' })
    expect(state.emails).toHaveLength(0)
  })

  it('SUPPRESSED address → ineligible', async () => {
    state.suppressions = [{ id: 'd1' }]
    await expect(send()).resolves.toEqual({ state: 'ineligible' })
    expect(state.emails).toHaveLength(0)
  })

  it('the DATABASE says in_flight → no second send', async () => {
    state.claimState = 'in_flight'
    await expect(send()).resolves.toEqual({ state: 'in_flight' })
    expect(state.emails).toHaveLength(0)
  })

  it('the DATABASE says uncertain_review → no send, ever, regardless of elapsed time', async () => {
    state.claimState = 'uncertain_review'
    await expect(send()).resolves.toEqual({ state: 'in_flight', errorClass: 'uncertain_review' })
    expect(state.emails).toHaveLength(0)
  })

  it('the DATABASE says debounced → no send', async () => {
    state.claimState = 'debounced'
    await expect(send()).resolves.toEqual({ state: 'in_flight', errorClass: 'debounced' })
    expect(state.emails).toHaveLength(0)
  })
})

describe('provider outcomes are distinguishable internally', () => {
  it('definite failure → failed, and the claim is marked failed', async () => {
    state.sendResult = { success: false, errorClass: 'provider_error' }
    await expect(send()).resolves.toEqual({ state: 'failed', errorClass: 'provider_error' })
    expect(state.updates.some(u => u.row.status === 'failed')).toBe(true)
  })

  it('uncertain → marks dispatch_state uncertain and never sets status failed', async () => {
    state.sendResult = { success: false, uncertain: true }
    await expect(send()).resolves.toEqual({ state: 'uncertain', errorClass: 'provider_timeout' })
    expect(state.updates.some(u => u.row.status === 'failed')).toBe(false)
    expect(state.updates.some(u => u.row.dispatch_state === 'uncertain')).toBe(true)
  })

  it('link generation failure → failed, no email', async () => {
    state.generateLinkFails = true
    await expect(send()).resolves.toEqual({ state: 'failed', errorClass: 'link_generation_failed' })
    expect(state.emails).toHaveLength(0)
  })

  it('claims atomically BEFORE calling the provider', async () => {
    await send()
    expect(state.claims).toHaveLength(1)
    expect(state.claims[0].row.purpose).toBe('resume_access')
    expect(state.claims[0].row.waitlist_id).toBeNull()   // stays out of 049's one-per-purpose lock
    expect(state.claims[0].row.auth_user_id).toBe('auth-1')
  })
})

describe('the route body is identical across every outcome', () => {
  it('one generic string is returned for success and for every refusal', () => {
    const route = readFileSync('app/api/onboarding/resume/route.ts', 'utf8')
    expect(route).toMatch(/const generic = \(\) => NextResponse\.json\(\{ ok: true, message: RESUME_GENERIC_RESPONSE \}\)/)
    // the sender's outcome never reaches the browser
    expect(route).toMatch(/console\.log\(JSON\.stringify\(\{ event: 'resume_send', cid, state: result\.state/)
    expect(route).not.toMatch(/json\(\{[^}]*result\.state/)
    expect(RESUME_GENERIC_RESPONSE).toMatch(/If this invitation is still open/)
  })

  it('the route calls the DEDICATED sender, not sendSecureInvite', () => {
    const route = readFileSync('app/api/onboarding/resume/route.ts', 'utf8')
    expect(route).toMatch(/sendResumeAccessEmail/)
    expect(codeOf('app/api/onboarding/resume/route.ts')).not.toMatch(/sendSecureInviteForWaitlist|sendSecureInvite\(/)
    expect(route).toMatch(/NOT sendSecureInvite\(\), whose new-invitation classifier/)
  })

  it('the sender never consults the new-invitation classifier', () => {
    expect(codeOf('lib/invitations/sendResumeAccess.ts'))
      .not.toMatch(/classifyInviteTarget|sendSecureInvite\(|hasProfile|linkTypeForPlan/)
    expect(readFileSync('lib/invitations/sendResumeAccess.ts', 'utf8')).toMatch(/catastrophically wrong here/)
  })
})

describe('BLOCKER 1: the initial invitation fails closed on fallback failure', () => {
  // Drives the REAL sendSecureInvite() orchestrator. The dep contract is what production supplies.
  const base = () => {
    const calls = { send: 0, markFailed: [] as any[], mint: 0 }
    const deps: any = {
      siteUrl: 'https://www.andrel.app',
      lookupAuth: async () => ({ count: 0, user: null }),          // → plan 'create'
      hasProfile: async () => false,
      claimDelivery: async () => ({ deliveryId: 'del-1', isNew: true }),
      generateLink: async () => ({ hashedToken: 'H', userId: 'auth-9' }),
      markAccepted: async () => {},
      markFailed: async (id: string, cls: string) => { calls.markFailed.push({ id, cls }) },
      sendEmail: async () => { calls.send++; return { success: true, messageId: 'm' } },
    }
    return { calls, deps }
  }

  it('mintResumeLink returns NULL → zero provider calls', async () => {
    const { calls, deps } = base()
    deps.mintResumeLink = async () => { calls.mint++; return null }
    const { sendSecureInvite } = await import('@/lib/invitations/secureInvite')
    const r = await sendSecureInvite(deps, { email: 'a@x.com', fullName: 'A', waitlistId: 'w1' })
    expect(calls.send).toBe(0)
    expect(r).toMatchObject({ ok: false, sent: false, state: 'error', errorClass: 'resume_token_unavailable' })
    expect(calls.markFailed).toEqual([{ id: 'del-1', cls: 'resume_token_unavailable' }])
  })

  it('mintResumeLink THROWS → zero provider calls, no unhandled rejection', async () => {
    const { calls, deps } = base()
    deps.mintResumeLink = async () => { calls.mint++; throw new Error('db down') }
    const { sendSecureInvite } = await import('@/lib/invitations/secureInvite')
    const r = await sendSecureInvite(deps, { email: 'a@x.com', fullName: 'A', waitlistId: 'w1' })
    expect(calls.send).toBe(0)
    expect(r).toMatchObject({ ok: false, sent: false, state: 'error', errorClass: 'resume_token_unavailable' })
  })

  it('unresolved auth identity → zero provider calls', async () => {
    const { calls, deps } = base()
    deps.generateLink = async () => ({ hashedToken: 'H', userId: null })   // no id anywhere
    deps.mintResumeLink = async () => { calls.mint++; return { link: 'L', tokenId: 't' } }
    const { sendSecureInvite } = await import('@/lib/invitations/secureInvite')
    const r = await sendSecureInvite(deps, { email: 'a@x.com', fullName: 'A', waitlistId: 'w1' })
    expect(calls.send).toBe(0)
    expect(calls.mint).toBe(0)                                    // never even attempted
    expect(r).toMatchObject({ ok: false, sent: false, errorClass: 'resume_identity_unresolved' })
  })

  it('a successful mint DOES send, carrying the fallback', async () => {
    const { calls, deps } = base()
    let captured: any = null
    deps.mintResumeLink = async () => ({ link: 'https://www.andrel.app/resume#token=T', tokenId: 't' })
    deps.sendEmail = async (a: any) => { calls.send++; captured = a; return { success: true, messageId: 'm' } }
    const { sendSecureInvite } = await import('@/lib/invitations/secureInvite')
    const r = await sendSecureInvite(deps, { email: 'a@x.com', fullName: 'A', waitlistId: 'w1' })
    expect(calls.send).toBe(1)
    expect(captured.resumeLink).toBe('https://www.andrel.app/resume#token=T')
    expect(r).toMatchObject({ ok: true, sent: true })
  })

  it('a legacy call site that omits the dep still sends (optional by design)', async () => {
    const { calls, deps } = base()
    delete deps.mintResumeLink
    const { sendSecureInvite } = await import('@/lib/invitations/secureInvite')
    const r = await sendSecureInvite(deps, { email: 'a@x.com', fullName: 'A', waitlistId: 'w1' })
    expect(calls.send).toBe(1)
    expect(r).toMatchObject({ ok: true, sent: true })
  })

  it('the stale "sends WITHOUT a fallback" contract is gone from the source', () => {
    const src = readFileSync('lib/invitations/secureInvite.ts', 'utf8')
    expect(src).not.toMatch(/sends WITHOUT a fallback/)
    expect(src).not.toMatch(/no invitation at all is worse["']?\s*$/m)
    expect(src).toMatch(/EITHER outcome is FAIL-CLOSED/)
    // and the throw is genuinely guarded, before the send
    expect(src.indexOf('resume = await deps.mintResumeLink(resolvedUserId)'))
      .toBeLessThan(src.indexOf('const send = await deps.sendEmail'))
    expect(src).toMatch(/\} catch \{\s*\n\s*resume = null\s*\n\s*\}/)
  })
})

describe('BLOCKER 2/3: the sender uses the atomic claim, with no time-based unlock', () => {
  const src = readFileSync('lib/invitations/sendResumeAccess.ts', 'utf8')
  const code = codeOf('lib/invitations/sendResumeAccess.ts')

  it('no check-then-insert remains', () => {
    expect(code).not.toMatch(/gte\('attempted_at'/)
    expect(code).not.toMatch(/IN_FLIGHT_WINDOW_MS/)
    // the claim is a single RPC, not a select followed by an insert
    expect(code).toMatch(/rpc\('claim_resume_access_attempt'/)
    expect(code).not.toMatch(/from\('invitation_deliveries'\)\s*\n?\s*\.insert\(/)
  })

  it('an uncertain previous attempt is never retried by this code path', () => {
    expect(code).toMatch(/if \(claimState === 'uncertain_review'\) return \{ state: 'in_flight'/)
    expect(src).toMatch(/never becomes "it failed" because time passed/)
  })

  it('records dispatch_state at every transition', () => {
    expect(code).toMatch(/dispatch_state: 'uncertain'/)
    expect(code).toMatch(/dispatch_state: 'dispatched'/)
    expect(code).toMatch(/dispatch_state: 'pending'/)
  })

  it('an uncertain send leaves the row claimed, never failed', () => {
    // scoped to the uncertain BRANCH — the definite-failure branch that follows it legitimately
    // does set status:'failed', and slicing past the closing brace would swallow it.
    const at = code.indexOf('if (send.uncertain)')
    const branch = code.slice(at, code.indexOf('return { state: \'uncertain\'', at))
    expect(branch).toMatch(/dispatch_state: 'uncertain'/)
    expect(branch).not.toMatch(/status: 'failed'/)
    // and the definite-failure branch DOES mark it failed
    expect(code.slice(code.indexOf('return { state: \'uncertain\'', at)))
      .toMatch(/status: 'failed', dispatch_state: 'dispatched'/)
  })
})

describe('the provider-dispatch crash window', () => {
  it('the marker is set BEFORE the provider is contacted', async () => {
    await send()
    const code = codeOf('lib/invitations/sendResumeAccess.ts')
    expect(code.indexOf("rpc('begin_resume_dispatch'")).toBeLessThan(code.indexOf('const send = await sendSecureInviteEmail'))
    expect(state.providerCalls).toBe(1)
  })

  it('marker returns FALSE (lost race) → ZERO provider calls', async () => {
    state.markerOk = false
    await expect(send()).resolves.toEqual({ state: 'in_flight', errorClass: 'dispatch_marker_failed' })
    expect(state.providerCalls).toBe(0)
    expect(state.emails).toHaveLength(0)
  })

  it('marker RPC errors → ZERO provider calls (an { error } result, not a throw)', async () => {
    state.markerError = true
    await expect(send()).resolves.toEqual({ state: 'in_flight', errorClass: 'dispatch_marker_failed' })
    expect(state.providerCalls).toBe(0)
  })

  it('link generation fails BEFORE the marker → no provider call, row left pending', async () => {
    state.generateLinkFails = true
    await expect(send()).resolves.toEqual({ state: 'failed', errorClass: 'link_generation_failed' })
    expect(state.providerCalls).toBe(0)
    expect(state.updates.some(u => u.row.dispatch_state === 'pending' && u.row.status === 'failed')).toBe(true)
  })

  it('provider ACCEPTED but the accepted update fails → reported sent, row left dispatching', async () => {
    state.updateErrorOn = 'accepted'
    const r = await send()
    expect(r).toEqual({ state: 'sent', errorClass: 'accept_record_failed' })
    expect(state.providerCalls).toBe(1)
    // nothing relaxed the state back towards retryable
    expect(state.updates.some(u => u.row.dispatch_state === 'pending')).toBe(false)
  })

  it('provider REFUSED but the failure update fails → reported uncertain, never retryable', async () => {
    state.sendResult = { success: false, errorClass: 'provider_error' }
    state.updateErrorOn = 'failed'
    const r = await send()
    expect(r).toEqual({ state: 'uncertain', errorClass: 'failure_record_failed' })
    expect(state.providerCalls).toBe(1)
  })

  it('provider UNCERTAIN and the uncertain update fails → still uncertain (dispatching persists)', async () => {
    state.sendResult = { success: false, uncertain: true }
    state.updateErrorOn = 'uncertain'
    const r = await send()
    expect(r).toEqual({ state: 'uncertain', errorClass: 'uncertain_record_failed' })
    expect(state.providerCalls).toBe(1)
  })

  it('a definite refusal recorded successfully is the ONLY relaxing transition', async () => {
    state.sendResult = { success: false, errorClass: 'provider_error' }
    await expect(send()).resolves.toEqual({ state: 'failed', errorClass: 'provider_error' })
    expect(state.updates.some(u => u.row.status === 'failed' && u.row.dispatch_state === 'dispatched')).toBe(true)
  })

  it('every post-provider transition checks its { error } result', () => {
    const code = codeOf('lib/invitations/sendResumeAccess.ts')
    expect(code).toMatch(/const \{ error: accErr \}/)
    expect(code).toMatch(/const \{ error: uncErr \}/)
    expect(code).toMatch(/const \{ error: failErr \}/)
    expect(code).toMatch(/if \(markErr \|\| marked !== true\)/)
    const src = readFileSync('lib/invitations/sendResumeAccess.ts', 'utf8')
    expect(src).toMatch(/they do not necessarily throw/)
    expect(src).toMatch(/possibly sent; do not resend/)
  })

  it('a crashed dispatching row can never be read as never-attempted', () => {
    const m077 = readFileSync('supabase/migrations/077_onboarding_reminder_stages.sql', 'utf8')
    const m078 = readFileSync('supabase/migrations/078_invitation_resume_tokens.sql', 'utf8')
    expect(m077).toMatch(/'dispatching',/)
    expect(m077).toMatch(/NEVER auto-retryable/)
    expect(m078).toMatch(/d\.dispatch_state IN \('dispatching', 'uncertain'\)/)
    // only 'pending' is ever retired by the lease
    expect(m078).toMatch(/coalesce\(d\.dispatch_state, 'pending'\) = 'pending'\s*\n\s*AND d\.attempted_at <=/)
  })
})

describe('the resume-access email carries its own fallback (migration 094)', () => {
  it('mints a replacement, sends it, and retires the older tokens ONLY after acceptance', async () => {
    await expect(send()).resolves.toEqual({ state: 'sent' })
    expect(state.mintedTokens).toHaveLength(1)
    expect(state.mintedTokens[0].waitlist_id).toBe('wl-1')
    expect(state.mintedTokens[0].auth_user_id).toBe('auth-1')   // bound, so completion can kill it
    // The email that exists BECAUSE a link died no longer ships without a way back in.
    expect(state.emails[0].resumeLink).toMatch(/^https:\/\/www\.andrel\.app\/resume#token=/)
    // Retirement keeps exactly the token we just emailed.
    expect(state.supersedeCalls).toHaveLength(1)
    expect(state.supersedeCalls[0]).toEqual({ p_waitlist_id: 'wl-1', p_keep_token_id: 'tok-1' })
  })

  it('MINTS BEFORE SENDING, so every existing link is live while the provider is called', async () => {
    await send()
    const code = readFileSync('lib/invitations/sendResumeAccess.ts', 'utf8')
    expect(code.indexOf('mintBoundResumeLink')).toBeLessThan(code.indexOf('sendSecureInviteEmail('))
    expect(code.indexOf('sendSecureInviteEmail(')).toBeLessThan(code.indexOf('supersede_other_resume_tokens'))
  })

  it('an UNCERTAIN send retires nothing and revokes nothing — more live links, never fewer', async () => {
    state.sendResult = { success: false, uncertain: true }
    await expect(send()).resolves.toEqual({ state: 'uncertain', errorClass: 'provider_timeout' })
    expect(state.supersedeCalls).toHaveLength(0)
    expect(state.revoked).toHaveLength(0)
  })

  it('a DEFINITE refusal revokes only the replacement and retires nothing older', async () => {
    state.sendResult = { success: false, errorClass: 'provider_error' }
    await expect(send()).resolves.toEqual({ state: 'failed', errorClass: 'provider_error' })
    expect(state.supersedeCalls).toHaveLength(0)          // older links untouched
    expect(state.revoked).toHaveLength(1)                 // the unsent one is not left as a capability
  })

  it('a mint failure DEGRADES to the old behaviour rather than blocking the sign-in link', async () => {
    state.mintFails = true
    await expect(send()).resolves.toEqual({ state: 'sent' })
    expect(state.emails[0].resumeLink).toBeNull()
    expect(state.supersedeCalls).toHaveLength(0)          // nothing to keep, so nothing is retired
  })

  it('a failed retirement never changes the reported outcome — the email did go out', async () => {
    const realRpc = admin.rpc
    admin.rpc = async function (fn: string, args?: any) {
      if (fn === 'supersede_other_resume_tokens') return { data: null, error: { code: 'XX000' } }
      return realRpc.call(this, fn, args)
    }
    try {
      await expect(send()).resolves.toEqual({ state: 'sent' })
    } finally { admin.rpc = realRpc }
  })
})
