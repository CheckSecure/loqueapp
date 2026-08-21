/**
 * POST /api/admin/reminders/unanswered-intros-catchup
 *
 * The one-time catch-up for members holding unanswered introductions when this week's ordinary
 * Wednesday window passed before the reminder shipped. Admin-only, same-origin, and deliberately
 * incapable of anything but the three shapes in parseCatchupBody.
 *
 * ORDER OF OPERATIONS IS PART OF THE SECURITY PROPERTY. Same-origin, then admin, then method and
 * content type, and only THEN is a service-role client created or a body parsed. A service-role
 * client built before authorization is a service-role client an unauthorized caller reached.
 *
 * THE CAMPAIGN KEY IS NOT AN INPUT. It is CATCHUP_CAMPAIGN_KEY, fixed in server code. A caller who
 * could name the key could name an unused one and re-mail everyone who already received this.
 *
 * IT DOES NOT CONSUME NEXT WEDNESDAY'S DEDUPE. The purpose differs, so the weekly claim
 * (member, 'wednesday_intro_reminder', <ISO week>) is untouched and next week's reminder still runs.
 */

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  REMINDER_RELEVANT_STATUSES, openCardsFor, reminderIneligibility,
  type OpenCard, type ReminderProfile,
} from '@/lib/reminders/wednesdayIntroReminder'
import { claimReminder, markAccepted, markFailed } from '@/lib/reminders/deliveryLedger'
import { CATCHUP_CAMPAIGN_KEY, CATCHUP_UNANSWERED } from '@/lib/reminders/purposes'
import {
  parseCatchupBody, maskEmail, CATCHUP_MAX_RECIPIENTS, CATCHUP_DEADLINE_MS,
} from '@/lib/reminders/catchupCampaign'
import { sendWednesdayIntroReminderEmail } from '@/lib/email'

const PAGE = 1000
const NO_STORE = { 'Cache-Control': 'no-store' } as const

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

