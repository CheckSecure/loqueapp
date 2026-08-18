import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'
import { createAdminClient } from '@/lib/supabase/admin'
import { lookupAuthUsersByEmail } from '@/lib/invitations'
import { sendSecureInvite, type SecureInviteDeps } from '@/lib/invitations/secureInvite'
import { claimInviteDelivery, markDeliveryAccepted, markDeliveryFailed } from '@/lib/invitations/delivery'
import { sendNominationInviteEmail } from '@/lib/email'
import { canSendInvitation, invitationsMode } from '@/lib/invitations/featureGate'
import { getSiteUrl, getRecoveryRedirectUrl } from '@/lib/config/siteUrl'
import { normalizeEmail } from '@/lib/auth/normalizeEmail'
import { runNominationCampaign, type NominationCampaign, type NominationDeps } from '@/lib/campaigns/nominationEngine'
import { evaluateNominator, NOMINATOR_GATE_ERROR, type NominatorGateResult } from '@/lib/campaigns/nominatorGate'

/**
 * Shared admin nomination-campaign request handler — the single, security-reviewed implementation
 * behind every campaign route, so adding a campaign is a data definition plus a three-line route.
 *
 * FAIL-CLOSED ORDER: same-origin → admin → JSON content type → strict body shape. Recipients are
 * ALWAYS the campaign's server-owned list; no client list, array, wildcard, or bulk expansion is
 * ever accepted. The body is one of exactly THREE strict shapes; everything else is a 400:
 *   { dryRun: true }                                     → preview; creates + sends NOTHING.
 *   { dryRun: false, testRecipient: "<one list email>" } → send ONLY that one nominee.
 *   { dryRun: false, confirmFullCampaign: true }         → full production send.
 * A bare { dryRun: false }, an unknown/extra key, an array, a testRecipient outside the fixed list,
 * or confirmFullCampaign that is not exactly true → 400 and nothing runs. INVITATIONS_MODE still
 * applies. Responses are masked + aggregate — never a link, token, secret, raw provider payload, or
 * full address, in either the body or the logs.
 */

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: any, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })
const bad = (m: string) => json({ error: m }, 400)
const likeLiteral = (s: string) => s.replace(/([\\%_])/g, '\\$1')
const ALLOWED_KEYS = new Set(['dryRun', 'testRecipient', 'confirmFullCampaign'])

