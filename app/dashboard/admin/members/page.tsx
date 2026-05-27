import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import AdminMembersClient from '@/components/AdminMembersClient'

export const metadata = { title: 'Members | Admin' }

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export default async function AdminMembersPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  // Get all users with their key stats
  console.log('[AdminMembers] Starting query...')
  const profileQuery = await supabase
    .from('profiles')
    .select('id, full_name, email, company, title, subscription_tier, location, boost_score, is_priority, account_status, verification_status, current_status, profile_complete, created_at, is_founding_member, founding_member_email_sent_at, founding_member_expires_at, launch_cohort')
    .order('created_at', { ascending: false })
  
  console.log('[AdminMembers] Query result:', { 
    data: profileQuery.data?.length || 0, 
    error: profileQuery.error,
    status: profileQuery.status,
    statusText: profileQuery.statusText 
  })
  
  const profiles = profileQuery.data

  // Get credits for all users
  const { data: credits } = await supabase
    .from('meeting_credits')
    .select('user_id, balance')

  const creditsMap: Record<string, number> = {}
  credits?.forEach((c: any) => {
    creditsMap[c.user_id] = c.balance
  })

  // Get match counts
  const { data: matches } = await supabase
    .from('matches')
    .select('user_a_id, user_b_id, status')

  const matchCounts: Record<string, number> = {}
  matches?.forEach((m: any) => {
    if (m.status === 'active') {
      matchCounts[m.user_a_id] = (matchCounts[m.user_a_id] || 0) + 1
      matchCounts[m.user_b_id] = (matchCounts[m.user_b_id] || 0) + 1
    }
  })

  // Get intro request counts
  const { data: intros } = await supabase
    .from('intro_requests')
    .select('requester_id, target_user_id, status')

  const pendingIntros: Record<string, number> = {}
  const activeIntros: Record<string, number> = {}
  
  intros?.forEach((i: any) => {
    if (i.status === 'pending') {
      pendingIntros[i.requester_id] = (pendingIntros[i.requester_id] || 0) + 1
      pendingIntros[i.target_user_id] = (pendingIntros[i.target_user_id] || 0) + 1
    }
    if (i.status === 'approved') {
      activeIntros[i.requester_id] = (activeIntros[i.requester_id] || 0) + 1
      activeIntros[i.target_user_id] = (activeIntros[i.target_user_id] || 0) + 1
    }
  })

  // Activation markers (derived, not stored). Admin client + listUsers for
  // last_sign_in_at (the established activation marker), waitlist for invited_at.
  const admin = createAdminClient()

  const signedInIds = new Set<string>()
  let authPage = 1
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page: authPage, perPage: 1000 })
    if (error) break
    for (const u of data.users) if (u.last_sign_in_at) signedInIds.add(u.id)
    if (data.users.length < 1000) break
    authPage++
  }

  const { data: invitedRows } = await admin
    .from('waitlist')
    .select('email')
    .not('invited_at', 'is', null)
  const invitedEmails = new Set(
    (invitedRows || []).map((w: any) => (w.email || '').toLowerCase()).filter(Boolean)
  )

  console.log('[AdminMembers] Credits:', credits?.length || 0)
  console.log('[AdminMembers] Matches:', matches?.length || 0)
  console.log('[AdminMembers] Intros:', intros?.length || 0)

  const enrichedProfiles = (profiles || []).map((p: any) => {
    const signedIn = signedInIds.has(p.id)
    const wasInvited = p.email ? invitedEmails.has(p.email.toLowerCase()) : false
    // Highest applicable activation state.
    const activation_state =
      signedIn && p.profile_complete ? 'onboarded'
      : signedIn ? 'activated'
      : wasInvited ? 'invited'
      : 'none'
    return {
      ...p,
      tier: p.subscription_tier,
      launch_cohort: p.launch_cohort ?? null,
      was_invited: wasInvited,
      activation_state,
      credits: creditsMap[p.id] || 0,
      matches: matchCounts[p.id] || 0,
      pending_intros: pendingIntros[p.id] || 0,
      active_intros: activeIntros[p.id] || 0,
    }
  })

  console.log('[AdminMembers] Enriched profiles:', enrichedProfiles.length)
  
  return <AdminMembersClient profiles={enrichedProfiles} currentUserId={user.id} />
}