export async function POST(req: Request) {
  // 1. Same-origin BEFORE anything else. Cookie auth alone is forgeable cross-site.
  const origin = assertSameOrigin(req)
  if (origin) return json({ error: 'Cross-origin request rejected' }, 403)

  // 2. Admin BEFORE any service-role client exists.
  const { error: adminErr } = await requireAdmin()
  if (adminErr) return json({ error: adminErr.status === 403 ? 'Forbidden' : 'Unauthorized' }, adminErr.status)

  // 3. JSON only. A form post is not an accepted shape.
  const ctype = req.headers.get('content-type') ?? ''
  if (!ctype.toLowerCase().includes('application/json')) return json({ error: 'Content-Type must be application/json' }, 415)

  let raw: unknown
  try { raw = await req.json() } catch { return json({ error: 'Malformed JSON' }, 400) }

  const parsed = parseCatchupBody(raw)
  if (!parsed.ok) return json({ error: 'Unsupported request shape', reason: parsed.reason }, 400)
  const mode = parsed.mode

  const startedAt = Date.now()
  const admin = createAdminClient()

  // 4. Paged to exhaustion. FAIL CLOSED — a partial read would mail the wrong set.
  const openRows: OpenCard[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('intro_requests')
      .select('requester_id, target_user_id, status')
      .in('status', REMINDER_RELEVANT_STATUSES)
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('[catchup] read failed (class):', (error as any).code ?? 'unknown')
      return json({ error: 'Read failed; nothing was sent', sent: 0, failClosed: true }, 503)
    }
    for (const r of data ?? []) {
      if (!r?.requester_id || !r?.target_user_id || !r?.status) continue
      openRows.push({ requesterId: r.requester_id, targetUserId: r.target_user_id, status: r.status, pairId: null })
    }
    if (!data || data.length < PAGE) break
  }

  // 5. Members holding at least one OPEN card. Status is the only gate, so reciprocal and
  //    legacy/admin cards qualify identically, and a member whose only state is a private interest
  //    or a closed card is excluded by openCardsFor.
  const byMember = new Map<string, number>()
  for (const id of Array.from(new Set(openRows.map((r) => r.requesterId)))) {
    const open = openCardsFor(id, openRows)
    if (open.length > 0) byMember.set(id, open.length)
  }
  const candidates = Array.from(byMember.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  const truncated = candidates.length > CATCHUP_MAX_RECIPIENTS

  let considered = 0, claimed = 0, sent = 0, failed = 0, deadlineHit = false
  const skip: Record<string, number> = {}
  const details: Array<{ firstName: string | null; email: string; classification: string; outcome: string }> = []
  const note = (k: string) => { skip[k] = (skip[k] ?? 0) + 1 }

  for (const [memberId, openCount] of candidates.slice(0, CATCHUP_MAX_RECIPIENTS)) {
    if (Date.now() - startedAt > CATCHUP_DEADLINE_MS) { deadlineHit = true; break }
    considered++

    const { data: prof, error: profErr } = await admin
      .from('profiles')
      .select('id, email, full_name, account_status, profile_complete, is_test_account, is_admin, matching_paused')
      .eq('id', memberId)
      .maybeSingle()
    if (profErr) { note('profile_read_failed'); continue }

    const p: ReminderProfile = {
      id: memberId,
      email: prof?.email ?? null,
      firstName: (prof?.full_name ?? '').split(' ')[0] || null,
      accountStatus: prof?.account_status ?? null,
      profileComplete: prof?.profile_complete ?? null,
      isTestAccount: prof?.is_test_account ?? null,
      isAdmin: prof?.is_admin ?? null,
      matchingPaused: prof?.matching_paused ?? null,
    }
    const ineligible = reminderIneligibility(p, openCount)
    if (ineligible) { note(ineligible); continue }

    // Test-recipient mode targets exactly one address and nobody else.
    if (mode.kind === 'test_recipient' && (p.email ?? '').toLowerCase() !== mode.email) { note('not_test_recipient'); continue }

    if (mode.kind === 'dry_run') {
      details.push({ firstName: p.firstName, email: maskEmail(p.email), classification: 'eligible', outcome: 'dry_run' })
      continue
    }

    // Durable dedupe on the FIXED campaign key. A repeat call finds the claim taken and sends nothing.
    const claim = await claimReminder(admin, {
      memberId, purpose: CATCHUP_UNANSWERED, cycleKey: CATCHUP_CAMPAIGN_KEY, openCardCount: openCount,
    })
    if (!claim.claimed || !claim.deliveryId) {
      note('already_sent')
      details.push({ firstName: p.firstName, email: maskEmail(p.email), classification: 'eligible', outcome: 'already_sent' })
      continue
    }
    claimed++

    try {
      const res = await sendWednesdayIntroReminderEmail(p.email as string, p.firstName, openCount)
      if (res.sent) {
        await markAccepted(admin, claim.deliveryId, res.providerMessageId)
        sent++
        details.push({ firstName: p.firstName, email: maskEmail(p.email), classification: 'eligible', outcome: 'sent' })
      } else {
        // Opted out of introduction email. Not a failure, and the claim stands so it is not retried.
        await markAccepted(admin, claim.deliveryId, null)
        details.push({ firstName: p.firstName, email: maskEmail(p.email), classification: 'eligible', outcome: 'opted_out' })
      }
    } catch {
      // CLASS only, never the provider's message. 'failed' leaves the claim retryable.
      await markFailed(admin, claim.deliveryId, 'provider_error')
      failed++
      details.push({ firstName: p.firstName, email: maskEmail(p.email), classification: 'eligible', outcome: 'failed' })
    }

    if (mode.kind === 'test_recipient') break   // exactly one
  }

  console.log(`[catchup] mode=${mode.kind} considered=${considered} claimed=${claimed} sent=${sent} failed=${failed}`)

  return json({
    campaign: CATCHUP_CAMPAIGN_KEY,
    mode: mode.kind,
    eligibleTotal: candidates.length,
    considered, claimed, sent, failed,
    truncated, deadlineHit,
    skipped: skip,
    recipients: details,
  })
}
