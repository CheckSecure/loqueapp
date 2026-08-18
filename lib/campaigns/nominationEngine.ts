import { normalizeEmail } from '@/lib/auth/normalizeEmail'
import { isValidEmailFormat } from '@/lib/invitations/changeInviteEmail'

/**
 * Generalized nomination-campaign engine — the security-reviewed machinery extracted from the
 * James Kahrs campaign so a second campaign is a small DATA definition, never a forked
 * implementation. Behaviour for James is unchanged: lib/campaigns/jamesNomination.ts now supplies
 * the same definition and re-exports a bound runner, so its route and tests are untouched.
 *
 * The James campaign has ALREADY EXECUTED in production, so this extraction had to be provably
 * inert against live rows: identical campaign key, recipients, email bytes, CC behaviour and
 * delivery-claim purposes. Nothing in this module may change those, and a re-run must recognize
 * every previously-invited recipient rather than re-sending.
 *
 * What a campaign definition may vary: key, nominator, referral note, recipient list, whether the
 * nominator is courtesy-copied, and the email subject/intro sentence. What it may NEVER vary — and
 * therefore lives only here — is the safety machinery:
 *
 *   IDEMPOTENCY AUTHORITY: the invitation_deliveries active claim ((waitlist_id, purpose) unique with
 *   a 24h stale-claim lease). A succeeded recipient is NEVER resent; a definite failure is re-claimable;
 *   an AMBIGUOUS dispatch is never auto-resent and surfaces for manual review.
 *   RECIPIENT BINDING: one individual secure link per nominee; no two nominees ever share a To/CC/BCC.
 *   PREFLIGHT: every recipient is classified read-only (auth/profile/waitlist/delivery) before any write,
 *   so a duplicate account or an overlapping active invitation can never be created.
 *   OUTPUT: masked + aggregate only — never a link, token, secret, raw provider payload, or full address.
 *   The nominator is never a recipient (enforced at definition time AND again in the loop).
 */

export interface NominationRecipient {
  /** Greeting name used in the email body. */
  firstName: string
  /** Full name for the waitlist record, when known. Falls back to firstName. */
  fullName?: string
  email: string
}

export interface NominationCampaign {
  /** Unique, immutable key for this campaign. */
  campaignKey: string
  nominator: {
    name: string
    email: string
    /**
     * The nominator's REAL profile UUID, when confirmed. Optional: when absent the route resolves it
     * server-side by email at run time, and attribution is skipped (logged) if no profile exists.
     * A UUID is never invented, and a missing one never blocks or fails an invitation.
     */
    userId?: string
  }
  referralNote: string
  recipients: NominationRecipient[]
  /** Courtesy-copy the nominator on every invite. Per-campaign: some nominators must NOT be copied. */
  ccNominator: boolean
  email: {
    subject: string
    /** The one sentence describing Andrel, after "<Nominator> invited you to join Andrel, ". */
    intro: string
  }
}

/**
 * Build a campaign definition safely: normalize + dedupe addresses, drop the nominator if present,
 * and assert the exact expected recipient count. `expectedRecipients` is a hard tripwire — if a list
 * is ever edited (an extra address, a wildcard, a bulk paste) the module fails to load rather than
 * silently sending to more people than were approved.
 */
export function defineNominationCampaign(
  input: Omit<NominationCampaign, 'nominator' | 'recipients'> & {
    nominator: NominationCampaign['nominator']
    recipients: NominationRecipient[]
    expectedRecipients: number
  },
): NominationCampaign {
  const nominatorEmail = normalizeEmail(input.nominator.email)
  const seen = new Set<string>()
  const recipients: NominationRecipient[] = []
  for (const r of input.recipients) {
    const email = normalizeEmail(r.email)
    if (!email || email === nominatorEmail) continue // the nominator can never be a recipient
    if (seen.has(email)) continue
    seen.add(email)
    recipients.push({ firstName: r.firstName.trim(), ...(r.fullName ? { fullName: r.fullName.trim() } : {}), email })
  }
  if (recipients.length !== input.expectedRecipients) {
    throw new Error(
      `[${input.campaignKey}] recipient count ${recipients.length} does not match the approved ${input.expectedRecipients}`,
    )
  }
  return {
    campaignKey: input.campaignKey,
    nominator: { ...input.nominator, email: nominatorEmail },
    referralNote: input.referralNote,
    recipients,
    ccNominator: input.ccNominator,
    email: input.email,
  }
}

