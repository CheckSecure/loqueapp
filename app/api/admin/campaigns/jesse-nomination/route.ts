import { handleNominationCampaignRequest, methodNotAllowed } from '@/lib/campaigns/campaignRouteHandler'
import { JESSE_CAMPAIGN } from '@/lib/campaigns/jesseSolomonNomination'

/**
 * Admin-only Jesse Solomon nomination campaign — exactly THREE fixed, server-owned recipients.
 *
 * All behaviour comes from the shared, security-reviewed handler and engine: same-origin + admin +
 * JSON-only, fail-closed strict body shapes, read-only preflight before any write, delivery-claim
 * idempotency, one individual secure link per nominee, and masked aggregate output.
 *
 * Campaign-specific: Jesse is NOT copied (ccNominator: false), so each message has exactly one
 * recipient and no CC/BCC. No credits are deducted from Jesse — nothing in this path touches
 * meeting_credits.
 *
 *   { dryRun: true }                                     → preview all 3; creates + sends NOTHING.
 *   { dryRun: false, testRecipient: "<one list email>" } → send ONLY that one nominee.
 *   { dryRun: false, confirmFullCampaign: true }         → full send of all 3.
 */
export async function POST(req: Request) {
  return handleNominationCampaignRequest(req, JESSE_CAMPAIGN, '[jesse-nomination]')
}

export async function GET() {
  return methodNotAllowed()
}
