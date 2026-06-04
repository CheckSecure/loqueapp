import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { checkCreatorEligibility } from '@/lib/opportunities/eligibility';
import BusinessForm from '@/components/opportunities/BusinessForm';

export default async function BusinessPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const eligibility = await checkCreatorEligibility(user.id);
  if (!eligibility.ok && eligibility.code === 'free_tier') {
    redirect('/dashboard/billing?source=opp_paywall');
  }

  return <BusinessForm />;
}
