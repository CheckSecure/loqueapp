import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import AdminWaitlistClient from '@/components/AdminWaitlistClient'
import { excludeJoinedFromInvited, toCompletedEmailSet } from '@/lib/waitlist/joined'
import { normalizeEmail } from '@/lib/auth/normalizeEmail'
import { computeLifecycle, lifecycleLabel } from '@/lib/waitlist/lifecycle'

export const metadata = { title: 'Waitlist | Admin' }

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export default async function AdminWaitlistPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  // Use adminClient to bypass RLS on the referrals join.
  // Safe: auth gate above already enforces admin-only access.
  const adminClient = createAdminClient()
  const { data: waitlist } = await adminClient
    .from('waitlist')
    .select(`
      id, full_name, email, company, title, role_type,
      linkedin_url, referral_source, status, created_at, invited_at,
      invite_reminder_1_sent_at, invite_reminder_2_sent_at, first_matching_reminder_sent_at,
      referrals!waitlist_id(
        referral_note, status,
        referrer:profiles!referrer_user_id(id, full_name, account_status)
      )
    `)
    .order('created_at', { ascending: false })

  // Hide referrals where the referrer is no longer active. Catches:
  //   - deactivated referrers (per V1 spec)
  //   - orphaned referral_source='referral' rows with no joined referral
  //   - referrer rows missing for any reason (stale data, FK issues)
  // Note: PostgREST returns the to-one referrals join as an object, not an array.
  const referralVisible = (waitlist ?? []).filter(w =>
    w.referral_source !== 'referral' ||
    (w.referrals as any)?.referrer?.account_status === 'active'
  )

  // Drop people who have already joined (completed onboarding) from Invited so
  // the tab shows only invited people who have NOT yet joined. Canonical signal:
  // profiles.profile_complete = true, matched by email. Read-only — no waitlist
  // rows are mutated here, so this also covers members who joined before the
  // automatic invited→activated transition existed (no backfill required).
  const { data: completedProfiles } = await adminClient
    .from('profiles')
    .select('email')
    .eq('profile_complete', true)
  const completedEmails = toCompletedEmailSet(completedProfiles)
  const visible = excludeJoinedFromInvited(referralVisible, completedEmails)

  // Compute each row's activation-email lifecycle from the shared module (single
  // source of truth). completedEmails already excludes joined users from the
  // Invited tab, so these rows are all incomplete; profileComplete stays false.
  const nowMs = Date.now()
  const withLifecycle = visible.map(w => {
    const lc = computeLifecycle({
      status: w.status,
      email: w.email,
      invited_at: w.invited_at,
      invite_reminder_1_sent_at: w.invite_reminder_1_sent_at,
      invite_reminder_2_sent_at: w.invite_reminder_2_sent_at,
      first_matching_reminder_sent_at: (w as any).first_matching_reminder_sent_at ?? null,
      profileComplete: completedEmails.has(normalizeEmail(w.email)),
    }, nowMs)
    return { ...w, lifecycle: { ...lc, label: lifecycleLabel(lc.state) } }
  })

  const counts = {
    pending:  withLifecycle.filter(w => w.status === 'pending').length,
    approved: withLifecycle.filter(w => w.status === 'approved').length,
    invited:  withLifecycle.filter(w => w.status === 'invited').length,
    declined: withLifecycle.filter(w => w.status === 'declined').length,
  }

  // Cast at the boundary: PostgREST types the to-one `referrals` join as an
  // array while it is an object at runtime (handled with `as any` in the filter
  // above). Consistent with the pre-existing loose typing of this row shape.
  return <AdminWaitlistClient waitlist={withLifecycle as any} counts={counts} />
}
