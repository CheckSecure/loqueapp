import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { TIER_OPPORTUNITY_LIMIT, type Tier } from '@/lib/opportunities/caps';
import { ReceiverCard } from '@/components/opportunities/ReceiverCard';
import { YourActivityRow } from '@/components/opportunities/YourActivityRow';
import { YoursRow } from '@/components/opportunities/YoursRow';

export const dynamic = 'force-dynamic';

type Tab = 'for-you' | 'activity' | 'yours';

function isValidTab(t: string | undefined): t is Tab {
  return t === 'for-you' || t === 'activity' || t === 'yours';
}

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const tab: Tab = isValidTab(params.tab) ? params.tab : 'for-you';

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

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Opportunities</h1>
          <p className="mt-1 text-sm text-slate-500">Private signals, shared only with a curated few.</p>
        </div>
        {canCreate ? (
          <Link href="/dashboard/opportunities/new" className="rounded-md bg-[#1B2850] px-4 py-2 text-sm font-medium text-white hover:bg-[#151f3d]">
            Signal a need
          </Link>
        ) : (
          <span className="text-xs text-slate-400">Upgrade to Professional to signal.</span>
        )}
      </div>

      <nav className="mt-8 flex gap-6 border-b border-slate-200">
        <TabLink active={tab === 'for-you'} href="?tab=for-you">For you</TabLink>
        <TabLink active={tab === 'activity'} href="?tab=activity">Your activity</TabLink>
        <TabLink active={tab === 'yours'} href="?tab=yours">Yours</TabLink>
      </nav>

      <div className="mt-8">
        {tab === 'for-you' && <ForYouPanel userId={user.id} />}
        {tab === 'activity' && <ActivityPanel userId={user.id} />}
        {tab === 'yours' && <YoursPanel userId={user.id} canCreate={canCreate} />}
      </div>
    </div>
  );
}

function TabLink({ active, href, children }: { active: boolean; href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={`border-b-2 pb-3 text-sm ${active ? 'border-[#1B2850] text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
      {children}
    </Link>
  );
}

async function ForYouPanel({ userId }: { userId: string }) {
  const admin = createAdminClient();
  const { data: rows } = await admin
    .from('opportunity_candidates')
    .select('id, opportunity_id, role, opportunities!inner(id, creator_id, type, title, description, urgency, status, expires_at)')
    .eq('user_id', userId)
    .is('dismissed_at', null)
    .eq('opportunities.status', 'active')
    .order('shown_at', { ascending: false })
    .limit(5);

  const ids = (rows ?? []).map((r) => r.opportunity_id);
  let respondedSet = new Set<string>();
  if (ids.length > 0) {
    const { data: responded } = await admin
      .from('opportunity_responses')
      .select('opportunity_id')
      .eq('user_id', userId)
      .in('opportunity_id', ids);
    respondedSet = new Set((responded ?? []).map((r) => r.opportunity_id));
  }
  const visible = (rows ?? []).filter((r) => !respondedSet.has(r.opportunity_id));

  if (visible.length === 0) return <EmptyState title="Nothing matched yet." />;

  return (
    <div className="space-y-4">
      {visible.map((r) => (
        <ReceiverCard key={r.id} opportunityId={r.opportunity_id} role={r.role as any} opportunity={(r as any).opportunities} />
      ))}
    </div>
  );
}

async function ActivityPanel({ userId }: { userId: string }) {
  const admin = createAdminClient();
  const { data } = await admin
    .from('opportunity_responses')
    .select('id, opportunity_id, status, created_at, opportunities(id, title, type, status)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  const rows = data ?? [];
  if (rows.length === 0) return <EmptyState title="You haven't responded to anything yet." />;

  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <YourActivityRow key={r.id} status={r.status as any} opportunity={(r as any).opportunities} respondedAt={r.created_at} />
      ))}
    </div>
  );
}

async function YoursPanel({ userId, canCreate }: { userId: string; canCreate: boolean }) {
  const admin = createAdminClient();
  const { data } = await admin
    .from('opportunities')
    .select('id, type, title, status, expires_at, urgency, created_at')
    .eq('creator_id', userId)
    .order('created_at', { ascending: false });

  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        title="You haven't signaled a need."
        cta={canCreate ? (
          <Link href="/dashboard/opportunities/new" className="inline-block rounded-md bg-[#1B2850] px-4 py-2 text-sm font-medium text-white">Signal a need</Link>
        ) : (
          <p className="text-xs text-slate-400">Upgrade to Professional to signal.</p>
        )}
      />
    );
  }

  const oppIds = rows.map((r) => r.id);
  const { data: responses } = await admin
    .from('opportunity_responses')
    .select('opportunity_id, status')
    .in('opportunity_id', oppIds);
  const waitingByOpp = new Map<string, number>();
  (responses ?? []).forEach((r) => {
    if (r.status === 'interested') {
      waitingByOpp.set(r.opportunity_id, (waitingByOpp.get(r.opportunity_id) ?? 0) + 1);
    }
  });

  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <YoursRow key={r.id} opportunity={r as any} waitingCount={waitingByOpp.get(r.id) ?? 0} />
      ))}
    </div>
  );
}

function EmptyState({ title, cta }: { title: string; cta?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-8 text-center">
      <p className="text-sm text-slate-500">{title}</p>
      {cta && <div className="mt-4">{cta}</div>}
    </div>
  );
}
