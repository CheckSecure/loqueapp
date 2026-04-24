'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';

type Role = 'candidate' | 'provider' | 'recruiter';

type OpportunitySummary = {
  id: string;
  type: 'hiring' | 'business';
  title: string;
  description: string | null;
  urgency: 'low' | 'medium' | 'urgent' | null;
  creator_id?: string | null;
  profiles?: {
    id?: string | null;
    full_name: string | null;
    company: string | null;
    avatar_url?: string | null;
  } | null;
};

const BUTTON_LABEL: Record<Role, string> = {
  candidate: 'Open to this',
  provider: 'I can help',
  recruiter: 'I can take this',
};

const URGENCY_LABEL: Record<'low' | 'medium' | 'urgent', string> = {
  low: 'Low priority',
  medium: 'Moderate',
  urgent: 'Urgent',
};

export function ReceiverCard({
  opportunityId,
  role,
  opportunity,
}: {
  opportunityId: string;
  role: Role;
  opportunity: OpportunitySummary;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  async function respond() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/opportunities/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunity_id: opportunityId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'Could not respond.');
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      setError('Network error.');
      setBusy(false);
    }
  }

  async function dismiss() {
    setBusy(true);
    setHidden(true);
    try {
      await fetch('/api/opportunities/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunity_id: opportunityId }),
      });
      router.refresh();
    } catch {
      setHidden(false);
      setBusy(false);
    }
  }

  if (hidden) return null;

  const creatorId =
    opportunity.profiles?.id ||
    opportunity.creator_id ||
    opportunity.id;
  const creatorName = opportunity.profiles?.full_name || undefined;
  const creatorCompany = opportunity.profiles?.company || undefined;
  const creatorAvatar = opportunity.profiles?.avatar_url || undefined;

  return (
    <article className="group rounded-2xl border border-slate-100 border-l-4 border-l-brand-gold bg-white p-6 sm:p-7 shadow-sm transition-all hover:shadow-md hover:border-slate-200 hover:border-l-brand-gold">
      <div className="flex items-center gap-2">
        <Pill variant="gold" dot>Selected for you</Pill>
        <span className="text-xs text-slate-400">Based on your experience</span>
      </div>

      <h3 className="mt-4 text-xl font-semibold text-slate-900 tracking-tight leading-snug">{opportunity.title}</h3>

      {(creatorName || creatorCompany) && (
        <div className="mt-4 flex items-center gap-3">
          <Avatar
            id={creatorId}
            name={creatorName}
            src={creatorAvatar}
            size="md"
          />
          <div className="min-w-0">
            {creatorName && (
              <div className="text-sm font-medium text-slate-900 truncate">{creatorName}</div>
            )}
            {creatorCompany && (
              <div className="text-xs text-slate-500 truncate">{creatorCompany}</div>
            )}
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
        <span>{opportunity.type === 'hiring' ? 'Hiring' : 'Business need'}</span>
        {opportunity.urgency && (
          <>
            <span>·</span>
            <span className={opportunity.urgency === 'urgent' ? 'text-red-600 font-medium' : ''}>
              {URGENCY_LABEL[opportunity.urgency]}
            </span>
          </>
        )}
      </div>

      {opportunity.description && (
        <p className="mt-4 text-sm leading-relaxed text-slate-700 line-clamp-3">
          {opportunity.description}
        </p>
      )}

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4">
        <Button variant="primary" size="md" onClick={respond} disabled={busy} className="w-full sm:w-auto">
          {BUTTON_LABEL[role]}
        </Button>
        <button
          type="button"
          onClick={dismiss}
          disabled={busy}
          className="text-sm text-slate-500 hover:text-slate-700 underline-offset-4 hover:underline disabled:opacity-60 transition-colors self-center sm:self-auto"
        >
          Not for me
        </button>
      </div>
    </article>
  );
}
