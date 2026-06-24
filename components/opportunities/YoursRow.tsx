import Link from 'next/link';
import { ArchiveAction } from './ArchiveAction';

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
  active: 'text-brand-navy',
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
  const expiresSoon =
    opportunity.status === 'active' &&
    new Date(opportunity.expires_at).getTime() - Date.now() < 3 * 86400_000;
  const isTerminal = opportunity.status === 'closed' || opportunity.status === 'expired';

  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-200/70 bg-white px-5 py-4 transition-all hover:border-brand-navy/30 hover:shadow-sm">
      <Link
        href={`/dashboard/opportunities/${opportunity.id}`}
        className="flex min-w-0 flex-1 items-center justify-between"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span className="truncate text-sm font-semibold text-brand-navy">{opportunity.title}</span>
            {waitingCount > 0 && opportunity.status === 'active' && (
              <span className="rounded-full bg-brand-gold-soft border border-brand-gold/20 px-2 py-0.5 text-[11px] font-medium text-brand-gold">
                {waitingCount} waiting
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {opportunity.type === 'hiring' ? 'Hiring' : 'Business need'}
            {opportunity.urgency && opportunity.type === 'business' && (<> · {opportunity.urgency}</>)}
            {expiresSoon && <span className="ml-2 text-red-600">Expires soon</span>}
          </div>
        </div>
        <span className={`ml-4 text-xs ${STATUS_TONE[opportunity.status]}`}>
          {STATUS_LABEL[opportunity.status]}
        </span>
      </Link>
      {isTerminal && (
        <div className="ml-3 flex-shrink-0">
          <ArchiveAction opportunityId={opportunity.id} />
        </div>
      )}
    </div>
  );
}
