'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

function parseExpertise(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((s) => String(s));
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '{}' || trimmed === '[]') return [];
  if (trimmed.startsWith('[')) {
    try { const j = JSON.parse(trimmed); return Array.isArray(j) ? j.map(String) : []; }
    catch { return []; }
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1);
    if (inner === '') return [];
    const out = [];
    let buf = '', inQ = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '"' && inner[i - 1] !== '\\') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { out.push(buf.trim()); buf = ''; continue; }
      buf += ch;
    }
    if (buf.length > 0) out.push(buf.trim());
    return out.filter((s) => s.length > 0);
  }
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

type Responder = {
  id: string;
  user_id: string;
  status: 'interested' | 'introduced' | 'withdrawn';
  conversation_id?: string | null;
  is_new?: boolean;
  profiles: {
    id: string;
    full_name: string | null;
    title: string | null;
    company: string | null;
    bio: string | null;
    avatar_url: string | null;
    expertise: string[] | string | null;
  };
};

export function ResponderRow({
  opportunityId,
  responder,
  canIntroduce,
  onIntroduced,
}: {
  opportunityId: string;
  responder: Responder;
  canIntroduce: boolean;
  onIntroduced?: (args: { conversationId: string; responderName: string }) => void;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declineConfirming, setDeclineConfirming] = useState(false);
  const [declineBusy, setDeclineBusy] = useState(false);

  const p = responder.profiles;
  const displayName = p?.full_name || 'Member';
  const roleLine = [p?.title, p?.company].filter(Boolean).join(' · ');

  async function introduce() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/opportunities/introduce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunity_id: opportunityId, response_id: responder.id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'Could not introduce.');
        setBusy(false);
        setConfirming(false);
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (onIntroduced && body?.conversation_id) {
        onIntroduced({ conversationId: body.conversation_id, responderName: displayName });
      }
      router.refresh();
    } catch {
      setError('Something went wrong.');
      setBusy(false);
      setConfirming(false);
    }
  }

  async function decline() {
    setDeclineBusy(true);
    try {
      const res = await fetch('/api/opportunities/decline-response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_id: responder.id }),
      });
      if (!res.ok) {
        setDeclineBusy(false);
        setDeclineConfirming(false);
        return;
      }
      setDeclineBusy(false);
      setDeclineConfirming(false);
      router.refresh();
    } catch {
      setDeclineBusy(false);
      setDeclineConfirming(false);
    }
  }

  const isNew = responder.is_new && responder.status === 'interested';
  const borderClass = isNew
    ? 'rounded-md border border-slate-200 border-l-4 border-l-[#C4922A] bg-white p-5'
    : 'rounded-md border border-slate-200 bg-white p-5';

  return (
    <div className={borderClass}>
      <div className="flex items-start gap-4">
        {p?.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.avatar_url} alt="" className="h-12 w-12 flex-shrink-0 rounded-full object-cover" />
        ) : (
          <div className="h-12 w-12 flex-shrink-0 rounded-full bg-slate-200" />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium text-slate-900">{displayName}</div>
            {isNew && (
              <span className="rounded-full bg-[#C4922A]/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[#C4922A]">
                New
              </span>
            )}
          </div>
          {roleLine && <div className="text-xs text-slate-500">{roleLine}</div>}
          {p?.bio && <p className="mt-2 line-clamp-2 text-sm text-slate-700">{p.bio}</p>}
          {(() => {
            const expertiseTags = parseExpertise(p?.expertise);
            if (expertiseTags.length === 0) return null;
            return (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {expertiseTags.slice(0, 5).map((tag) => (
                  <span key={tag} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                    {tag}
                  </span>
                ))}
              </div>
            );
          })()}
        </div>

        {responder.status === 'introduced' ? (
          responder.conversation_id ? (
            <Link
              href={`/dashboard/messages/${responder.conversation_id}`}
              className="ml-4 rounded-md border border-[#1B2850] px-3 py-1.5 text-xs font-medium text-[#1B2850] hover:bg-[#1B2850] hover:text-white"
            >
              Open conversation →
            </Link>
          ) : (
            <span className="ml-4 text-xs font-medium text-[#1B2850]">Introduced</span>
          )
        ) : canIntroduce ? (
          <div className="ml-4 flex flex-shrink-0 flex-col items-end gap-2">
            {confirming ? (
              <div className="flex gap-2">
                <button type="button" onClick={introduce} disabled={busy} className="rounded-md bg-[#1B2850] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60">
                  {busy ? 'Introducing…' : 'Confirm'}
                </button>
                <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="text-xs text-slate-500 hover:text-slate-700">
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} className="rounded-md border border-[#1B2850] px-3 py-1.5 text-xs font-medium text-[#1B2850] hover:bg-[#1B2850] hover:text-white">
                Introduce
              </button>
            )}
            {!declineConfirming ? (
              <button
                type="button"
                onClick={() => setDeclineConfirming(true)}
                disabled={busy || confirming}
                className="text-xs text-slate-500 hover:text-slate-700 disabled:opacity-40"
              >
                Not a fit
              </button>
            ) : (
              <div className="flex flex-col items-end gap-1">
                <span className="text-xs text-slate-600">Remove this response from your active list?</span>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={decline} disabled={declineBusy} className="text-xs font-medium text-red-600 hover:underline disabled:opacity-60">
                    {declineBusy ? 'Removing…' : 'Remove'}
                  </button>
                  <button type="button" onClick={() => setDeclineConfirming(false)} className="text-xs text-slate-500 hover:text-slate-700">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
    </div>
  );
}
