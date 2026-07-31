import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ReferralCampaignClient from '@/components/ReferralCampaignClient'

export const metadata = { title: 'Referral campaign | Admin' }
export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/**
 * Admin entry point for the one-time "Help us grow the Andrel network" campaign.
 * The heavy lifting (eligibility, dedupe, resumable send) lives in the API routes;
 * this page only gates on the operator and renders the preview/send controls.
 */
export default async function ReferralCampaignPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  return <ReferralCampaignClient />
}
