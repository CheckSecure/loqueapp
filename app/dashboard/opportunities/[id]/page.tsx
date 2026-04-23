import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { TouchOnMount } from '@/components/opportunities/TouchOnMount';
import { ResponderRow } from '@/components/opportunities/ResponderRow';
import { IntroducedBannerHost } from '@/components/opportunities/IntroducedBannerHost';
import { CloseButton } from '@/components/opportunities/CloseButton';

export const dynamic = 'force-dynamic';

export default async function OpportunityDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const admin = createAdminClient();

  const { data: opp } = await admin
    .from('opportunities')
    .select('id, creator_id, type, title, description, urgency, status, created_at, expires_at')
    .eq('id', id)
    .maybeSingle();

  if (!opp) notFound();
  if (opp.creator_id !== user.id) notFound();

  const { data: responses } = await admin
    .from('opportunity_responses')
    .select('id, user_id, role, status, created_at, profiles!opportunity_responses_user_id_fkey(id, full_name, title, company, bio, avatar_url, expertise, seniority, role_type)')
    .eq('opportunity_id', id)
    .is('declined_by_creator_at', null)
    .order('created_at', { ascending: true });

  // Capture unseen interested responses BEFORE marking them seen, so we can
  // show NEW badges on this render. Next render they will not be unseen.
  const unseenIds = new Set((responses ?? []).filter((r) => r.status === 'interested' && !r.seen_by_creator_at).map((r) => r.id));

  // Mark all interested responses as seen on detail-page view (fire-and-forget).
  if (unseenIds.size > 0) {
    await admin
      .from('opportunity_responses')
      .update({ seen_by_creator_at: new Date().toISOString() })
      .in('id', Array.from(unseenIds));
  }

  const waiting = (responses ?? []).filter((r) => r.status === 'interested');
  const waitingWithFlag = waiting.map((r) => ({ ...r, is_new: unseenIds.has(r.id) }));
  const introduced = (responses ?? []).filter((r) => r.status === 'introduced');

  // Attach conversation_id to introduced rows so they render "Open conversation".
  const introducedUserIds = introduced.map((r) => r.user_id);
  let convoByUser = new Map<string, string>();
  if (introducedUserIds.length > 0) {
    const { data: oppMatches } = await admin
      .from('matches')
      .select('id, user_a_id, user_b_id')
      .eq('opportunity_id', opp.id);
    const matchIds = (oppMatches ?? []).map((m) => m.id);
    if (matchIds.length > 0) {
      const { data: convos } = await admin
        .from('conversations')
        .select('id, match_id')
        .in('match_id', matchIds);
      const matchToConvo = new Map<string, string>();
      (convos ?? []).forEach((c) => matchToConvo.set(c.match_id, c.id));
      (oppMatches ?? []).forEach((m) => {
        const peer = m.user_a_id === opp.creator_id ? m.user_b_id : m.user_a_id;
        const cid = matchToConvo.get(m.id);
        if (cid) convoByUser.set(peer, cid);
      });
    }
  }
  const introducedWithConvo = introduced.map((r) => ({
    ...r,
    conversation_id: convoByUser.get(r.user_id) ?? null,
  }));

  const expiresAt = new Date(opp.expires_at);
  const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86400_000));
  const isClosedOrExpired = opp.status === 'closed' || opp.status === 'expired';

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <TouchOnMount opportunityId={opp.id} />

      <Link href="/dashboard/opportunities?tab=yours" className="text-sm text-slate-500 hover:text-slate-700">← Opportunities</Link>

      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
              {opp.type === 'hiring' ? 'Hiring' : 'Business need'}
              {opp.urgency && <> · {opp.urgency}</>}
            </div>
            <h1 className="mt-1 text-2xl font-semibold text-slate-900">{opp.title}</h1>
            <div className="mt-2 text-xs text-slate-500">
              {opp.status === 'active' && `${daysLeft} days left`}
              {opp.status === 'dormant' && 'Dormant — visits will reactivate'}
              {opp.status === 'closed' && 'Closed'}
              {opp.status === 'expired' && 'Expired'}
            </div>
          </div>
          {!isClosedOrExpired && <CloseButton opportunityId={opp.id} />}
        </div>

        {opp.description && (
          <p className="mt-5 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{opp.description}</p>
        )}
      </div>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-slate-900">People ready to connect</h2>
        <p className="mt-1 text-xs text-slate-500">
          {waiting.length === 0 ? 'No responses yet.' : `${waiting.length} waiting`}
        </p>

        <IntroducedBannerHost
          opportunityId={opp.id}
          waiting={waitingWithFlag as any}
          canIntroduce={!isClosedOrExpired}
        />
      </section>

      {introducedWithConvo.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-slate-900">Introduced</h2>
          <div className="mt-4 space-y-3">
            {introducedWithConvo.map((r) => (
              <ResponderRow key={r.id} opportunityId={opp.id} responder={r as any} canIntroduce={false} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