/** first char + masked local + domain, e.g. b***@sourceamerica.org. Never the full local part. */
export function maskEmail(email: string): string {
  const [local, domain] = normalizeEmail(email).split('@')
  if (!domain) return '***'
  return `${(local[0] ?? '')}***@${domain}`
}

// Precise classification — every non-'ready' state must be reviewed by the operator before a send.
export type Classification =
  | 'ready' | 'already_member' | 'active_invite_exists' | 'previously_declined' | 'previously_revoked'
  | 'prior_delivery_failed' | 'suppressed' | 'conflict' | 'invalid'
export type RecipientOutcome =
  | Classification | 'sent' | 'already_processed' | 'ambiguous_review' | 'send_failed' | 'unavailable'
  | 'skipped_paused' | 'skipped_not_allowlisted' | 'skipped_not_selected'

export interface DeliveryState { suppressed: boolean; failed: boolean; active: boolean }

export interface NominationDeps {
  lookupAuth: (email: string) => Promise<{ count: number; user: { id: string; last_sign_in_at: string | null } | null }>
  hasProfile: (userId: string) => Promise<boolean>
  findWaitlist: (email: string) => Promise<{ id: string; status: string } | null>
  deliveryState: (email: string) => Promise<DeliveryState>
  /** Second arg is the recipient's full name when known, else their first name. */
  ensureWaitlist: (email: string, name: string) => Promise<string | null>
  /**
   * Write/ensure the referrals attribution row (nominator profile → nominee waitlist). Pre-send.
   * `nominatorUserId` is null when the nominator has no confirmed profile: the implementation must
   * then SKIP attribution (and log it) — never fabricate an id, never block the invitation.
   */
  ensureReferral: (nominatorUserId: string | null, waitlistId: string) => Promise<void>
  /** Reuses secureInvite (invitation_deliveries claim = send authority) + the nomination email. */
  sendInvite: (a: { email: string; firstName: string; waitlistId: string }) => Promise<{ sent: boolean; state: string; deliveryId: string | null; errorClass?: string }>
  canSend: (email: string) => boolean
  mode: () => 'off' | 'test' | 'on'
  log: (event: string, fields?: Record<string, unknown>) => void
}

/** READ-ONLY preflight — precise current-state classification (dry-run AND execute, before any write). */
export async function classifyRecipient(deps: NominationDeps, email: string): Promise<Classification> {
  const e = normalizeEmail(email)
  if (!e || !isValidEmailFormat(e)) return 'invalid'

  const auth = await deps.lookupAuth(e)
  if (auth.count > 1) return 'conflict'
  const authUser = auth.count === 1 ? auth.user : null
  if (authUser && (!!authUser.last_sign_in_at || (await deps.hasProfile(authUser.id)))) return 'already_member'

  const ds = await deps.deliveryState(e)
  if (ds.suppressed) return 'suppressed'                 // account-suppressed / complained / blocked
  if (ds.failed) return 'prior_delivery_failed'          // bounced / failed — review before retry

  const wl = await deps.findWaitlist(e)
  if (wl?.status === 'revoked') return 'previously_revoked'
  if (wl?.status === 'declined') return 'previously_declined'

  if (ds.active) return 'active_invite_exists'           // an in-flight/accepted/delivered invite exists
  if (authUser) return 'active_invite_exists'            // a prior invite minted a (not-activated) auth user
  if (wl?.status === 'invited') return 'active_invite_exists'
  return 'ready'
}

