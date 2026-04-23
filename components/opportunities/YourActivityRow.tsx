import Link from 'next/link';

type Status = 'interested' | 'introduced' | 'withdrawn';

const STATUS_LABEL: Record<Status, string> = {
  interested: 'Waiting',
  introduced: 'Introduced',
  withdrawn: 'Withdrawn',
};

const STATUS_TONE: Record<Status, string> = {
  interested: 'text-amber-700',
  introduced: 'text-[#1B2850]',
  withdrawn: 'text-slate-400',
};

export function YourActivityRow({
  status,
  opportunity,
  respondedAt,
  conversationId,
}: {
  status: Status;
  opportunity:
    | {
        id: string;
        title: string;
        type: 'hiring' | 'business';
        status: string;
        profiles?: { full_name: string | null; company: string | null } | null;
      }
    | null;
  respondedAt: string;
  conversationId?: string | null; // retained for backward compat; unused now
}) {
  if (!opportunity) return null;
  const when = new Date(respondedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const creatorLine = opportunity.profiles
    ? [opportunity.profiles.full_name, opportunity.profiles.company].filter(Boolean).join(' · ')
    : '';

  return (
    <Link
      href={`/dashboard/opportunities/responded/${opportunity.id}`}
      className="block"
    >
      <div className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-5 py-4 transition-colors hover:border-[#1B2850]/40 hover:bg-slate-50">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-900">{opportunity.title}</div>
          {creatorLine && (
            <div className="mt-0.5 truncate text-xs text-slate-600">{creatorLine}</div>
          )}
          <div className="mt-0.5 text-xs text-slate-500">
            {opportunity.type === 'hiring' ? 'Hiring' : 'Business need'} · Responded {when}
          </div>
        </div>
        <div className="ml-4 flex flex-col items-end gap-0.5">
          <span className={`text-xs font-medium ${STATUS_TONE[status]}`}>
            {STATUS_LABEL[status]}
          </span>
          <span className="text-xs text-slate-400">View →</span>
        </div>
      </div>
    </Link>
  );
}
