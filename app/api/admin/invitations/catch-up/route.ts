import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { lookupAuthUsersByEmail } from '@/lib/invitations'
import { sendSecureInviteForWaitlist } from '@/lib/invitations/sendForWaitlist'
import { inviteStatusModel } from '@/lib/waitlist/inviteStatus'
import { canSendInvitation, invitationsEnabled, INVITATIONS_PAUSED_MESSAGE } from '@/lib/invitations/featureGate'
import { getSiteUrl } from '@/lib/config/siteUrl'
import { checkEmailSanity } from '@/lib/waitlist/emailSanity'

/**
 * INVITATION CATCH-UP — re-send to people whose first invitation expired unused.
 *
 * The cohort this was built for: invitees from before migration 078 (2026-08-23), whose email
 * carried a Supabase authentication link and NOTHING ELSE. That link expires by design, and until
 * 078 there was no durable resume token, so once it lapsed the recipient had no route back in at
 * all — no fallback link, no self-serve resend. They are not unresponsive; they were locked out.
 *
 * Every send goes through sendSecureInviteForWaitlist, which reuses the same hardened ceremony as
 * /api/admin/send-invite: pre-send atomic delivery claim, one provider call under a stable
 * idempotency key, hashed_token only, and the link handed to nothing but the email sender. This
 * route deliberately re-implements NONE of that.
 *
 * DRY RUN IS THE DEFAULT. `action` must be the literal string 'execute' to send anything; every
 * other value, including a missing one, lists what would happen and sends nothing.
 */
export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/** Hard ceiling per invocation, so a mistake in the filter cannot mail the entire waitlist. */
const MAX_PER_RUN = 50

type Verdict =
  | 'would_send'
  | 'sent'
  | 'send_failed'
  | 'blocked_delivery_pending'   // provider outcome still unknown — resending risks a duplicate
  | 'blocked_bad_address'        // bounced/blocked/complained — fix the address first
  | 'skipped_already_activated'  // they got in; nothing to do
  | 'skipped_ambiguous_account'  // duplicate auth users for one address — manual review
  | 'blocked_suspect_address'    // looks mistyped — one send, one permanent bounce
  | 'skipped_not_invited'
  | 'skipped_paused'

