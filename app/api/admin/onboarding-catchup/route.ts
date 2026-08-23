import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'
import { getSiteUrl } from '@/lib/config/siteUrl'
import { classifyCatchup, type ReminderCandidate } from '@/lib/onboarding/reminderEligibility'
import { mintResumeToken, buildResumeLink } from '@/lib/invitations/resumeToken'
import { sendOnboardingReminder } from '@/lib/email'
import { canSendInvitation, invitationsMode } from '@/lib/invitations/featureGate'
import { CATCHUP_CAMPAIGN_KEY } from '@/lib/onboarding/catchupCampaign'

/**
 * ADMIN-ONLY historical catch-up campaign.
 *
 * The 117 people already on the waitlist before this feature shipped are deliberately excluded from
 * every automatic reminder — they have no reminder_enrollment_at, so the daily worker never even
 * fetches them. This route is the ONLY way any of them is contacted, and it is never scheduled,
 * never called by a cron, and never triggered by a page load.
 *
 * The campaign key is a fixed constant in lib/onboarding/catchupCampaign.ts — see the reasoning
 * there. A route module may not export anything but handlers, which is why it lives elsewhere.
 */

const MAX_BATCH = 25
const DEADLINE_MS = 20_000

type Classification =
  | 'ready' | 'completed' | 'revoked_or_declined' | 'suppressed' | 'ambiguous'
  | 'never_signed_in'          // invited but never began — NOT the approved cohort
  | 'no_longer_incomplete' | 'already_sent' | 'excluded' | 'not_selected' | 'lookup_unavailable'

const mask = (e: string) => {
  const [l, d] = e.split('@')
  return l && d ? `${l[0]}***${l[l.length - 1]}@${d}` : '***'
}

export async function POST(req: Request) {
  const crossOrigin = assertSameOrigin(req as any)
  if (crossOrigin) return crossOrigin

  // 1. Authenticated admin, verified server-side against the profile — never from a client claim.
  const supa = createClient()
  const { data: { user } } = await supa.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let admin: ReturnType<typeof createAdminClient>
  try { admin = createAdminClient() } catch {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }
  const { data: me } = await admin.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
  if (me?.is_admin !== true) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json().catch(() => ({})) as {
    dryRun?: boolean; testRecipient?: string; confirmFullCampaign?: boolean
  }

  // 2. DRY RUN IS THE DEFAULT. Sending requires an explicit, positive opt-in — a missing, malformed
  //    or absent body can only ever produce a report, never an email.
  const dryRun = body.dryRun !== false
  const testRecipient = typeof body.testRecipient === 'string' ? body.testRecipient.trim().toLowerCase() : null
  const confirmed = body.confirmFullCampaign === true

  // 3. A full campaign needs BOTH dryRun:false AND confirmFullCampaign:true. One flag is a typo
  //    away from a mass send; two independent ones are not.
  if (!dryRun && !testRecipient && !confirmed) {
    return NextResponse.json({
      ok: false,
      error: 'confirmation_required',
      message: 'A full campaign requires confirmFullCampaign: true. Nothing was sent.',
    }, { status: 400 })
  }

  const { data: rows, error } = await admin
    .from('waitlist')
    .select('id, email, full_name, status, invited_at, reminder_enrollment_at')
    .eq('status', 'invited')
    .is('reminder_enrollment_at', null)      // historical cohort ONLY, by construction
    .limit(500)
  if (error) return NextResponse.json({ error: 'Could not load the cohort.' }, { status: 500 })

  const deadline = Date.now() + DEADLINE_MS
  const counts: Record<Classification, number> = {
    ready: 0, completed: 0, revoked_or_declined: 0, suppressed: 0, ambiguous: 0,
    never_signed_in: 0, no_longer_incomplete: 0, already_sent: 0, excluded: 0,
    not_selected: 0, lookup_unavailable: 0,
  }
  const recipients: { masked: string; classification: Classification; sent: boolean }[] = []
  let sent = 0, failed = 0, truncated = false

  for (const w of rows ?? []) {
    if (Date.now() > deadline || sent >= MAX_BATCH) { truncated = true; break }
    const email = String(w.email ?? '').trim().toLowerCase()

    const { cls } = await classify(admin, w, email)
    // Test-recipient mode: everyone else is reported but not selected.
    const selected = testRecipient ? email === testRecipient : true
    const finalCls: Classification = cls === 'ready' && !selected ? 'not_selected' : cls
    counts[finalCls]++
    recipients.push({ masked: mask(email), classification: finalCls, sent: false })

    if (finalCls !== 'ready' || dryRun) continue
    if (!canSendInvitation(email)) { counts.excluded++; continue }

    // 4. RECLASSIFY IMMEDIATELY BEFORE SENDING. Everything above was computed while earlier
    //    recipients were being processed, which can take seconds — long enough for someone to
    //    finish onboarding or for an admin to revoke them. This second check is the one that counts.
    const recheck = await classify(admin, w, email)
    if (recheck.cls !== 'ready' || !recheck.authUserId) { counts[recheck.cls]++; continue }

    const ok = await sendOne(admin, w, email, recheck.authUserId)
    if (ok) { sent++; recipients[recipients.length - 1].sent = true } else failed++
  }

  // 5. Masked output only. No raw address, no waitlist id, no token, ever — in the response or the log.
  console.log(JSON.stringify({
    event: 'onboarding_catchup_run', campaign: CATCHUP_CAMPAIGN_KEY,
    mode: dryRun ? 'dry_run' : testRecipient ? 'test_recipient' : 'full',
    considered: recipients.length, sent, failed, truncated,
  }))

  return NextResponse.json({
    ok: true,
    campaignKey: CATCHUP_CAMPAIGN_KEY,
    mode: dryRun ? 'dry_run' : testRecipient ? 'test_recipient' : 'full',
    invitationsMode: invitationsMode(),
    considered: recipients.length,
    counts, sent, failed, truncated,
    recipients,   // masked addresses only
  })
}

