'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';

const SENIORITY_OPTIONS = ['Junior', 'Mid-Level', 'Senior', 'Executive', 'C-Suite'];
const ROLE_TYPE_OPTIONS = ['In-house Counsel', 'Law firm attorney', 'Consultant', 'Compliance', 'Legal Operations'];

export default function HiringForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [seniority, setSeniority] = useState('');
  const [industry, setIndustry] = useState('');
  const [expertise, setExpertise] = useState('');
  const [roleTypes, setRoleTypes] = useState<string[]>([]);
  const [description, setDescription] = useState('');
  const [includeRecruiters, setIncludeRecruiters] = useState(false);

  function toggleRoleType(t: string) {
    setRoleTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  async function send() {
    setError(null);
    if (title.trim().length < 3) { setError('Give it a short title.'); return; }
    if (!seniority) { setError('Seniority is required.'); return; }

    setBusy(true);
    try {
      const res = await fetch('/api/opportunities/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'hiring',
          title: title.trim(),
          description: description.trim() || undefined,
          criteria: {
            role_title: title.trim(),
            seniority,
            industry: industry.trim() || undefined,
            expertise: expertise.split(',').map((s) => s.trim()).filter(Boolean),
            role_types: roleTypes,
          },
          include_recruiters: includeRecruiters,
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
      <h1 className="text-2xl font-semibold text-slate-900">Hiring</h1>
      <p className="mt-2 text-sm text-slate-500">Sent only to matched members who are open to new roles.</p>

      <div className="mt-8 space-y-5">
        <Field label="Role title">
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} placeholder="Senior Privacy Counsel" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        </Field>

        <Field label="Seniority">
          <select value={seniority} onChange={(e) => setSeniority(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
            <option value="">Select…</option>
            {SENIORITY_OPTIONS.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        </Field>

        <Field label="Industry (optional)">
          <input type="text" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="Fintech" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        </Field>

        <Field label="Role types to consider">
          <div className="flex flex-wrap gap-2">
            {ROLE_TYPE_OPTIONS.map((t) => (
              <button type="button" key={t} onClick={() => toggleRoleType(t)} className={`rounded-full border px-3 py-1 text-xs ${roleTypes.includes(t) ? 'border-[#1B2850] bg-[#1B2850] text-white' : 'border-slate-300 text-slate-600 hover:border-slate-400'}`}>
                {t}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Expertise tags (comma-separated, optional)">
          <input type="text" value={expertise} onChange={(e) => setExpertise(e.target.value)} placeholder="privacy, GDPR, ad tech" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        </Field>

        <Field label="Description (optional)">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={4} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        </Field>

        <label className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-4">
          <input type="checkbox" checked={includeRecruiters} onChange={(e) => setIncludeRecruiters(e.target.checked)} className="mt-0.5" />
          <div>
            <div className="text-sm font-medium text-slate-900">Include recruiters</div>
            <p className="mt-0.5 text-xs text-slate-500">Only recruiters already in your network will be notified.</p>
          </div>
        </label>

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
