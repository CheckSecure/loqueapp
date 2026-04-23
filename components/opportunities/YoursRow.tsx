import Link from 'next/link';

type Opportunity = {
  id: string;
  type: 'hiring' | 'business';
  title: string;
  status: 'active' | 'dormant' | 'closed' | 'expired';
  urgency: 'low' | 'medium' | 'urgent' | null;
  expires_at: string;
  created_at: string;
};

const STATUS_LABEL: Record<Opportunity['status'], string> = {
  active: 'Active',
  dormant: 'Dormant',
  closed: 'Closed',
  expired: 'Expired',
};

const STATUS_TONE: Record<Opportunity['status'], string> = {
  active: 'text-[#1B2850]',
  dormant: 'text-amber-700',
  closed: 'text-slate-400',
  expired: 'text-slate-400',
};

export function YoursRow({
  opportunity,
  waitingCount,
}: {
  opportunity: Opportunity;
  waitingCount: number;
}) {
  const expiresSoon = opportunity.status === 'active' && new Date(opportunity.expires_at).getTime() - Date.now() < 3 * 86400_000;

  return (
    <Link href={`/dashboard/opportunities/${opportunity.id}`} className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-5 py-4 hover:border-[#1B2850]/40">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3">
          <span className="truncate text-sm font-medium text-slate-900">{opportunity.title}</span>
          {waitingCount > 0 && opportunity.status === 'active' && (
            <span className="rounded-full bg-[#C4922A]/15 px-2 py-0.5 text-[11px] font-medium text-[#C4922A]">{waitingCount} waiting</span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-slate-500">
          {opportunity.type === 'hiring' ? 'Hiring' : 'Business need'}
          {opportunity.urgency && opportunity.type === 'business' && (<> · {opportunity.urgency}</>)}
          {expiresSoon && <span className="ml-2 text-red-600">Expires soon</span>}
        </div>
      </div>
      <span className={`ml-4 text-xs ${STATUS_TONE[opportunity.status]}`}>{STATUS_LABEL[opportunity.status]}</span>
    </Link>
  );
}
