import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { TIER_OPPORTUNITY_LIMIT, type Tier } from '@/lib/opportunities/caps';
import { ReceiverCard } from '@/components/opportunities/ReceiverCard';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Inbox } from 'lucide-react';

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

  // Mark all currently-visible candidate rows as seen. This feeds the
  // 'unseen' count used by the soft-nudge cron. Fire-and-forget.
  const forYouCandidateIds = (forYouRows ?? []).map((r) => r.id);
  if (forYouCandidateIds.length > 0) {
    await admin
      .from('opportunity_candidates')
      .update({ viewed_at: new Date().toISOString() })
      .in('id', forYouCandidateIds)
      .is('viewed_at', null);
  }

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
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Opportunities</h1>
          <p className="mt-2 text-sm text-slate-500">
            Private, curated signals — no noise, no browsing.
          </p>
        </div>
        {canCreate && (
          <Link href="/dashboard/opportunities/new">
            <Button variant="primary" size="md">Signal a need</Button>
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
          <h2 className="text-base font-semibold text-slate-900">
            For you
          </h2>
          <p className="mt-1 text-sm text-slate-500">
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
        <h2 className="text-base font-semibold text-slate-900">
          Your activity
        </h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
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
    <EmptyState
      icon={<Inbox className="w-6 h-6 text-slate-400" />}
      title="No opportunities right now"
      description="We'll notify you when something highly relevant comes up. Opportunities are curated and infrequent."
    />
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
      className="group flex flex-col justify-between rounded-2xl border border-slate-100 bg-white p-6 shadow-sm transition-all hover:border-brand-navy/40 hover:shadow-md"
    >
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-900 group-hover:text-brand-navy">{title}</h3>
          {count > 0 && (
            <span className="text-xs font-medium text-slate-500">
              {count} {countLabel}
            </span>
          )}
        </div>
        <p className="mt-2 text-sm text-slate-500 leading-relaxed">
          {count > 0 ? description : emptyHint}
        </p>
      </div>
      <div className="mt-6 text-sm font-medium text-slate-400 group-hover:text-brand-navy transition-colors">
        View <span className="inline-block transition-transform group-hover:translate-x-0.5">&rarr;</span>
      </div>
    </Link>
  );
}
