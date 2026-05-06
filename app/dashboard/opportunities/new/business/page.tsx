'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import ExpertisePicker from '@/components/ExpertisePicker';

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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [need, setNeed] = useState('');
  const [industry, setIndustry] = useState('');
  const [urgency, setUrgency] = useState<Urgency>('medium');
  const [expertise, setExpertise] = useState<string[]>([]);
  const [description, setDescription] = useState('');

  function clearError(key: string) {
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  }

  async function send() {
    setFieldErrors({});
    setBusy(true);
    try {
      if (expertise.length < 2) {
        setFieldErrors({ expertise: 'Business needs require at least 2 expertise tags.' });
        setBusy(false);
        return;
      }
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
            expertise,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body && body.fields && typeof body.fields === 'object') {
          setFieldErrors(body.fields);
        } else {
          setFieldErrors({ _root: body.error || 'Could not send.' });
        }
        setBusy(false);
        return;
      }
      router.push('/dashboard/opportunities?tab=yours');
    } catch {
      setFieldErrors({ _root: 'Network error.' });
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-12">
      <h1 className="text-2xl font-semibold text-slate-900">Business need</h1>
      <p className="mt-2 text-sm text-slate-500">Sent only to 3 highly-relevant providers.</p>

      <div className="mt-8 space-y-5">
        <Field label="Need" error={fieldErrors.title}>
          <input
            type="text"
            value={need}
            onChange={(e) => { clearError('title'); setNeed(e.target.value); }}
            list="need-suggestions"
            maxLength={140}
            placeholder="Privacy counsel"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <datalist id="need-suggestions">
            {NEED_SUGGESTIONS.map((n) => (<option key={n} value={n} />))}
          </datalist>
        </Field>

        <Field label="Industry (optional)">
          <input type="text" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="Fintech" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        </Field>

        <Field label="Urgency" error={fieldErrors.urgency}>
          <div className="grid grid-cols-3 gap-2">
            {(['low', 'medium', 'urgent'] as Urgency[]).map((u) => (
              <button key={u} type="button" onClick={() => { clearError('urgency'); setUrgency(u); }} className={`rounded-md border px-3 py-2 text-left ${urgency === u ? 'border-[#1B2850] bg-[#1B2850]/5' : 'border-slate-300 hover:border-slate-400'}`}>
                <div className="text-sm font-medium text-slate-900">{URGENCY_COPY[u].label}</div>
                <div className="text-xs text-slate-500">{URGENCY_COPY[u].window}</div>
              </button>
            ))}
          </div>
        </Field>

        <Field label="Expertise tags" error={fieldErrors.expertise}>
          <ExpertisePicker
            selected={expertise}
            onChange={(next) => { clearError('expertise'); setExpertise(next); }}
          />
          <p className="mt-1 text-xs text-slate-500">Select at least 2. Must match tags on provider profiles.</p>
        </Field>

        <Field label="Description (optional)" error={fieldErrors.description}>
          <textarea
            value={description}
            onChange={(e) => { clearError('description'); setDescription(e.target.value); }}
            maxLength={2000}
            rows={4}
            placeholder="Describe the need. Don't include email, phone, or direct contact — Andrel handles introductions."
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-slate-500">Contact details will be removed before providers see this.</p>
        </Field>

        {fieldErrors._root && <p className="text-sm text-red-600">{fieldErrors._root}</p>}

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

function Field({ label, children, error }: { label: string; children: React.ReactNode; error?: string }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-500">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
