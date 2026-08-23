import { evaluateReminder, STAGE_PURPOSES, type ReminderCandidate, type StagePurpose } from './reminderEligibility'
import { mintResumeToken, buildResumeLink, sha256 } from '@/lib/invitations/resumeToken'
import { sendOnboardingReminder } from '@/lib/email'
import { canSendInvitation, activationRemindersEnabled } from '@/lib/invitations/featureGate'
import { getSiteUrl } from '@/lib/config/siteUrl'

/**
 * Bounded, resumable onboarding-reminder stage worker.
 *
 * Runs inside the existing daily maintenance invocation rather than on a cron entry of its own:
 * Vercel Hobby registers only a small number of crons, so an eleventh entry buys nothing, and this
 * work is a short bounded scan. It runs LAST and on its own budget, so a backlog here can never
 * delay the Wednesday reminder, the expiry stage or the outbox drain.
 *
 * ─── PROSPECTIVE ONLY ─────────────────────────────────────────────────────────────────────────
 * The scan is restricted at the QUERY level to rows with reminder_enrollment_at IS NOT NULL, and
 * the pure predicate rejects unenrolled rows again. Two independent gates, because the entire
 * approved policy rests on the 117 historical invitees never entering an automatic send, and a
 * single filter is one edit away from being lost.
 *
 * ─── DEDUPE AND CONCURRENCY ───────────────────────────────────────────────────────────────────
 * Each stage claims its own row in invitation_deliveries under the partial unique index
 * (waitlist_id, purpose) WHERE status IN ('claimed','accepted','deferred'). A second concurrent
 * worker's INSERT raises 23505 and it skips. The claim happens BEFORE the token is minted and
 * before the provider is called, so a duplicate can never produce a second email.
 */

export const REMINDER_STAGE_BUDGET_MS = 10_000
const MAX_PER_RUN = 50           // bounded: a backlog drains over days rather than in one blast
const SCAN_LIMIT = 500

export interface StageRunResult {
  ran: boolean
  paused?: boolean
  considered: number
  sent: number
  skipped: Record<string, number>
  failed: number
  truncated: boolean
}

export async function runOnboardingReminderStage(
  admin: any,
  opts: { budgetMs?: number; nowMs?: number } = {},
): Promise<StageRunResult> {
  const deadline = Date.now() + (opts.budgetMs ?? REMINDER_STAGE_BUDGET_MS)
  const nowMs = opts.nowMs ?? Date.now()
  const empty: StageRunResult = { ran: false, considered: 0, sent: 0, skipped: {}, failed: 0, truncated: false }

  // Same gate as every other invitation email. 'off' and 'test' keep automatic sends fully paused.
  if (!activationRemindersEnabled()) return { ...empty, paused: true }

  // GATE 1 (query): enrolled rows only. Historical invitations are not even fetched.
  const { data: rows, error } = await admin
    .from('waitlist')
    .select('id, email, full_name, status, invited_at, reminder_enrollment_at')
    .not('reminder_enrollment_at', 'is', null)
    .eq('status', 'invited')
    .lte('invited_at', new Date(nowMs - 24 * 3600_000).toISOString())
    .limit(SCAN_LIMIT)

  if (error || !rows?.length) return { ...empty, ran: true }

  const skipped: Record<string, number> = {}
  let sent = 0, failed = 0, considered = 0, truncated = false

  for (const w of rows) {
    if (Date.now() > deadline || sent >= MAX_PER_RUN) { truncated = true; break }
    considered++

    const candidate = await buildCandidate(admin, w)
    // A lookup that could not be completed sends NOTHING. Fail closed: acting on a state we failed
    // to read is how someone gets emailed after completing, or twice.
    if (!candidate) { skipped['lookup_unavailable'] = (skipped['lookup_unavailable'] ?? 0) + 1; continue }
    // GATE 2 (predicate): the same rule the audit and the campaign use.
    const verdict = evaluateReminder(candidate, nowMs)
    if (!verdict.eligible) {
      skipped[verdict.reason] = (skipped[verdict.reason] ?? 0) + 1
      continue
    }
    if (!canSendInvitation(w.email)) { skipped['gated'] = (skipped['gated'] ?? 0) + 1; continue }

    // The identity was resolved during candidate construction and is unambiguous by predicate.
    // Resolved during candidate construction; the predicate guarantees exactly one identity, but
    // this is checked rather than asserted — an unbound token could never be invalidated by
    // completion, which is the defect this whole pass exists to close.
    if (!candidate.authUserIdResolved) { skipped['identity_unresolved'] = (skipped['identity_unresolved'] ?? 0) + 1; continue }
    const outcome = await sendStage(admin, w, verdict.stage, candidate.authUserIdResolved)
    if (outcome === 'sent') sent++
    else if (outcome === 'failed') failed++
    else skipped[outcome] = (skipped[outcome] ?? 0) + 1
  }

  return { ran: true, considered, sent, skipped, failed, truncated }
}