export interface RecipientResult { firstName: string; emailMasked: string; classification: Classification; outcome: RecipientOutcome }
export interface CampaignResult {
  dryRun: boolean; mode: 'off' | 'test' | 'on'; campaignKey: string; total: number
  summary: Record<string, number>; recipients: RecipientResult[]
}

// Failure-stage policy (at-most-once): a DEFINITE pre/at-dispatch failure ('error' — link generation
// failed, or the provider DEFINITELY rejected without accepting) is safely retryable. An AMBIGUOUS
// result (provider outcome unknown after dispatch: timeout, or a stale still-'claimed' row that the
// provider may already have accepted) is NEVER auto-resent — it surfaces for manual review.
function outcomeForSend(send: { sent: boolean; state: string }): RecipientOutcome {
  if (send.sent || send.state === 'invited' || send.state === 'link_sent') return 'sent'
  if (send.state === 'pending') return 'already_processed'                       // in-flight active claim; no resend
  if (send.state === 'uncertain' || send.state === 'needs_review') return 'ambiguous_review' // maybe accepted → manual review, NEVER auto-resend
  if (send.state === 'unavailable') return 'unavailable'
  return 'send_failed' // definite pre/at-dispatch failure → safe to retry (no email was accepted)
}

/**
 * Run a campaign. `dryRun` performs every validation but creates/sends NOTHING. Execute processes only
 * 'ready' recipients (mode-gated): attribution (referrals) FIRST, then the individual secure invite —
 * idempotent via the invitation_deliveries claim (succeeded recipients never resent; failures retry).
 *
 * `only` (execute-mode single-recipient test) restricts SENDING to that ONE normalized email — it MUST
 * already be a member of the campaign's fixed recipient list (the route validates this before calling).
 * Every other recipient is still classified (read-only) but never sent, recorded as
 * `skipped_not_selected`. `only` has NO effect on a dry run. One recipient's failure never aborts the
 * run — each is independent. Returns masked, aggregate results — never a link/token/secret/raw error.
 */
export async function runNominationCampaign(
  campaign: NominationCampaign,
  deps: NominationDeps,
  opts: { dryRun: boolean; only?: string },
): Promise<CampaignResult> {
  const mode = deps.mode()
  const recipients: RecipientResult[] = []
  const only = opts.only ? normalizeEmail(opts.only) : null

  for (const r of campaign.recipients) {
    if (r.email === campaign.nominator.email) continue // never the nominator (defense in depth)
    const classification = await classifyRecipient(deps, r.email)
    let outcome: RecipientOutcome = classification

    // Execute-mode single-recipient test: classify everyone (read-only) but SEND only the selected one.
    if (!opts.dryRun && only && r.email !== only) {
      recipients.push({ firstName: r.firstName, emailMasked: maskEmail(r.email), classification, outcome: 'skipped_not_selected' })
      deps.log('nomination_recipient', { classification, outcome: 'skipped_not_selected' })
      continue
    }

    if (!opts.dryRun && classification === 'ready') {
      if (mode === 'off') outcome = 'skipped_paused'
      else if (!deps.canSend(r.email)) outcome = 'skipped_not_allowlisted'
      else {
        const waitlistId = await deps.ensureWaitlist(r.email, r.fullName ?? r.firstName)
        if (!waitlistId) outcome = 'unavailable'
        else {
          await deps.ensureReferral(campaign.nominator.userId ?? null, waitlistId) // ATTRIBUTION before send (crash-safe)
          const send = await deps.sendInvite({ email: r.email, firstName: r.firstName, waitlistId })
          outcome = outcomeForSend(send)
        }
      }
    }

    recipients.push({ firstName: r.firstName, emailMasked: maskEmail(r.email), classification, outcome })
    deps.log('nomination_recipient', { classification, outcome }) // coarse only — no email/name/link/token
  }

  const summary: Record<string, number> = {}
  for (const x of recipients) summary[x.outcome] = (summary[x.outcome] ?? 0) + 1
  return { dryRun: opts.dryRun, mode, campaignKey: campaign.campaignKey, total: campaign.recipients.length, summary, recipients }
}
