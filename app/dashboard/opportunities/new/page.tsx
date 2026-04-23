import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { checkCreatorEligibility } from '@/lib/opportunities/eligibility';

export const dynamic = 'force-dynamic';

export default async function NewOpportunityPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const elig = await checkCreatorEligibility(user.id);
  if (!elig.ok) {
    return (
      <div className="mx-auto max-w-xl px-6 py-16">
        <h1 className="text-xl font-semibold text-slate-900">Not available</h1>
        <p className="mt-3 text-sm text-slate-600">{elig.message}</p>
        <Link href="/dashboard/opportunities" className="mt-6 inline-block text-sm text-[#1B2850] hover:underline">
          Back to Opportunities
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-2xl font-semibold text-slate-900">Signal a need</h1>
      <p className="mt-2 text-sm text-slate-500">Your signal goes only to a small, curated set of members.</p>

      <div className="mt-8 grid gap-4">
        <Link href="/dashboard/opportunities/new/hiring" className="group rounded-lg border border-slate-200 bg-white p-6 hover:border-[#1B2850]">
          <div className="text-sm font-medium text-slate-900 group-hover:text-[#1B2850]">Hiring</div>
          <p className="mt-1 text-sm text-slate-500">You're looking for someone to fill a role.</p>
        </Link>

        <Link href="/dashboard/opportunities/new/business" className="group rounded-lg border border-slate-200 bg-white p-6 hover:border-[#1B2850]">
          <div className="text-sm font-medium text-slate-900 group-hover:text-[#1B2850]">Business need</div>
          <p className="mt-1 text-sm text-slate-500">You need a law firm, consultant, or other service.</p>
        </Link>
      </div>

      <Link href="/dashboard/opportunities" className="mt-8 inline-block text-sm text-slate-500 hover:text-slate-700">← Cancel</Link>
    </div>
  );
}