/** Gather everything the pure predicate needs. Aggregates only; no address ever leaves this scope. */
async function buildCandidate(admin: any, w: any): Promise<ReminderCandidate | null> {
  const email = String(w.email ?? '').trim().toLowerCase()

  // THE authoritative resolver (migration 078). The previous code called a function that did not
  // exist and fell back to listUsers({page:1, perPage:200}) — a single page. Production holds more
  // identities than that, so the fallback reported ZERO users for anyone past page one, which every
  // downstream rule reads as "ambiguous". People were silently unreachable. There is no fallback
  // now: if the resolver fails we return null and the candidate is skipped, rather than proceeding
  // on a count we could not establish.
  const { data: idRows, error: idErr } = await admin.rpc('lookup_auth_identity', { p_email: email })
  if (idErr) return null
  const id = Array.isArray(idRows) ? idRows[0] : idRows
  if (!id) return null
  const authUserCount: number = id.identity_count ?? 0
  const authUserId: string | null = id.auth_user_id ?? null

  let profileExists = false, profileComplete: boolean | null = null
  let profileUpdatedAt: string | null = null, isAdmin = false, isTest = false, accountStatus: string | null = null
  if (authUserId) {
    const { data: p, error: pErr } = await admin.from('profiles')
      .select('id, profile_complete, updated_at, is_admin, is_test_account, account_status')
      .eq('id', authUserId).maybeSingle()
    if (pErr) return null                       // fail closed: an unknown profile state sends nothing
    if (p) {
      profileExists = true
      profileComplete = p.profile_complete ?? null
      profileUpdatedAt = p.updated_at ?? null
      isAdmin = p.is_admin === true
      isTest = p.is_test_account === true
      accountStatus = p.account_status ?? null
    }
  }

  const { data: supp, error: sErr } = await admin.from('invitation_deliveries')
    .select('id').eq('recipient_email', email).in('status', ['bounced', 'blocked', 'complained']).limit(1)
  if (sErr) return null

  // STAGE CONSUMPTION. Everything except 'failed' consumes the stage; 'failed' means the attempt
  // died BEFORE the provider was called, so no message exists and a retry cannot duplicate one.
  // The previous query loaded every row regardless of status, so one pre-provider failure burned
  // that stage permanently. This predicate mirrors migration 077's partial unique index exactly —
  // if they ever disagree, the index wins and the insert raises 23505, which the caller treats as
  // 'already_claimed' rather than as an error.
  const { data: claimed, error: cErr } = await admin.from('invitation_deliveries')
    .select('purpose').eq('waitlist_id', w.id)
    .in('purpose', STAGE_PURPOSES as unknown as string[])
    .neq('status', 'failed')
  if (cErr) return null

  return {
    waitlistId: w.id,
    reminderEnrollmentAt: w.reminder_enrollment_at ?? null,
    invitedAt: w.invited_at ?? null,
    waitlistStatus: w.status ?? null,
    authUserCount,
    authUserIdResolved: authUserId,
    lastSignInAt: id.last_sign_in_at ?? null,
    accountStatus,
    profileExists,
    profileComplete,
    profileUpdatedAt,
    isAdmin,
    isTestAccount: isTest,
    suppressed: Boolean(supp?.length),
    stagesAlreadyClaimed: (claimed ?? []).map((r: any) => r.purpose),
  }
}