async function classify(admin: any, w: any, email: string): Promise<{ cls: Classification; authUserId: string | null }> {
  const no = (cls: Classification) => ({ cls, authUserId: null })
  if (w.status === 'revoked' || w.status === 'declined') return no('revoked_or_declined')

  // THE authoritative resolver (migration 078). The previous code read only the first page of
  // listUsers(), so anyone past the first 200 identities resolved to zero users — indistinguishable
  // from "ambiguous", and silently unreachable. There is no fallback: a lookup we could not
  // complete classifies as lookup_unavailable and sends nothing.
  const { data: idRows, error: idErr } = await admin.rpc('lookup_auth_identity', { p_email: email })
  if (idErr) return no('lookup_unavailable')
  const id = Array.isArray(idRows) ? idRows[0] : idRows
  if (!id) return no('lookup_unavailable')
  if ((id.identity_count ?? 0) !== 1 || !id.auth_user_id) return no('ambiguous')
  const authUserId: string = id.auth_user_id

  const { data: p, error: pErr } = await admin.from('profiles')
    .select('profile_complete, is_admin, is_test_account, account_status')
    .eq('id', authUserId).maybeSingle()
  if (pErr) return no('lookup_unavailable')

  const { data: supp, error: sErr } = await admin.from('invitation_deliveries')
    .select('id').eq('recipient_email', email).in('status', ['bounced', 'blocked', 'complained']).limit(1)
  if (sErr) return no('lookup_unavailable')

  // Durable per-recipient dedupe on the FIXED campaign key. Everything except 'failed' consumes the
  // slot, matching migration 077's partial unique index: a pre-provider failure is retryable, an
  // accepted/delivered/bounced one is not.
  const { data: already, error: aErr } = await admin.from('invitation_deliveries')
    .select('id').eq('waitlist_id', w.id).eq('purpose', 'onboarding_catchup').neq('status', 'failed').limit(1)
  if (aErr) return no('lookup_unavailable')
  if (already?.length) return no('already_sent')

  const candidate: ReminderCandidate = {
    waitlistId: w.id, reminderEnrollmentAt: w.reminder_enrollment_at ?? null,
    invitedAt: w.invited_at ?? null, waitlistStatus: w.status ?? null,
    authUserCount: 1, authUserIdResolved: authUserId,
    // THE COHORT DEFINITION — this was missing entirely, so the predicate matched the whole
    // historical population instead of the people who signed in and stalled.
    lastSignInAt: id.last_sign_in_at ?? null,
    accountStatus: p?.account_status ?? null,
    profileExists: !!p, profileComplete: p?.profile_complete ?? null,
    isAdmin: p?.is_admin ?? false, isTestAccount: p?.is_test_account ?? false,
    suppressed: Boolean(supp?.length), stagesAlreadyClaimed: [],
  }

  const verdict = classifyCatchup(candidate)
  if (verdict === 'ready') return { cls: 'ready', authUserId }
  if (verdict === 'never_signed_in') return no('never_signed_in')
  if (verdict === 'completed') return no('completed')
  if (verdict === 'suppressed') return no('suppressed')
  if (verdict === 'ambiguous_identity') return no('ambiguous')
  if (verdict === 'not_invited_status') return no('revoked_or_declined')
  return no('excluded')
}

