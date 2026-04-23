'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';

type Urgency = 'low' | 'medium' | 'urgent';

const NEED_SUGGESTIONS = ['Litigation support', 'Privacy counsel', 'M&A advisory', 'Employment counsel', 'Tax counsel', 'IP counsel', 'Compliance', 'Regulatory', 'Strategy consulting'];

const URGENCY_COPY: Record<Urgency, { label: string; window: string }> = {
  low: { label: 'Low', window: '30-day window' },
  medium: { label: 'Moderate', window: '14-day window' },
  urgent: { label: 'Urgent', window: '7-day window' },
};

export default function BusinessForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [need, setNeed] = useState('');
  const [industry, setIndustry] = useState('');
  const [urgency, setUrgency] = useState<Urgency>('medium');
  const [expertise, setExpertise] = useState('');
  const [description, setDescription] = useState('');

  async function send() {
    setError(null);
    if (need.trim().length < 3) { setError('Describe the need.'); return; }

    setBusy(true);
    try {
      const res = await fetch('/api/opportunities/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'business',
          title: need.trim(),
          description: description.trim() || undefined,
          urgency,
          criteria: {
            need: need.trim(),
            industry: industry.trim() || undefined,
            expertise: expertise.split(',').map((s) => s.trim()).filter(Boolean),
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'Could not send.');
        setBusy(false);
        return;
      }
      router.push('/dashboard/opportunities?tab=yours');
    } catch {
      setError('Network error.');
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-12">
      <h1 className="text-2xl font-semibold text-slate-900">Business need</h1>
      <p className="mt-2 text-sm text-slate-500">Sent only to 3 highly-relevant providers.</p>

      <div className="mt-8 space-y-5">
        <Field label="Need">
          <input type="text" value={need} onChange={(e) => setNeed(e.target.value)} list="need-suggestions" maxLength={140} placeholder="Privacy counsel" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <datalist id="need-suggestions">
            {NEED_SUGGESTIONS.map((n) => (<option key={n} value={n} />))}
          </datalist>
        </Field>

        <Field label="Industry (optional)">
          <input type="text" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="Fintech" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        </Field>

        <Field label="Urgency">
          <div className="grid grid-cols-3 gap-2">
            {(['low', 'medium', 'urgent'] as Urgency[]).map((u) => (
              <button key={u} type="button" onClick={() => setUrgency(u)} className={`rounded-md border px-3 py-2 text-left ${urgency === u ? 'border-[#1B2850] bg-[#1B2850]/5' : 'border-slate-300 hover:border-slate-400'}`}>
                <div className="text-sm font-medium text-slate-900">{URGENCY_COPY[u].label}</div>
                <div className="text-xs text-slate-500">{URGENCY_COPY[u].window}</div>
              </button>
            ))}
          </div>
        </Field>

        <Field label="Expertise tags (comma-separated)">
          <input type="text" value={expertise} onChange={(e) => setExpertise(e.target.value)} placeholder="privacy, GDPR, ad tech" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <p className="mt-1 text-xs text-slate-500">Must match at least one tag on a provider's profile — strict filter.</p>
        </Field>

        <Field label="Description (optional)">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="Describe the need. Don't include email, phone, or direct contact — Andrel handles introductions."
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-slate-500">Contact details will be removed before providers see this.</p>
        </Field>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex items-center justify-between pt-4">
          <Link href="/dashboard/opportunities/new" className="text-sm text-slate-500 hover:text-slate-700">← Back</Link>
          <button type="button" onClick={send} disabled={busy} className="rounded-md bg-[#1B2850] px-5 py-2 text-sm font-medium text-white hover:bg-[#151f3d] disabled:opacity-60">
            {busy ? 'Sending…' : 'Send signal'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-500">{label}</label>
      {children}
    </div>
  );
}
