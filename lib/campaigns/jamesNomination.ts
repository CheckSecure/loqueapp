import { normalizeEmail } from '@/lib/auth/normalizeEmail'
import {
  defineNominationCampaign,
  runNominationCampaign as runCampaign,
  type NominationCampaign,
  type NominationDeps,
} from '@/lib/campaigns/nominationEngine'

/**
 * James Kahrs nomination invitation campaign — a controlled, one-time, admin-only send. FIXED,
 * server-side recipient set.
 *
 * STATUS: EXECUTED. This campaign ran successfully in production for all 12 recipients. Its campaign
 * key, recipient list, nominator UUID, referral note, CC behaviour, delivery-claim purposes and email
 * copy are therefore HISTORICAL FACTS bound to live rows (waitlist, invitation_deliveries, referrals,
 * auth users) and must not be changed. Re-running the route is safe and inert: every recipient now
 * classifies as already_member or active_invite_exists, so nothing is re-sent, re-linked, or
 * duplicated — see lib/__tests__/james-executed-compatibility.test.ts, which pins that behaviour and
 * asserts the email is byte-identical to what was sent. Each nominee gets ONE individual secure invitation (passwordless
 * /auth/recover setup link) with the nominator CC'd; no two nominees ever share a To/CC/BCC.
 *
 * This module is now a DATA DEFINITION only: the security-reviewed machinery (preflight
 * classification, delivery-claim idempotency, masking, failure-stage policy) lives in
 * lib/campaigns/nominationEngine.ts and is shared with every other nomination campaign. Behaviour
 * here is unchanged — the recipient list, CC'd nominator, referral note, and James's confirmed
 * profile UUID are identical, and `runNominationCampaign` keeps its original two-argument signature
 * so the existing route and tests are untouched.
 *
 * IDEMPOTENCY AUTHORITY: the existing invitation_deliveries active claim ((waitlist_id, purpose) unique,
 * with a 24h stale-claim recovery lease) — the SINGLE send authority. ATTRIBUTION is a `referrals` row
 * (referrer_user_id = James's REAL profile UUID → nominee's waitlist_id), written BEFORE the send.
 * James is NEVER a recipient. Delivery state is CC-fail-safe (webhook freezes CC'd sends at accepted).
 */

export const CAMPAIGN_KEY = 'james-kahrs-nomination-2026-08'
export const NOMINATOR = {
  name: 'James Kahrs',
  email: normalizeEmail('james.kahrs@cbh.com'),
  userId: 'f9cf644b-1ee4-49cc-92bc-691145013d02', // confirmed production profile UUID
}
export const REFERRAL_NOTE = 'James Kahrs nomination campaign 2026-08'

export const JAMES_CAMPAIGN: NominationCampaign = defineNominationCampaign({
  campaignKey: CAMPAIGN_KEY,
  nominator: NOMINATOR,
  referralNote: REFERRAL_NOTE,
  ccNominator: true, // James is courtesy-copied on every nominee's invitation
  expectedRecipients: 12,
  email: {
    subject: 'James Kahrs invited you to join Andrel',
    intro: 'a private network for senior leaders across legal, government affairs, business, and executive leadership',
  },
  recipients: [
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
  ],
})

export const RECIPIENTS = JAMES_CAMPAIGN.recipients

/** Bound runner — preserves this module's original two-argument signature for the existing route/tests. */
export function runNominationCampaign(deps: NominationDeps, opts: { dryRun: boolean; only?: string }) {
  return runCampaign(JAMES_CAMPAIGN, deps, opts)
}

export {
  maskEmail,
  classifyRecipient,
  type NominationRecipient,
  type Classification,
  type RecipientOutcome,
  type DeliveryState,
  type NominationDeps,
  type RecipientResult,
  type CampaignResult,
} from '@/lib/campaigns/nominationEngine'