async function sendOne(admin: any, w: any, email: string, authUserId: string): Promise<boolean> {
  // The claim IS the dedupe: migration 077's partial unique index makes a concurrent or repeated
  // run raise 23505 rather than send twice.
  const { data: claim, error: claimErr } = await admin.from('invitation_deliveries')
    .insert({ waitlist_id: w.id, recipient_email: email, purpose: 'onboarding_catchup', status: 'claimed', attempt_number: 1 })
    .select('id').maybeSingle()
  if (claimErr || !claim?.id) return false

  // Mint a fresh token; earlier tokens for this invitation are left LIVE. Superseding them would
  // kill links in emails the member may still be holding, and reusing one would require storing
  // recoverable plaintext. auth_user_id is bound so completion can invalidate it.
  const { token, tokenSha256 } = mintResumeToken()
  const { error: tokErr } = await admin.from('invitation_resume_tokens')
    .insert({ waitlist_id: w.id, auth_user_id: authUserId, token_sha256: `\\x${tokenSha256.toString('hex')}` })
  if (tokErr) {
    await admin.from('invitation_deliveries').update({ status: 'failed', error_class: 'resume_token_unavailable' }).eq('id', claim.id)
    return false
  }

  const send = await sendOnboardingReminder({
    to: email, toName: w.full_name || 'there', stage: 'onboarding_catchup',
    resumeLink: buildResumeLink(getSiteUrl(), token),
    idempotencyKey: `${CATCHUP_CAMPAIGN_KEY}:${claim.id}`,
  })
  if (send.success) {
    try {
      await admin.from('invitation_deliveries')
        .update({ status: 'accepted', provider_message_id: send.messageId ?? null }).eq('id', claim.id)
    } catch { /* provider already accepted — never downgrade to retryable */ }
    return true
  }
  // UNCERTAIN: leave the row 'claimed', which CONSUMES the stage. Never resend under a new key with
  // a regenerated link — same key + new payload is a 409, a new key is a double send.
  if (send.uncertain) return true
  // Definite pre-provider failure: mark 'failed', the only status that does not consume the stage,
  // so a later run may retry with a fresh claim, a fresh token and a fresh idempotency key.
  await admin.from('invitation_deliveries')
    .update({ status: 'failed', error_class: send.errorClass ?? 'provider_error' }).eq('id', claim.id)
  return false
}
