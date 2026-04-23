import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { TIER_OPPORTUNITY_LIMIT, type Tier } from '@/lib/opportunities/caps';
import { YoursRow } from '@/components/opportunities/YoursRow';

export const dynamic = 'force-dynamic';

export default async function YourSignalsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const admin = createAdminClient();

  const { data: profile } = await admin
    .from('profiles')
    .select('subscription_tier')
    .eq('id', user.id)
    .maybeSingle();
  const tier = (profile?.subscription_tier as Tier) ?? 'free';
  const canCreate = (TIER_OPPORTUNITY_LIMIT[tier] ?? 0) > 0;

  const { data } = await admin
    .from('opportunities')
    .select('id, type, title, status, expires_at, urgency, created_at, archived_at')
    .eq('creator_id', user.id)
    .is('archived_at', null)
    .order('created_at', { ascending: false });

  const rows = data ?? [];

  const oppIds = rows.map((r) => r.id);
  let waitingByOpp = new Map<string, number>();
  if (oppIds.length > 0) {
    const { data: responses } = await admin
      .from('opportunity_responses')
      .select('opportunity_id, status')
      .in('opportunity_id', oppIds)
      .is('declined_by_creator_at', null);
    (responses ?? []).forEach((r) => {
      if (r.status === 'interested') {
        waitingByOpp.set(r.opportunity_id, (waitingByOpp.get(r.opportunity_id) ?? 0) + 1);
      }
    });
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/dashboard/opportunities" className="text-sm text-slate-500 hover:text-slate-700">
        ← Opportunities
      </Link>

      <div className="mt-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Your signals</h1>
          <p className="mt-1 text-sm text-slate-500">Opportunities you've created.</p>
        </div>
        {canCreate && (
          <Link
            href="/dashboard/opportunities/new"
            className="rounded-md bg-[#1B2850] px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-[#151f3d]"
          >
            Signal a need
          </Link>
        )}
      </div>

      <div className="mt-8">
        {rows.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white px-8 py-14 text-center">
            <h3 className="text-base font-medium text-slate-900">You haven't signaled a need</h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
              {canCreate
                ? "Signal a hiring or business need and we'll match the right people."
                : 'Upgrade to Professional to signal a need.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => (
              <YoursRow key={r.id} opportunity={r as any} waitingCount={waitingByOpp.get(r.id) ?? 0} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
