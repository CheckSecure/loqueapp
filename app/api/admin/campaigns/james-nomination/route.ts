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
import { runNominationCampaign, NOMINATOR, REFERRAL_NOTE, RECIPIENTS, type NominationDeps } from '@/lib/campaigns/jamesNomination'
import { normalizeEmail } from '@/lib/auth/normalizeEmail'

/**
 * Admin-only James Kahrs nomination campaign. FIXED server-side recipients (no client list). POST-only,
 * same-origin, admin-authorized, JSON, no-store. Attribution = referrals (James's real profile → nominee
 * waitlist); send idempotency = invitation_deliveries claim. Response is masked + aggregate — never a
 * link/token/secret. The body is one of exactly THREE strict shapes; everything else FAILS CLOSED:
 *   { dryRun: true }                                  → preview all 12; creates + sends NOTHING.
 *   { dryRun: false, testRecipient: "<one list email>" } → send ONLY that one nominee (CC James).
 *   { dryRun: false, confirmFullCampaign: true }      → full production send of all 12.
 * A bare { dryRun: false } (no selector), an unknown/extra field, an array, a testRecipient not in the
 * fixed list, or confirmFullCampaign that is not exactly true → 400 (nothing runs). INVITATIONS_MODE
 * still applies; the single-recipient test needs NO env-var change.
 */

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: any, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })
const bad = (m: string) => json({ error: m }, 400)
const likeLiteral = (s: string) => s.replace(/([\\%_])/g, '\\$1')
const ALLOWED_KEYS = new Set(['dryRun', 'testRecipient', 'confirmFullCampaign'])

export async function POST(req: Request) {
  const crossOrigin = assertSameOrigin(req)
  if (crossOrigin) return crossOrigin
  const { error } = await requireAdmin()
  if (error) return error
  if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return bad('Content-Type must be application/json')

  let body: any
  try { body = await req.json() } catch { return bad('Invalid JSON body') }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return bad('Body must be an object')
  if (Object.keys(body).some((k) => !ALLOWED_KEYS.has(k))) return bad('Only { dryRun, testRecipient, confirmFullCampaign } are accepted')
  if ('dryRun' in body && typeof body.dryRun !== 'boolean') return bad('dryRun must be a boolean')
  const dryRun = body.dryRun !== false // execute requires an explicit dryRun:false

  // Strict shape validation. A dry run is a bare preview; an execute must carry EXACTLY ONE selector —
  // a single-recipient test address (in the fixed list) OR confirmFullCampaign:true. Fail closed otherwise.
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
      if (!target || !RECIPIENTS.some((r) => r.email === target)) return bad('testRecipient must exactly match one fixed campaign recipient')
      only = target
    } else if (body.confirmFullCampaign !== true) {
      return bad('confirmFullCampaign must be exactly true for a full send')
    }
  }

  const admin = createAdminClient()

  // FAIL CLOSED before EXECUTE: the multi-recipient safety marker (migration 054) must exist, else a
  // CC (nominator) bounce could be mis-attributed to the nominee. Dry-run needs no writes, so it is allowed.
  if (!dryRun) {
    const { error: ccColErr } = await admin.from('invitation_deliveries').select('has_additional_recipients').limit(1)
    if (ccColErr) return json({ error: 'Multi-recipient safety column unavailable (migration 054 not applied). Nothing was sent.' }, 503)
  }

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
    ensureWaitlist: async (e, firstName) => {
      const { data, error: insErr } = await admin.from('waitlist')
        .insert({ email: e, full_name: firstName, referral_source: 'nomination', status: 'approved' })
        .select('id').single()
      if (!insErr && data?.id) return data.id
      const { data: existing } = await admin.from('waitlist').select('id').ilike('email', likeLiteral(e)).limit(1).maybeSingle()
      return existing?.id ?? null
    },
    ensureReferral: async (nominatorUserId, waitlistId) => {
      // Idempotent: one referral per nominee waitlist row. Records James (real profile) as the nominator.
      const { data: existing } = await admin.from('referrals').select('id').eq('waitlist_id', waitlistId).limit(1).maybeSingle()
      if (existing) return
      await admin.from('referrals').insert({
        referrer_user_id: nominatorUserId, waitlist_id: waitlistId, referral_note: REFERRAL_NOTE, status: 'pending',
      })
    },
    sendInvite: async ({ email, firstName, waitlistId }) => {
      const inviteDeps: SecureInviteDeps = {
        siteUrl: getSiteUrl(),
        lookupAuth: (x) => lookupAuthUsersByEmail(admin, x),
        hasProfile: async (uid) => { const { data } = await admin.from('profiles').select('id').eq('id', uid).maybeSingle(); return !!data },
        // The email CCs the nominator (below); the claim records only the FACT of an additional recipient
        // (has_additional_recipients) — NO CC address is stored on invitation_deliveries. Webhook fail-safe.
        claimDelivery: (purpose, authUserId) => claimInviteDelivery(admin, { waitlistId, authUserId, email, purpose, hasAdditionalRecipients: true }),
        markAccepted: (id, msgId, authUserId) => markDeliveryAccepted(admin, id, msgId, authUserId),
        markFailed: (id, ec) => markDeliveryFailed(admin, id, ec),
        generateLink: async (type, x) => {
          const options: any = { redirectTo: getRecoveryRedirectUrl() }
          const { data, error: ge } = await admin.auth.admin.generateLink({ type, email: x, options } as any)
          const hashedToken = (data as any)?.properties?.hashed_token
          if (ge || !hashedToken) throw new Error('generateLink failed')
          return { hashedToken, userId: (data as any)?.user?.id ?? null }
        },
        sendEmail: (a) => sendNominationInviteEmail({ to: a.to, cc: NOMINATOR.email, firstName, link: a.link, idempotencyKey: a.idempotencyKey }),
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
    log: (event, fields) => console.log('[james-nomination]', JSON.stringify({ event, ...(fields ?? {}) })),
  }

  const result = await runNominationCampaign(deps, { dryRun, only })
  console.log('[james-nomination]', JSON.stringify({ event: 'campaign_complete', dryRun: result.dryRun, mode: result.mode, singleRecipient: !!only, summary: result.summary }))
  return json({ success: true, ...result })
}

export async function GET() {
  return json({ error: 'Method not allowed' }, 405)
}
