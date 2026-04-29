import { createAdminClient } from '@/lib/supabase/admin'

const EXCLUDED_STATUSES = ['pending', 'invited', 'activated'] as const

/**
 * Returns the set of profile IDs that share a non-rejected referral relationship
 * with userId — bidirectional (as referrer OR as the referred person).
 *
 * Statuses that trigger exclusion: pending, invited, activated.
 * Rejected referrals do not exclude — the pair never connected via this platform.
 */
export async function getReferralExclusionsForUser(userId: string): Promise<Set<string>> {
  const admin = createAdminClient()
  const excluded = new Set<string>()

  // Fetch user email internally — caller does not need to supply it.
  // Avoids silent no-ops from callers passing empty string.
  const { data: userProfile } = await admin
    .from('profiles')
    .select('email')
    .eq('id', userId)
    .single()

  if (!userProfile?.email) {
    console.warn('[referrals/exclusions] Could not resolve email for userId — skipping exclusion', { userId })
    return excluded
  }

  const userEmail = userProfile.email

  // ── Side A: user referred someone ─────────────────────────────────────────
  // referrals.referrer_user_id = userId → collect waitlist emails →
  // resolve to profile IDs (only works once the referred user has activated).
  const { data: asReferrer } = await admin
    .from('referrals')
    .select('status, waitlist:waitlist_id(email)')
    .eq('referrer_user_id', userId)
    .in('status', EXCLUDED_STATUSES)

  const referredEmails = (asReferrer ?? [])
    .map(r => (r.waitlist as any)?.email as string | undefined)
    .filter((e): e is string => Boolean(e))

  if (referredEmails.length > 0) {
    const { data: referredProfiles } = await admin
      .from('profiles')
      .select('id')
      // Note: assumes profile emails are lowercase. Mixed-case profile emails (legacy data)
      // may slip through exclusion. Acceptable V1 gap. Future: enforce lowercase on profile.email insert.
      .in('email', referredEmails.map(e => e.toLowerCase()))

    const resolvedIds = referredProfiles ?? []
    resolvedIds.forEach(p => excluded.add(p.id))

    // Tightened warning: only fire when an activated referral failed to resolve.
    // pending/invited referrals that haven't signed up yet are expected to return zero — not a bug.
    const activatedCount = (asReferrer ?? []).filter(r => r.status === 'activated').length
    if (activatedCount > 0 && resolvedIds.length === 0) {
      console.warn('[referrals/exclusions] Side A: activated referral found but zero profiles resolved', {
        userId,
        activatedCount,
        referredEmailCount: referredEmails.length,
      })
    }
  }

  // ── Side B: user was referred ──────────────────────────────────────────────
  // Find the waitlist row matching userEmail → get referrer_user_ids directly.
  //
  // Why waitlist.email === profiles.email is safe:
  //   The submit gate rejects referrals where the email already belongs to an
  //   active profile or existing waitlist row — so at submission time no profile
  //   exists for this email. The invite flow creates a Supabase auth user with the
  //   exact waitlist email; profiles.email is set from that auth record on signup.
  //   Therefore waitlist.email = profiles.email is structurally guaranteed for
  //   the activation path.
  //
  //   V1 accepted gap: a post-activation email change (via EmailChangeForm) causes
  //   profiles.email to drift from waitlist.email. Exclusion would silently stop
  //   applying. Acceptable — the referral relationship is historical at that point.
  const { data: waitlistRow } = await admin
    .from('waitlist')
    .select('referrals!waitlist_id(referrer_user_id, status)')
    .ilike('email', userEmail)
    .maybeSingle()

  const inboundReferrals = ((waitlistRow as any)?.referrals ?? []) as Array<{
    referrer_user_id: string
    status: string
  }>

  inboundReferrals
    .filter(r => (EXCLUDED_STATUSES as readonly string[]).includes(r.status))
    .forEach(r => excluded.add(r.referrer_user_id))

  return excluded
}
