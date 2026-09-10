import { redirect } from 'next/navigation'
import { getAuthUser } from '@/lib/supabase/authUser'
import { viewerIsNext, NEXT_REDIRECT_TARGET } from '@/lib/community/viewerCommunity'

/**
 * Server-side community gate for /dashboard/billing.
 *
 * ─── WHY A LAYOUT AND NOT THE PAGE ────────────────────────────────────────────────────────────
 * app/dashboard/billing/page.tsx is a CLIENT component ('use client'): it cannot read the session
 * server-side, cannot use service_role, and cannot be trusted to gate itself — a check written
 * inside it would run in the browser, which is not a place authorization happens. A layout is the
 * nearest server boundary above it, so the check runs before the page is ever sent.
 *
 * This is also why the page itself is left completely untouched: a professional's billing
 * experience is byte-for-byte what it was, and this file adds one profiles read in front of it.
 *
 * ─── WHY BILLING IS CLOSED TO ANDREL NEXT ─────────────────────────────────────────────────────
 * The page sells three Professional tiers. Two of them are priced entirely on Opportunities —
 * "Up to 5 active opportunities in your For You feed", "Signal hiring or business needs", "Higher
 * ranking in opportunity matching" — a product an Andrel Next member cannot reach at all. Showing it
 * would either sell a student a subscription to something they do not receive, or require inventing
 * a student tier, which does not exist yet and is not being invented here.
 *
 * ─── NOT PRESENTATION ─────────────────────────────────────────────────────────────────────────
 * This does not read the layout's memberType prop, and must not: that prop is chrome. This resolves
 * the caller's community itself, from the verified session, on every request. The sidebar link to
 * Billing is deliberately still visible at this step — the refusal is being proven to work without
 * any help from what the navigation happens to show.
 *
 * Credits are NOT affected. No credit logic, balance or transaction is touched here; only who may
 * open the subscription page.
 */
export default async function BillingLayout({ children }: { children: React.ReactNode }) {
  // Shares the dashboard layout's single getUser() round trip via React cache, so this gate adds no
  // auth latency — only the one profiles read inside viewerIsNext.
  const user = await getAuthUser()
  // The parent dashboard layout already redirects an unauthenticated visitor; this is belt and
  // braces so the gate cannot be reached with no session under any future routing change.
  if (!user) redirect('/login')

  if (await viewerIsNext(user.id)) redirect(NEXT_REDIRECT_TARGET)

  return <>{children}</>
}