export async function handleNominationCampaignRequest(
  req: Request,
  campaign: NominationCampaign,
  logPrefix: string,
): Promise<NextResponse> {
  const crossOrigin = assertSameOrigin(req)
  if (crossOrigin) return crossOrigin
  const { error } = await requireAdmin()
  if (error) return error
  if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    return bad('Content-Type must be application/json')
  }

  let body: any
  try { body = await req.json() } catch { return bad('Invalid JSON body') }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return bad('Body must be an object')
  if (Object.keys(body).some((k) => !ALLOWED_KEYS.has(k))) return bad('Only { dryRun, testRecipient, confirmFullCampaign } are accepted')
  if ('dryRun' in body && typeof body.dryRun !== 'boolean') return bad('dryRun must be a boolean')
  const dryRun = body.dryRun !== false // execute requires an explicit dryRun:false

  let only: string | undefined
  if (dryRun) {
    if ('testRecipient' in body || 'confirmFullCampaign' in body) return bad('A dry run accepts no other fields')
  } else {
    const hasTest = 'testRecipient' in body
    const hasFull = 'confirmFullCampaign' in body
    if (hasTest === hasFull) return bad('Execute requires exactly one of testRecipient or confirmFullCampaign')
    if (hasTest) {
      if (typeof body.testRecipient !== 'string') return bad('testRecipient must be a string')
      const target = normalizeEmail(body.testRecipient)
      if (!target || !campaign.recipients.some((r) => r.email === target)) {
        return bad('testRecipient must exactly match one fixed campaign recipient')
      }
      only = target
    } else if (body.confirmFullCampaign !== true) {
      return bad('confirmFullCampaign must be exactly true for a full send')
    }
  }

  const admin = createAdminClient()

  // FAIL CLOSED before EXECUTE: the multi-recipient safety marker (migration 054) must exist. The
  // delivery claim writes has_additional_recipients on every send, so this is required whether or not
  // this campaign copies the nominator. Dry-run needs no writes, so it is allowed through.
  if (!dryRun) {
    const { error: ccColErr } = await admin.from('invitation_deliveries').select('has_additional_recipients').limit(1)
    if (ccColErr) return json({ error: 'Multi-recipient safety column unavailable (migration 054 not applied). Nothing was sent.' }, 503)
  }

  const log = (event: string, fields?: Record<string, unknown>) =>
    console.log(logPrefix, JSON.stringify({ event, ...(fields ?? {}) }))

  /**
   * FAIL-CLOSED NOMINATOR GATE — runs BEFORE any recipient is classified, mutated, or emailed.
   *
   * The invitation asserts "<Nominator> invited you", so the nominator must be provably exactly one
   * valid, active profile. Resolution uses the campaign's confirmed UUID when it has one, otherwise
   * the SERVER-OWNED nominator email at run time — never a hardcoded id and never a client value.
   * A missing, ambiguous, inactive, or unreadable nominator fails the campaign outright: no auth
   * user, no waitlist row, no delivery claim, no referral row, no email.
   */
  const resolveNominatorGate = async (): Promise<NominatorGateResult> => {
    const sel = 'id, account_status'
    if (campaign.nominator.userId) {
      // Confirmed id: still verify it exists and is active (defense in depth).
      const { data, error: e } = await admin.from('profiles').select(sel).eq('id', campaign.nominator.userId).limit(2)
      return evaluateNominator(data as any, e)
    }
    const { data, error: e } = await admin.from('profiles').select(sel).ilike('email', likeLiteral(campaign.nominator.email)).limit(2)
    return evaluateNominator(data as any, e)
  }

  const gate = await resolveNominatorGate()
  if (!gate.ok) {
    // Coarse only — no email, no UUID, no profile data ever leaves this branch.
    log('nominator_gate_failed', { reason: gate.reason, dryRun })
    if (!dryRun) return json({ error: NOMINATOR_GATE_ERROR, nominatorVerified: false, reason: gate.reason }, 409)
  }
  const nominatorUserId = gate.ok ? gate.userId : null

  const deps: NominationDeps = {
    lookupAuth: (e) => lookupAuthUsersByEmail(admin, e),
    hasProfile: async (uid) => { const { data } = await admin.from('profiles').select('id').eq('id', uid).maybeSingle(); return !!data },
    findWaitlist: async (e) => {
      const { data } = await admin.from('waitlist').select('id, status').ilike('email', likeLiteral(e)).limit(1).maybeSingle()
      return data ? { id: data.id, status: data.status } : null
    },
    deliveryState: async (e) => {
      const { data } = await admin.from('invitation_deliveries').select('status').eq('recipient_email', e)
      const s = new Set((data ?? []).map((r: any) => r.status))
      return {
        suppressed: s.has('complained') || s.has('blocked'),
        failed: s.has('bounced') || s.has('failed'),
        active: ['claimed', 'accepted', 'delivered', 'deferred'].some((x) => s.has(x)),
      }
    },
    ensureWaitlist: async (e, name) => {
      const { data, error: insErr } = await admin.from('waitlist')
        .insert({ email: e, full_name: name, referral_source: 'nomination', status: 'approved' })
        .select('id').single()
      if (!insErr && data?.id) return data.id
      const { data: existing } = await admin.from('waitlist').select('id').ilike('email', likeLiteral(e)).limit(1).maybeSingle()
      return existing?.id ?? null
    },
    ensureReferral: async (_campaignUserId, waitlistId) => {
      // The gate above guarantees a verified nominator on every EXECUTE path, so attribution is
      // never silently skipped. Idempotent: exactly one referral row per nominee waitlist row, so a
      // retry can never duplicate it.
      if (!nominatorUserId) throw new Error('nominator not verified') // unreachable on execute
      const { data: existing } = await admin.from('referrals').select('id').eq('waitlist_id', waitlistId).limit(1).maybeSingle()
      if (existing) return
      await admin.from('referrals').insert({
        referrer_user_id: nominatorUserId, waitlist_id: waitlistId, referral_note: campaign.referralNote, status: 'pending',
      })
    },
    sendInvite: async ({ email, firstName, waitlistId }) => {
      const inviteDeps: SecureInviteDeps = {
        siteUrl: getSiteUrl(),
        lookupAuth: (x) => lookupAuthUsersByEmail(admin, x),
        hasProfile: async (uid) => { const { data } = await admin.from('profiles').select('id').eq('id', uid).maybeSingle(); return !!data },
        // The claim records only the FACT of an additional recipient (has_additional_recipients) —
        // NO CC address is ever stored on invitation_deliveries. False for campaigns with no CC.
        claimDelivery: (purpose, authUserId) => claimInviteDelivery(admin, {
          waitlistId, authUserId, email, purpose, hasAdditionalRecipients: campaign.ccNominator,
        }),
        markAccepted: (id, msgId, authUserId) => markDeliveryAccepted(admin, id, msgId, authUserId),
        markFailed: (id, ec) => markDeliveryFailed(admin, id, ec),
        generateLink: async (type, x) => {
          const options: any = { redirectTo: getRecoveryRedirectUrl() }
          const { data, error: ge } = await admin.auth.admin.generateLink({ type, email: x, options } as any)
          const hashedToken = (data as any)?.properties?.hashed_token
          if (ge || !hashedToken) throw new Error('generateLink failed')
          return { hashedToken, userId: (data as any)?.user?.id ?? null }
        },
        sendEmail: (a) => sendNominationInviteEmail({
          to: a.to,
          // cc is OMITTED entirely unless this campaign copies the nominator.
          ...(campaign.ccNominator ? { cc: campaign.nominator.email } : {}),
          firstName,
          link: a.link,
          idempotencyKey: a.idempotencyKey,
          nominatorName: campaign.nominator.name,
          intro: campaign.email.intro,
          subject: campaign.email.subject,
        }),
      }
      const result = await sendSecureInvite(inviteDeps, { email, fullName: firstName, waitlistId })
      if (result.state === 'invited' || result.state === 'link_sent') {
        await admin.from('waitlist').update({ status: 'invited', invited_at: new Date().toISOString() }).eq('id', waitlistId)
        await admin.from('referrals').update({ status: 'invited' }).eq('waitlist_id', waitlistId)
      }
      return { sent: !!result.sent, state: result.state, deliveryId: result.deliveryId ?? null, errorClass: result.errorClass }
    },
    canSend: (e) => canSendInvitation(e),
    mode: () => invitationsMode(),
    log,
  }

  const result = await runNominationCampaign(campaign, deps, { dryRun, only })
  log('campaign_complete', { dryRun: result.dryRun, mode: result.mode, singleRecipient: !!only, nominatorVerified: gate.ok, summary: result.summary })
  // A dry run reports the nominator status so the operator sees a problem BEFORE executing.
  return json({ success: true, nominatorVerified: gate.ok, ...(gate.ok ? {} : { nominatorReason: gate.reason }), ...result })
}

export const methodNotAllowed = () => json({ error: 'Method not allowed' }, 405)
