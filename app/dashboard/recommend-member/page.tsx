import { redirect } from 'next/navigation'

/**
 * Alias for the existing member recommendation flow. The referral campaign CTA
 * points here (/dashboard/recommend-member); we redirect to the single existing
 * implementation at /dashboard/referrals rather than duplicating the page. Auth is
 * enforced by the destination page (and the dashboard layout).
 */
export default function RecommendMemberPage() {
  redirect('/dashboard/referrals')
}
