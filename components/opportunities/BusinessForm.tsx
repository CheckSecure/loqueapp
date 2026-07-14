'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import SearchableExpertiseSelect from '@/components/SearchableExpertiseSelect';
import { DELIVERY_CEILING } from '@/lib/opportunities/caps';

type Urgency = 'low' | 'medium' | 'urgent';

const NEED_SUGGESTIONS = ['Litigation support', 'Privacy counsel', 'M&A advisory', 'Employment counsel', 'Tax counsel', 'IP counsel', 'Compliance', 'Regulatory', 'Strategy consulting'];

const URGENCY_COPY: Record<Urgency, { label: string; window: string }> = {
  low: { label: 'Low', window: '30-day window' },
  medium: { label: 'Moderate', window: '14-day window' },
  urgent: { label: 'Urgent', window: '7-day window' },
};

// Compact quick-add row. Values MUST be valid EXPERTISE_OPTIONS so they feed the
// same selected-expertise state (and matching) as the searchable selector.
const POPULAR_EXPERTISE = [
  'AI', 'Privacy', 'Cybersecurity', 'Finance', 'Healthcare',
  'Marketing', 'Operations', 'Sales', 'Litigation', 'M&A',
];

const SPECIFIC_HINT_MAX = 200;

export default function BusinessForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [need, setNeed] = useState('');
  const [industry, setIndustry] = useState('');
  const [urgency, setUrgency] = useState<Urgency>('medium');
  const [expertise, setExpertise] = useState<string[]>([]);
  const [specificHint, setSpecificHint] = useState('');
  const [description, setDescription] = useState('');

  function clearError(key: string) {
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  }

  function togglePopular(tag: string) {
    clearError('expertise');
    setExpertise((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
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
            specific_hint: specificHint.trim() || undefined,
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

      {/* Estimated reach — reuses the known business delivery ceiling. */}
      <div className="mt-4 rounded-lg border border-brand-gold/20 bg-brand-gold-soft/40 px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-brand-gold">Estimated recipients</p>
        <p className="mt-0.5 text-sm text-slate-600">
          Approximately {DELIVERY_CEILING.business} highly relevant providers will receive this request.
        </p>
      </div>

      <div className="mt-8 space-y-5">
        <Field label="What do you need?" error={fieldErrors.title}>
          <input
            type="text"
            value={need}
            onChange={(e) => { clearError('title'); setNeed(e.target.value); }}
            list="need-suggestions"
            maxLength={140}
            placeholder="Privacy counsel, cybersecurity assessment, executive coach..."
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

        <Field label="Helpful expertise *" error={fieldErrors.expertise}>
          <p className="mb-2 text-xs text-slate-500">Search and select at least two areas that match your need.</p>
          <div className="mb-2">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">Popular</p>
            <div className="flex flex-wrap gap-1.5">
              {POPULAR_EXPERTISE.map((tag) => {
                const active = expertise.includes(tag);
                return (
                  <button
                    type="button"
                    key={tag}
                    onClick={() => togglePopular(tag)}
                    disabled={active}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${active ? 'border-[#1B2850] bg-[#1B2850] text-white opacity-60' : 'border-slate-300 text-slate-600 hover:border-[#1B2850]/40'}`}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>
          <SearchableExpertiseSelect
            selected={expertise}
            onChange={(next) => { clearError('expertise'); setExpertise(next); }}
          />
        </Field>

        <Field label="Looking for someone specific? (optional)">
          <p className="mb-2 text-xs text-slate-500">Company, organization, person, or short description.</p>
          <input
            type="text"
            value={specificHint}
            onChange={(e) => setSpecificHint(e.target.value)}
            maxLength={SPECIFIC_HINT_MAX}
            placeholder="Someone at OpenAI, a former SEC attorney, or a healthcare privacy expert"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </Field>

        <Field label="Anything providers should know? (optional)" error={fieldErrors.description}>
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
