import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { YourActivityRow } from '@/components/opportunities/YourActivityRow';

export const dynamic = 'force-dynamic';

export default async function YourResponsesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const admin = createAdminClient();

  const { data } = await admin
    .from('opportunity_responses')
    .select('id, opportunity_id, status, created_at, opportunities(id, title, type, status, profiles!opportunities_creator_id_fkey(full_name, company))')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  const rows = data ?? [];

  const introducedOppIds = rows.filter((r) => r.status === 'introduced').map((r) => r.opportunity_id);
  const convoByOpp = new Map();
  if (introducedOppIds.length > 0) {
    const { data: mrows } = await admin
      .from('matches')
      .select('id, opportunity_id, user_a_id, user_b_id')
      .in('opportunity_id', introducedOppIds)
      .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`)
      .eq('status', 'active');
    const matchIds = (mrows ?? []).map((m) => m.id);
    if (matchIds.length > 0) {
      const { data: convos } = await admin
        .from('conversations')
        .select('id, match_id')
        .in('match_id', matchIds);
      const convoByMatch = new Map((convos ?? []).map((c) => [c.match_id, c.id]));
      (mrows ?? []).forEach((m) => {
        const cid = convoByMatch.get(m.id);
        if (cid && m.opportunity_id) convoByOpp.set(m.opportunity_id, cid);
      });
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/dashboard/opportunities" className="text-sm text-slate-500 hover:text-slate-700">
        ← Opportunities
      </Link>

      <div className="mt-5">
        <h1 className="text-2xl font-semibold text-slate-900">Your responses</h1>
        <p className="mt-1 text-sm text-slate-500">Opportunities you've responded to.</p>
      </div>

      <div className="mt-8">
        {rows.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white px-8 py-14 text-center">
            <h3 className="text-base font-medium text-slate-900">You haven't responded yet</h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
              When you accept an opportunity, it will appear here.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => (
              <YourActivityRow
                key={r.id}
                status={r.status as 'interested' | 'introduced' | 'withdrawn'}
                opportunity={(r as any).opportunities}
                respondedAt={r.created_at}
                conversationId={convoByOpp.get(r.opportunity_id) ?? null}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
