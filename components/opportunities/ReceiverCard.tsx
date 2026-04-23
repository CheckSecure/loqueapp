'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Role = 'candidate' | 'provider' | 'recruiter';

type OpportunitySummary = {
  id: string;
  type: 'hiring' | 'business';
  title: string;
  description: string | null;
  urgency: 'low' | 'medium' | 'urgent' | null;
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

  return (
    <article className="rounded-lg border border-[#C4922A]/30 bg-[#FDF9F0] p-6 shadow-sm">
      <div className="text-[11px] font-medium uppercase tracking-wider text-[#C4922A]">
        You were selected for this
      </div>
      <div className="mt-0.5 text-[11px] text-slate-500">Based on your experience</div>

      <h3 className="mt-2 text-lg font-semibold text-slate-900">{opportunity.title}</h3>

      <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
        <span className="capitalize">{opportunity.type === 'hiring' ? 'Hiring' : 'Business need'}</span>
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
        <p className="mt-3 text-sm leading-relaxed text-slate-700 line-clamp-3">
          {opportunity.description}
        </p>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={respond} disabled={busy} className="rounded-md bg-[#1B2850] px-4 py-2 text-sm font-medium text-white hover:bg-[#151f3d] disabled:opacity-60">
          {BUTTON_LABEL[role]}
        </button>
        <button type="button" onClick={dismiss} disabled={busy} className="text-sm text-slate-500 hover:text-slate-700 disabled:opacity-60">
          Not for me
        </button>
      </div>
    </article>
  );
}
