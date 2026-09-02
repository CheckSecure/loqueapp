import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { claimReminder, markAccepted, markFailed } from '@/lib/reminders/deliveryLedger'
import { sendWednesdayIntroReminderEmail } from '@/lib/email'
import {
  REMINDER_RELEVANT_STATUSES, newYorkIsoWeekKey, openCardsFor, reminderIneligibility,
  REMINDER_PURPOSE, type OpenCard, type ReminderProfile,
} from '@/lib/reminders/wednesdayIntroReminder'

/**
 * Send THIS WEEK'S Wednesday reminder to named members only.
 *
 * Exists because the weekly stage can be cut short. When the 25s deadline fires, the members after
 * the cut wait a full week — the stage only runs on Wednesdays — and there was no way to reach just
 * them without re-running a nine-stage cron.
 *
 * IDEMPOTENT BY CONSTRUCTION, not by care. It uses the SAME purpose and the SAME cycle key as the
 * weekly stage, so reminder_deliveries' active-claim index on (member_id, purpose, cycle_key) does
 * the deduplication: a member who already received this week's reminder is refused the claim and
 * gets nothing. Passing every member id in the network would still only reach the ones the cron
 * missed. That is deliberate — the safe operation should be the easy one.
 *
 * DELIBERATELY NOT the catch-up campaign at /api/admin/reminders/unanswered-intros-catchup. That
 * route uses a different purpose (catchup_unanswered_2026_08_20) keyed to a fixed campaign string,
 * one per member EVER. Running it today would not see this week's claims at all, so it would
 * re-mail everyone who already got their reminder this morning and burn their one catch-up slot.
 */
export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'
const PAGE = 1000
const PROFILE_CHUNK = 200
const MAX_TARGETS = 100

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { memberIds?: unknown; action?: unknown } = {}
  try { body = await req.json() } catch { /* empty body → dry run, no targets */ }

  const memberIds = Array.isArray(body.memberIds)
    ? Array.from(new Set(body.memberIds.filter((v): v is string => typeof v === 'string')))
    : []
  const execute = body.action === 'execute'

  if (memberIds.length === 0) {
    return NextResponse.json({ error: 'memberIds is required' }, { status: 400 })
  }
  if (memberIds.length > MAX_TARGETS) {
    return NextResponse.json({ error: `At most ${MAX_TARGETS} members per call` }, { status: 400 })
  }

  const admin = createAdminClient()
  const cycleKey = newYorkIsoWeekKey(new Date())

  // The SAME read the weekly stage does, paged to exhaustion and failing closed. Open-card counts
  // have to be computed from the whole table, not from the named members' rows alone: a card is
  // only open if there is no responding row toward that same target.
  const openRows: OpenCard[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('intro_requests')
      .select('requester_id, target_user_id, status')
      .in('status', REMINDER_RELEVANT_STATUSES)
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('[wednesday-targeted] card read failed (class):', (error as any).code ?? 'unknown')
      return NextResponse.json({ error: 'Read failed; nothing was sent' }, { status: 503 })
    }
    for (const r of data ?? []) {
      if (!r?.requester_id || !r?.target_user_id || !r?.status) continue
      openRows.push({ requesterId: r.requester_id, targetUserId: r.target_user_id, status: r.status, pairId: null })
    }
    if (!data || data.length < PAGE) break
  }

  // Profiles for the named members AND every target, so openCardsFor can apply the target-active
  // gate. Fails closed: a partial set would mark live targets inactive and under-count open cards.
  const referenced = new Set<string>(memberIds)
  for (const r of openRows) referenced.add(r.targetUserId)
  const profById = new Map<string, any>()
  const refIds = Array.from(referenced)
  for (let i = 0; i < refIds.length; i += PROFILE_CHUNK) {
    const { data, error } = await admin
      .from('profiles')
      .select('id, email, full_name, account_status, profile_complete, is_test_account, is_admin, matching_paused')
      .in('id', refIds.slice(i, i + PROFILE_CHUNK))
    if (error) {
      console.error('[wednesday-targeted] profile read failed (class):', (error as any).code ?? 'unknown')
      return NextResponse.json({ error: 'Read failed; nothing was sent' }, { status: 503 })
    }
    for (const row of data ?? []) profById.set(row.id, row)
  }
  const activeTargetIds = new Set<string>()
  for (const [id, row] of Array.from(profById.entries())) {
    if (row?.account_status === 'active') activeTargetIds.add(id)
  }

  // Already claimed this cycle → the cron reached them; nothing to do. Read up front so a dry run
  // can say so, rather than only discovering it when the claim is refused.
  const alreadyClaimed = new Set<string>()
  const { data: claims } = await admin
    .from('reminder_deliveries')
    .select('member_id, status')
    .eq('purpose', REMINDER_PURPOSE)
    .eq('cycle_key', cycleKey)
    .in('member_id', memberIds)
  for (const c of (claims ?? []) as any[]) {
    if (['claimed', 'accepted', 'delivered', 'deferred'].includes(c.status)) alreadyClaimed.add(c.member_id)
  }

  const rows: Array<Record<string, unknown>> = []
  const outcomes: Record<string, number> = {}
  const bump = (k: string) => { outcomes[k] = (outcomes[k] ?? 0) + 1 }

  for (const memberId of memberIds) {
    const prof = profById.get(memberId)
    const openCount = openCardsFor(memberId, openRows, activeTargetIds).length
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
    const base = { memberId, name: prof?.full_name ?? null, openCount }

    if (!prof) { bump('no_profile'); rows.push({ ...base, verdict: 'no_profile' }); continue }
    if (alreadyClaimed.has(memberId)) {
      bump('already_reminded_this_cycle')
      rows.push({ ...base, verdict: 'already_reminded_this_cycle' })
      continue
    }
    const reason = reminderIneligibility(p, openCount)
    if (reason) { bump(reason); rows.push({ ...base, verdict: reason }); continue }

    if (!execute) { bump('would_send'); rows.push({ ...base, verdict: 'would_send' }); continue }

    const claim = await claimReminder(admin, {
      memberId, purpose: REMINDER_PURPOSE, cycleKey, openCardCount: openCount,
    })
    if (!claim.claimed || !claim.deliveryId) {
      // Lost the race with the cron, or a stale row. The index is the authority, not the read above.
      const k = claim.errorClass ?? 'already_claimed'
      bump(k); rows.push({ ...base, verdict: k })
      continue
    }
    try {
      const res = await sendWednesdayIntroReminderEmail(p.email as string, p.firstName, openCount)
      if (res.sent) {
        await markAccepted(admin, claim.deliveryId, res.providerMessageId)
        bump('sent'); rows.push({ ...base, verdict: 'sent' })
      } else {
        bump('pref_disabled'); rows.push({ ...base, verdict: 'pref_disabled' })
      }
    } catch {
      await markFailed(admin, claim.deliveryId, 'provider_error')
      bump('failed'); rows.push({ ...base, verdict: 'failed' })
    }
  }

  console.log(JSON.stringify({
    event: 'wednesday_targeted', mode: execute ? 'execute' : 'dry_run', cycleKey, outcomes,
  }))

  return NextResponse.json({
    mode: execute ? 'execute' : 'dry_run',
    cycleKey,
    requested: memberIds.length,
    outcomes,
    rows,
  })
}
