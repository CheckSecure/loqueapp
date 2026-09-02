import { createNotificationSafe } from '@/lib/notifications'

/**
 * Both members said yes; the match could not complete because one of them was out of credits.
 *
 * TELLING BOTH SIDES IS THE POINT. Before this, the acting member saw "Connection can't complete
 * right now. We'll let you know when it can" — a promise nothing kept — and the other member, whose
 * introduction had just been ACCEPTED, heard nothing at all.
 *
 * WHOSE BALANCE IS SHORT IS NOT DISCLOSED. The member who is short is told plainly, because it is
 * their own account and they can act on it. The other member is told only that it is waiting: naming
 * the shortfall would expose one member's billing state to another, and the existing 403 copy
 * already sets the vaguer tone.
 */

/** Canonical, order-independent key so both sides of a pair dedupe against the same string. */
export function blockedDedupeKey(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return `match_blocked:${lo}:${hi}`
}

function firstNameOf(fullName: string | null | undefined): string {
  return ((fullName ?? '').trim().split(/\s+/)[0]) || ''
}

/**
 * Notify both members that the match is waiting on credits.
 *
 * Never throws — a missed notification must not turn a recoverable block into a failed request, and
 * the caller is already returning an error to the acting member.
 */
export async function notifyCreditBlockedMatch(
  admin: any,
  args: { shortUserId: string; otherUserId: string },
): Promise<void> {
  try {
    const { data: profiles } = await admin
      .from('profiles')
      .select('id, full_name')
      .in('id', [args.shortUserId, args.otherUserId])
    const nameById = new Map<string, string>(
      (profiles ?? []).map((p: any) => [p.id, firstNameOf(p.full_name)]))

    // One key for the pair, so a retry of the same block cannot notify twice and both sides are
    // keyed consistently. Each member still gets their own row — the index is per user_id.
    const dedupeKey = blockedDedupeKey(args.shortUserId, args.otherUserId)

    const otherFirst = nameById.get(args.otherUserId) ?? ''
    const shortFirst = nameById.get(args.shortUserId) ?? ''

    // The member who is short. Named counterpart is safe: they expressed interest in this person
    // and can see them on their own introductions page. Sent to billing, where they can act.
    await createNotificationSafe({
      userId: args.shortUserId,
      type: 'match_pending_credits',
      dedupeKey,
      link: '/dashboard/billing',
      data: { otherUserId: args.otherUserId, role: 'short' },
      ...(otherFirst
        ? {
            title: `${otherFirst} accepted your introduction`,
            body: `You need 1 credit to connect. Add one and we'll complete the introduction automatically — you don't need to do anything else.`,
          }
        : {}),
    })

    // The other member. Deliberately says nothing about whose balance is short.
    await createNotificationSafe({
      userId: args.otherUserId,
      type: 'match_pending_credits',
      dedupeKey,
      link: '/dashboard/introductions',
      data: { otherUserId: args.shortUserId, role: 'waiting' },
      ...(shortFirst
        ? {
            title: `Your introduction to ${shortFirst} is waiting`,
            body: `You both said yes. It will complete automatically as soon as a credit is available on both sides.`,
          }
        : {}),
    })
  } catch (e: any) {
    console.error('[credit-blocked-match] notify failed (non-fatal):', e?.message ?? 'unknown')
  }
}