interface Row {
  waitlistId: string
  email: string
  fullName: string | null
  invitedAt: string | null
  deliveryStatus: string | null
  deliveryLabel: string
  referrerName: string | null
  /**
   * WHY referrerName is what it is. Without this, "null" conflates three different situations —
   * not a referral, referrer withheld consent, and the lookup failed — and only one of them is a
   * bug. That ambiguity is exactly what made the first dry run unreadable.
   */
  referrerLookup: 'named' | 'no_consent' | 'not_a_referral' | 'lookup_failed'
  verdict: Verdict
  detail?: string
  /** Set when the address looks mistyped. Never applied automatically. */
  addressSuggestion?: string
}

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { action?: unknown; limit?: unknown; waitlistIds?: unknown; onlyReferred?: unknown } = {}
  try { body = await req.json() } catch { /* empty body → dry run */ }

  // Anything other than the exact string 'execute' is a dry run. A typo sends nothing.
  const execute = body.action === 'execute'
  const limit = Math.min(
    MAX_PER_RUN,
    Math.max(1, Number.isFinite(Number(body.limit)) ? Number(body.limit) : MAX_PER_RUN),
  )
  const only = Array.isArray(body.waitlistIds)
    ? new Set(body.waitlistIds.filter((v): v is string => typeof v === 'string'))
    : null
  // Restrict to people a member actually nominated. The invited waitlist also contains everyone
  // invited directly by an operator, who are a different audience entirely and must be decided on
  // separately — the first version of this route did not make that distinction and swept up 257.
  const onlyReferred = body.onlyReferred === true

  const admin = createAdminClient()
  const siteUrl = getSiteUrl()
  const nowMs = Date.now()

  // Candidates: invited, never completed. profile_complete lives on profiles, so the join happens
  // below via the auth lookup — the waitlist row alone cannot answer "did they get in".
  const { data: waitlistRows, error: waitlistError } = await admin
    .from('waitlist')
    .select('id, email, full_name, status, invited_at')
    .eq('status', 'invited')
    .not('invited_at', 'is', null)
    .order('invited_at', { ascending: true })
  if (waitlistError) {
    console.error('[invitations/catch-up] waitlist read failed:', waitlistError)
    return NextResponse.json({ error: 'Could not load the invitation list' }, { status: 503 })
  }

  // ONE referral query for the whole set, not one per row. Besides the obvious N+1, the per-row
  // version destructured only `data` — so a failed query was indistinguishable from "no consent"
  // and every row silently reported no referrer. The error is now read and reported per row.
  const { data: referralRows, error: referralError } = await admin
    .from('referrals')
    .select('waitlist_id, referrer_consent_to_share, referrer:profiles!referrer_user_id(full_name)')
  if (referralError) {
    console.error('[invitations/catch-up] referral read failed:', referralError)
  }
  const referralByWaitlist = new Map<string, { consent: boolean; name: string | null }>()
  for (const r of (referralRows ?? []) as any[]) {
    referralByWaitlist.set(r.waitlist_id, {
      consent: r.referrer_consent_to_share === true,
      name: (r.referrer?.full_name as string | null) ?? null,
    })
  }

  const candidates = (waitlistRows ?? [])
    .filter((w: any) => !only || only.has(w.id))
    .filter((w: any) => !onlyReferred || referralByWaitlist.has(w.id))
  const rows: Row[] = []
  let sent = 0

  for (const w of candidates) {
    if (rows.filter((r) => r.verdict === 'would_send' || r.verdict === 'sent').length >= limit) break

    const email: string = w.email

    // Resolved FIRST so every exit path below can report it. Named ONLY where the referrer
    // explicitly ticked the box: referrer_consent_to_share is NOT NULL DEFAULT false and the
    // form's checkbox is unchecked by default, so an absent name is usually a real choice rather
    // than a fault — and the campaign email promised that choice would be honored.
    const referral = referralByWaitlist.get(w.id)
    const referrerName = referral?.consent ? referral.name : null
    const referrerLookup: Row['referrerLookup'] =
      referralError ? 'lookup_failed'
      : !referral ? 'not_a_referral'
      : !referral.consent ? 'no_consent'
      : referrerName ? 'named'
      : 'no_consent' // consented, but the referrer profile has no name to show

    const base = {
      waitlistId: w.id as string,
      email,
      fullName: (w.full_name ?? null) as string | null,
      invitedAt: (w.invited_at ?? null) as string | null,
      referrerName,
      referrerLookup,
    }

    // ── Already in? ────────────────────────────────────────────────────────────
    let auth: { count: number; user: { id: string; last_sign_in_at: string | null } | null }
    try {
      auth = await lookupAuthUsersByEmail(admin, email)
    } catch {
      rows.push({ ...base, deliveryStatus: null, deliveryLabel: '—',
        verdict: 'skipped_ambiguous_account', detail: 'auth lookup failed' })
      continue
    }
    if (auth.count > 1) {
      rows.push({ ...base, deliveryStatus: null, deliveryLabel: '—',
        verdict: 'skipped_ambiguous_account', detail: 'more than one account for this address' })
      continue
    }
    let profileComplete = false
    if (auth.user) {
      const { data: prof } = await admin
        .from('profiles').select('profile_complete').eq('id', auth.user.id).maybeSingle()
      profileComplete = !!prof?.profile_complete
      if (profileComplete || auth.user.last_sign_in_at) {
        rows.push({ ...base, deliveryStatus: null, deliveryLabel: '—',
          verdict: 'skipped_already_activated',
          detail: profileComplete ? 'profile complete' : 'has signed in at least once' })
        continue
      }
    }

    // ── Is a resend safe right now? ────────────────────────────────────────────
    // The SAME model the admin panel renders, so the dry run and the UI can never disagree about
    // who is resendable. A row still awaiting a provider result is left alone: resending inside
    // that window is how one person receives two links.
    const { data: delivery } = await admin
      .from('invitation_deliveries')
      .select('status, attempted_at')
      .eq('waitlist_id', w.id)
      .order('attempted_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const model = inviteStatusModel({
      waitlistStatus: w.status,
      invitedAt: w.invited_at ?? null,
      profileComplete,
      delivery: delivery ? { status: delivery.status, attemptedAt: delivery.attempted_at } : null,
      nowMs,
    })
    const resendable = model.canResend || model.canRetry || model.needsConfirmResend

    const common = {
      ...base,
      deliveryStatus: delivery?.status ?? null,
      deliveryLabel: model.label,
    }

    if (!resendable) {
      const bad = ['bounced', 'blocked', 'complained'].includes(delivery?.status ?? '')
      rows.push({ ...common,
        verdict: bad ? 'blocked_bad_address' : 'blocked_delivery_pending',
        detail: model.tooltip })
      continue
    }
    if (!invitationsEnabled() || !canSendInvitation(email)) {
      rows.push({ ...common, verdict: 'skipped_paused', detail: INVITATIONS_PAUSED_MESSAGE })
      continue
    }

    // ── Does the address look real? ────────────────────────────────────────────
    // A nominator typed this on someone else's behalf, and an invitation is sent once. A mistyped
    // domain produces a permanent bounce that reads exactly like "they ignored us", while the
    // person who was recommended never learns of it. Flagged for review, never auto-corrected.
    const sanity = checkEmailSanity(email)
    if (sanity.suspect) {
      rows.push({ ...common, verdict: 'blocked_suspect_address', detail: sanity.reason,
        ...(sanity.suggestion ? { addressSuggestion: sanity.suggestion } : {}) })
      continue
    }

    if (!execute) {
      rows.push({ ...common, verdict: 'would_send' })
      continue
    }

    // ── Send ───────────────────────────────────────────────────────────────────
    try {
      const result = await sendSecureInviteForWaitlist(admin, {
        waitlistId: w.id,
        email,
        fullName: w.full_name ?? null,
        siteUrl,
        referrerName,
      })
      if (result.sent) {
        sent++
        rows.push({ ...common, verdict: 'sent' })
      } else {
        // result.message is admin-facing by contract and never carries a token or link.
        rows.push({ ...common, verdict: 'send_failed', detail: result.message ?? result.state })
      }
    } catch (e: any) {
      console.error('[invitations/catch-up] send threw', JSON.stringify({ waitlistId: w.id, name: e?.name }))
      rows.push({ ...common, verdict: 'send_failed', detail: 'unexpected error' })
    }
  }

  const summary = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1
    return acc
  }, {})

  return NextResponse.json({
    mode: execute ? 'execute' : 'dry_run',
    // Say plainly WHO was considered. The response previously reported only a count, and a count
    // of 257 looks the same whether it is the intended audience or the entire waitlist.
    scope: onlyReferred ? 'referred nominees only' : 'ALL invited waitlist rows (referred + direct)',
    onlyReferred,
    invitedWaitlistTotal: (waitlistRows ?? []).length,
    referredAmongThem: (waitlistRows ?? []).filter((w: any) => referralByWaitlist.has(w.id)).length,
    considered: candidates.length,
    limit,
    sent,
    summary,
    rows,
  })
}
