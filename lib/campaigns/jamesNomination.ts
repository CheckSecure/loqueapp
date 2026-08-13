import { normalizeEmail } from '@/lib/auth/normalizeEmail'
import { isValidEmailFormat } from '@/lib/invitations/changeInviteEmail'

/**
 * James Kahrs nomination invitation campaign — a controlled, one-time, admin-only send. FIXED,
 * server-side recipient set. Each nominee gets ONE individual secure invitation (passwordless
 * /auth/recover setup link) with the nominator CC'd; no two nominees ever share a To/CC/BCC.
 *
 * IDEMPOTENCY AUTHORITY: the existing invitation_deliveries active claim ((waitlist_id, purpose) unique,
 * with a 24h stale-claim recovery lease) — the SINGLE send authority. A succeeded recipient is never
 * resent; a failed one is re-claimable. ATTRIBUTION is a `referrals` row (referrer_user_id = James's REAL
 * profile UUID → nominee's waitlist_id), written BEFORE the send so a post-send crash never loses it.
 * NO separate campaign-ledger table (James has a profile; referrals + invitation_deliveries suffice).
 * No passwords, no shared links, no untracked email. James is NEVER a recipient. Delivery state is
 * CC-fail-safe (webhook freezes CC'd sends at provider-accepted).
 */

export const CAMPAIGN_KEY = 'james-kahrs-nomination-2026-08'
export const NOMINATOR = {
  name: 'James Kahrs',
  email: normalizeEmail('james.kahrs@cbh.com'),
  userId: 'f9cf644b-1ee4-49cc-92bc-691145013d02', // confirmed production profile UUID
}
export const REFERRAL_NOTE = 'James Kahrs nomination campaign 2026-08'

export interface NominationRecipient { firstName: string; email: string }

export const RECIPIENTS: NominationRecipient[] = dedupeByEmail([
  { firstName: 'Brett', email: 'bcoffee@sourceamerica.org' },
  { firstName: 'John', email: 'john.ustica@siemensgovt.com' },
  { firstName: 'Jason', email: 'jason@readysetlaunch.net' },
  { firstName: 'Mitchell', email: 'mitchell.weintraub@cbh.com' },
  { firstName: 'Dyson', email: 'dyson@foxsteadpartners.com' },
  { firstName: 'Garrett', email: 'gklugh@falk-ventures.com' },
  { firstName: 'Jim', email: 'jhathaway@jtekds.com' },
  { firstName: 'Jim', email: 'jim.waller@choreoadvisors.com' },
  { firstName: 'Barry', email: 'barry.murphy@merlinatlantic.com' },
  { firstName: 'Anthony', email: 'anthony.miller@cgsfederal.com' },
  { firstName: 'Bobby', email: 'bobby.boucher@cgsfederal.com' },
  { firstName: 'Lucas', email: 'lucas.miller@cgsfederal.com' },
].map((r) => ({ firstName: r.firstName, email: normalizeEmail(r.email) }))
  .filter((r) => r.email !== NOMINATOR.email)) // nominator can never be a recipient

function dedupeByEmail(list: NominationRecipient[]): NominationRecipient[] {
  const seen = new Set<string>(); const out: NominationRecipient[] = []
  for (const r of list) { if (seen.has(r.email)) continue; seen.add(r.email); out.push(r) }
  return out
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
  ensureWaitlist: (email: string, firstName: string) => Promise<string | null>
  /** Write/ensure the referrals attribution row (referrer = James's profile → nominee waitlist). Pre-send. */
  ensureReferral: (nominatorUserId: string, waitlistId: string) => Promise<void>
  /** Reuses secureInvite (invitation_deliveries claim = send authority) + the nomination email (CC nominator). */
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
 * Run the campaign. `dryRun` performs every validation but creates/sends NOTHING. Execute processes only
 * 'ready' recipients (mode-gated): attribution (referrals) FIRST, then the individual CC'd secure invite
 * — idempotent via the invitation_deliveries claim (succeeded recipients never resent; failures retry).
 *
 * `only` (execute-mode single-recipient test) restricts SENDING to that ONE normalized email — it MUST
 * already be a member of the fixed RECIPIENTS list (the route validates this before calling). Every other
 * recipient is still classified (read-only) but never sent, recorded as `skipped_not_selected`. `only` has
 * NO effect on a dry run (a dry run always previews all 12). Returns masked, aggregate results — never a
 * link/token/secret/raw error.
 */
export async function runNominationCampaign(deps: NominationDeps, opts: { dryRun: boolean; only?: string }): Promise<CampaignResult> {
  const mode = deps.mode()
  const recipients: RecipientResult[] = []
  const only = opts.only ? normalizeEmail(opts.only) : null

  for (const r of RECIPIENTS) {
    if (r.email === NOMINATOR.email) continue // never the nominator (defense in depth)
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
        const waitlistId = await deps.ensureWaitlist(r.email, r.firstName)
        if (!waitlistId) outcome = 'unavailable'
        else {
          await deps.ensureReferral(NOMINATOR.userId, waitlistId) // ATTRIBUTION before send (crash-safe)
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
  return { dryRun: opts.dryRun, mode, campaignKey: CAMPAIGN_KEY, total: RECIPIENTS.length, summary, recipients }
}
