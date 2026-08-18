import { normalizeEmail } from '@/lib/auth/normalizeEmail'
import {
  defineNominationCampaign,
  type NominationCampaign,
} from '@/lib/campaigns/nominationEngine'

/**
 * Jesse Solomon nomination invitation campaign — a controlled, one-time, admin-only send to exactly
 * THREE server-owned recipients. A pure DATA definition: every safety guarantee (read-only preflight,
 * delivery-claim idempotency, recipient binding, masking, failure-stage policy) comes from the shared
 * lib/campaigns/nominationEngine.ts, unchanged from the security-reviewed James Kahrs campaign.
 *
 * DIFFERENCES FROM THE JAMES CAMPAIGN — both deliberate:
 *
 *  1. `ccNominator: false`. Jesse is NOT courtesy-copied. Each nominee's invitation has exactly one
 *     recipient: them. No CC, no BCC, no additional recipient of any kind, so no nominee is ever
 *     exposed to another and Jesse never receives a copy.
 *
 *  2. No `nominator.userId`. James's production profile UUID was confirmed; Jesse's is NOT known here
 *     and is never invented. The route resolves it server-side by email at run time; if Jesse has no
 *     profile, the `referrals` attribution row is SKIPPED (and logged) and the invitations still send
 *     normally. Attribution is a nice-to-have; a missing nominator profile must never block a nominee.
 *
 * NO CREDIT IS DEDUCTED from Jesse. This is an admin-authorized nomination, not a member purchase or
 * introduction request — nothing in this path touches meeting_credits. (The pre-existing referral hook
 * in /api/profile/complete may AWARD the nominator +1 credit if a nominee later activates and the
 * attribution row exists; that is standard, unchanged referral behaviour, and never a deduction.)
 */

export const CAMPAIGN_KEY = 'jesse-solomon-nomination-2026-08'

export const NOMINATOR = {
  name: 'Jesse Solomon',
  email: normalizeEmail('jsolomon@paulweiss.com'),
  // userId intentionally absent — resolved server-side by email; never fabricated.
}

export const REFERRAL_NOTE = 'Jesse Solomon nomination campaign 2026-08'

export const JESSE_CAMPAIGN: NominationCampaign = defineNominationCampaign({
  campaignKey: CAMPAIGN_KEY,
  nominator: NOMINATOR,
  referralNote: REFERRAL_NOTE,
  ccNominator: false, // Jesse is NEVER copied — one recipient per email, no CC/BCC
  expectedRecipients: 3, // hard tripwire: the module fails to load if this list is ever edited
  email: {
    subject: 'Jesse Solomon is inviting you to join Andrel',
    intro:
      'a private network for senior professionals and executives built around thoughtful, mutually valuable introductions',
  },
  recipients: [
    { firstName: 'Bill', fullName: 'Bill Martin', email: 'billmartin245@gmail.com' },
    { firstName: 'Mike', fullName: 'Mike O’Neill', email: 'michael.t.oneill@lilly.com' },
    { firstName: 'Mark', fullName: 'Mark Toskey', email: 'mark.toskey@takeda.com' },
  ],
})

export const RECIPIENTS = JESSE_CAMPAIGN.recipients
