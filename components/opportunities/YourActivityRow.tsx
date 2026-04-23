type Status = 'interested' | 'introduced' | 'withdrawn';

const STATUS_LABEL: Record<Status, string> = {
  interested: 'Waiting',
  introduced: 'Introduced',
  withdrawn: 'Withdrawn',
};

export function YourActivityRow({
  status,
  opportunity,
  respondedAt,
}: {
  status: Status;
  opportunity: { id: string; title: string; type: 'hiring' | 'business'; status: string } | null;
  respondedAt: string;
}) {
  if (!opportunity) return null;
  const when = new Date(respondedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-5 py-4">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-900">{opportunity.title}</div>
        <div className="mt-0.5 text-xs text-slate-500">
          {opportunity.type === 'hiring' ? 'Hiring' : 'Business need'} · Responded {when}
        </div>
      </div>
      <span className="ml-4 text-xs text-slate-500">{STATUS_LABEL[status]}</span>
    </div>
  );
}