/**
 * Claim → mint → send → resolve. The claim comes FIRST so a duplicate can never reach the provider.
 * The resume token is minted only after the claim succeeds, and only its hash is stored.
 */
async function sendStage(admin: any, w: any, stage: StagePurpose, authUserId: string): Promise<'sent' | 'failed' | 'already_claimed' | 'claim_unavailable'> {
  const email = String(w.email ?? '').trim().toLowerCase()

  const { data: claim, error: claimErr } = await admin
    .from('invitation_deliveries')
    .insert({ waitlist_id: w.id, recipient_email: email, purpose: stage, status: 'claimed', attempt_number: 1 })
    .select('id')
    .maybeSingle()

  // 23505 = the partial unique index rejected a concurrent or repeat claim. That is the dedupe
  // working, not an error.
  if (claimErr) return (claimErr as any).code === '23505' ? 'already_claimed' : 'claim_unavailable'
  if (!claim?.id) return 'claim_unavailable'

  const link = await mintResumeLink(admin, w.id, authUserId)
  if (!link) {
    await admin.from('invitation_deliveries').update({ status: 'failed', error_class: 'resume_token_unavailable' }).eq('id', claim.id)
    return 'failed'
  }

  const send = await sendOnboardingReminder({
    to: email, toName: w.full_name || 'there', stage, resumeLink: link,
    idempotencyKey: `onboarding:${claim.id}`,   // one key ⇄ one payload; never reused with a new link
  })

  if (send.success) {
    // Best-effort. The provider already accepted; a bookkeeping failure must never look retryable,
    // or the next run would send a second email.
    try {
      await admin.from('invitation_deliveries')
        .update({ status: 'accepted', provider_message_id: send.messageId ?? null }).eq('id', claim.id)
    } catch { /* accepted is accepted */ }
    return 'sent'
  }
  if (send.uncertain) return 'sent'   // outcome unknown → leave 'claimed'; never resend under a new key
  await admin.from('invitation_deliveries').update({ status: 'failed', error_class: send.errorClass ?? 'provider_error' }).eq('id', claim.id)
  return 'failed'
}

/**
 * Mint a fresh resume token for this reminder. EARLIER TOKENS ARE LEFT LIVE, deliberately.
 *
 * An earlier version superseded the previous token because the plaintext cannot be recovered from a
 * stored digest — which meant issuing stage 2 killed the link in the stage-1 email the member was
 * still looking at. That is the very complaint this work exists to fix: links dying before the
 * profile is finished.
 *
 * The alternative — persisting the plaintext, or anything reversible into it, so one link could be
 * reused — is exactly what must never happen. So every reminder mints a NEW hash and all of them
 * stay valid. Validity is decided at claim time, not by which row is newest: completion, revocation,
 * a status other than 'invited', identity replacement or invitation deletion invalidate every token
 * for that invitation at once, because the claim re-resolves both on every request. Only an
 * explicit admin rotation supersedes live rows.
 *
 * The plaintext leaves this function exactly once, into the email builder.
 */
async function mintResumeLink(admin: any, waitlistId: string, authUserId: string): Promise<string | null> {
  const { token, tokenSha256 } = mintResumeToken()
  const { error } = await admin.from('invitation_resume_tokens').insert({
    waitlist_id: waitlistId,
    auth_user_id: authUserId,          // NOT NULL: the claim requires the identity to still match
    token_sha256: `\\x${tokenSha256.toString('hex')}`,
  })
  if (error) return null               // fail closed — no link, no send, stage marked failed
  return buildResumeLink(getSiteUrl(), token)
}

/** Never log or return the token; this exists so callers can assert the hash without the plaintext. */
export const __hashForTest = sha256
