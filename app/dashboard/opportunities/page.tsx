import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { TIER_OPPORTUNITY_LIMIT, type Tier } from '@/lib/opportunities/caps';
import { ReceiverCard } from '@/components/opportunities/ReceiverCard';

export const dynamic = 'force-dynamic';

export default async function OpportunitiesPage() {
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

  const { data: forYouRows } = await admin
    .from('opportunity_candidates')
    .select(
      'id, opportunity_id, role, opportunities!inner(id, creator_id, type, title, description, urgency, status, expires_at, profiles!opportunities_creator_id_fkey(full_name, company))'
    )
    .eq('user_id', user.id)
    .is('dismissed_at', null)
    .eq('opportunities.status', 'active')
    .order('shown_at', { ascending: false })
    .limit(5);

  const forYouOppIds = (forYouRows ?? []).map((r) => r.opportunity_id);
  let respondedSet = new Set<string>();
  if (forYouOppIds.length > 0) {
    const { data: responded } = await admin
      .from('opportunity_responses')
      .select('opportunity_id')
      .eq('user_id', user.id)
      .in('opportunity_id', forYouOppIds);
    respondedSet = new Set((responded ?? []).map((r) => r.opportunity_id));
  }
  const forYou = (forYouRows ?? []).filter((r) => !respondedSet.has(r.opportunity_id));

  const [{ count: signalsCount }, { count: responsesCount }] = await Promise.all([
    admin
      .from('opportunities')
      .select('id', { count: 'exact', head: true })
      .eq('creator_id', user.id)
      .is('archived_at', null),
    admin
      .from('opportunity_responses')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id),
  ]);

  const signals = signalsCount ?? 0;
  const responses = responsesCount ?? 0;

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Opportunities</h1>
          <p className="mt-1 text-sm text-slate-500">
            Private, curated opportunities — no noise, no browsing.
          </p>
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

      {canCreate ? (
        <p className="mt-2 text-xs text-slate-500">
          Signal hiring or business needs and we'll match the right people.
        </p>
      ) : (
        <p className="mt-2 text-xs text-slate-500">
          Upgrade to Professional to signal a need.
        </p>
      )}

      <section className="mt-10">
        <div className="mb-5">
          <h2 className="text-sm font-medium uppercase tracking-wider text-slate-500">
            Opportunities for you
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Private opportunities selected based on your experience.
          </p>
        </div>

        {forYou.length === 0 ? (
          <EmptyFor />
        ) : (
          <div className="space-y-5">
            {forYou.map((r) => (
              <ReceiverCard
                key={r.id}
                opportunityId={r.opportunity_id}
                role={r.role as 'candidate' | 'provider' | 'recruiter'}
                opportunity={(r as any).opportunities}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mt-14">
        <h2 className="text-sm font-medium uppercase tracking-wider text-slate-500">
          Your activity
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <DestinationCard
            href="/dashboard/opportunities/signals"
            title="Your signals"
            description="Opportunities you've created."
            count={signals}
            countLabel="active"
            emptyHint="You haven't signaled a need yet."
          />
          <DestinationCard
            href="/dashboard/opportunities/responses"
            title="Your responses"
            description="Opportunities you've responded to."
            count={responses}
            countLabel={responses === 1 ? 'response' : 'responses'}
            emptyHint="You haven't responded yet."
          />
        </div>
      </section>
    </div>
  );
}

function EmptyFor() {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-8 py-14 text-center">
      <h3 className="text-base font-medium text-slate-900">No opportunities right now</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
        We'll notify you when something highly relevant comes up.
      </p>
      <p className="mt-1 text-xs text-slate-400">
        Opportunities are curated and infrequent.
      </p>
    </div>
  );
}

function DestinationCard({
  href,
  title,
  description,
  count,
  countLabel,
  emptyHint,
}: {
  href: string;
  title: string;
  description: string;
  count: number;
  countLabel: string;
  emptyHint: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col justify-between rounded-lg border border-slate-200 bg-white p-5 transition-colors hover:border-[#1B2850]/50 hover:shadow-sm"
    >
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-medium text-slate-900 group-hover:text-[#1B2850]">{title}</h3>
          {count > 0 && (
            <span className="text-xs text-slate-500">
              {count} {countLabel}
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {count > 0 ? description : emptyHint}
        </p>
      </div>
      <div className="mt-4 text-xs text-slate-400 group-hover:text-[#1B2850]">
        View →
      </div>
    </Link>
  );
}
