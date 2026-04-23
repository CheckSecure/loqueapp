import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

type Status = 'interested' | 'introduced' | 'withdrawn';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export default async function RespondedOpportunityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const admin = createAdminClient();

  // Access control: the user must have an opportunity_responses row for this
  // opportunity. Without one, notFound() — prevents URL-guessing.
  const { data: response } = await admin
    .from('opportunity_responses')
    .select('id, status, created_at')
    .eq('opportunity_id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!response) notFound();

  // Load the opportunity with creator byline. Description has already been
  // redacted at create time (strip emails/URLs), so it's safe to render.
  const { data: opp } = await admin
    .from('opportunities')
    .select(
      'id, type, title, description, urgency, status, created_at, expires_at, archived_at, ' +
      'profiles!opportunities_creator_id_fkey(full_name, company)'
    )
    .eq('id', id)
    .maybeSingle();

  if (!opp) notFound();

  const creator = (opp as any).profiles;
  const creatorLine = creator
    ? [creator.full_name, creator.company].filter(Boolean).join(' · ')
    : '';

  const isNoLongerActive = ['closed', 'expired', 'dormant'].includes(opp.status) || !!opp.archived_at;
  const status = response.status as Status;

  // For introduced responses, look up the conversation via the match row.
  let conversationId: string | null = null;
  let introducedAt: string | null = null;

  if (status === 'introduced') {
    const { data: match } = await admin
      .from('matches')
      .select('id, matched_at, user_a_id, user_b_id')
      .eq('opportunity_id', id)
      .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`)
      .eq('status', 'active')
      .is('removed_at', null)
      .maybeSingle();
    if (match) {
      introducedAt = match.matched_at;
      const { data: convo } = await admin
        .from('conversations')
        .select('id')
        .eq('match_id', match.id)
        .maybeSingle();
      conversationId = convo?.id ?? null;
    }
  }

  // Status line — order matters: archived/expired/closed win over status.
  let statusLine: string;
  if (isNoLongerActive) {
    statusLine = 'No longer active';
  } else if (status === 'introduced' && introducedAt) {
    statusLine = `Introduced on ${formatDate(introducedAt)}`;
  } else if (status === 'introduced') {
    statusLine = `Introduced on ${formatDate(response.created_at)}`;
  } else if (status === 'withdrawn') {
    statusLine = `Withdrawn on ${formatDate(response.created_at)}`;
  } else {
    statusLine = `Open to this on ${formatDate(response.created_at)}`;
  }

  const canOpenConversation = status === 'introduced' && conversationId && !isNoLongerActive;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href="/dashboard/opportunities/responses"
        className="text-sm text-slate-500 hover:text-slate-700"
      >
        ← Your responses
      </Link>

      <article className="mt-6 rounded-lg border border-slate-200 border-l-4 border-l-[#C4922A] bg-white p-7 shadow-sm">
        <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
          {opp.type === 'hiring' ? 'Hiring' : 'Business need'}
          {opp.urgency && opp.type === 'business' && ` · ${opp.urgency}`}
        </div>

        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{opp.title}</h1>

        {creatorLine && (
          <p className="mt-1 text-sm text-slate-700">{creatorLine}</p>
        )}

        <p className="mt-3 text-xs text-slate-500">{statusLine}</p>

        {opp.description && (
          <div className="mt-6 border-t border-slate-100 pt-6">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
              {opp.description}
            </p>
          </div>
        )}

        <div className="mt-8 flex items-center gap-4">
          {canOpenConversation && (
            <Link
              href={`/dashboard/messages/${conversationId}`}
              className="rounded-md bg-[#1B2850] px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-[#151f3d]"
            >
              Open conversation
            </Link>
          )}
          {isNoLongerActive && status === 'introduced' && conversationId && (
            <Link
              href={`/dashboard/messages/${conversationId}`}
              className="text-sm text-slate-500 hover:text-slate-700"
            >
              View conversation →
            </Link>
          )}
        </div>
      </article>
    </div>
  );
}
