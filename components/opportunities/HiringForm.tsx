'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import ExpertisePicker from '@/components/ExpertisePicker';
import ConnectionTargetPicker from '@/components/ConnectionTargetPicker';
import type { CategoryTitleSelection } from '@/lib/role-taxonomy';

const SENIORITY_OPTIONS = ['Junior', 'Mid-Level', 'Senior', 'Executive', 'C-Suite'];
const ROLE_TYPE_OPTIONS = ['In-house Counsel', 'Law firm attorney', 'Consultant', 'Compliance', 'Legal Operations'];

export default function HiringForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [title, setTitle] = useState('');
  const [seniority, setSeniority] = useState('');
  const [industry, setIndustry] = useState('');
  const [expertise, setExpertise] = useState<string[]>([]);
  const [roleTypes, setRoleTypes] = useState<string[]>([]);
  const [targetConnections, setTargetConnections] = useState<CategoryTitleSelection>({});
  const [description, setDescription] = useState('');
  const [includeRecruiters, setIncludeRecruiters] = useState(false);

  function clearError(key: string) {
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  }

  function toggleRoleType(t: string) {
    clearError('role_types');
    setRoleTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  async function send() {
    setFieldErrors({});
    setBusy(true);
    try {
      if (expertise.length < 1) {
        setFieldErrors({ expertise: 'Hiring needs require at least 1 expertise tag.' });
        setBusy(false);
        return;
      }
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
            expertise,
            role_types: roleTypes,
            target_connections: targetConnections,
          },
          include_recruiters: includeRecruiters,
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
      <h1 className="text-2xl font-semibold text-slate-900">Hiring</h1>
      <p className="mt-2 text-sm text-slate-500">Sent only to matched members who are open to new roles.</p>

      <div className="mt-8 space-y-5">
        <Field label="Role title" error={fieldErrors.title}>
          <input
            type="text"
            value={title}
            onChange={(e) => { clearError('title'); setTitle(e.target.value); }}
            maxLength={140}
            placeholder="Senior Privacy Counsel"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </Field>

        <Field label="Seniority" error={fieldErrors.seniority}>
          <select
            value={seniority}
            onChange={(e) => { clearError('seniority'); setSeniority(e.target.value); }}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">Select…</option>
            {SENIORITY_OPTIONS.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        </Field>

        <Field label="Industry (optional)">
          <input type="text" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="Fintech" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        </Field>

        <Field label="Role types to consider" error={fieldErrors.role_types}>
          <div className="flex flex-wrap gap-2">
            {ROLE_TYPE_OPTIONS.map((t) => (
              <button type="button" key={t} onClick={() => toggleRoleType(t)} className={`rounded-full border px-3 py-1 text-xs ${roleTypes.includes(t) ? 'border-[#1B2850] bg-[#1B2850] text-white' : 'border-slate-300 text-slate-600 hover:border-slate-400'}`}>
                {t}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Specific connections (optional)">
          <p className="mb-2 text-xs text-slate-500">Narrow by category or specific titles. Leave empty to use just the role types above.</p>
          <ConnectionTargetPicker value={targetConnections} onChange={setTargetConnections} />
        </Field>

        <Field label="Expertise tags" error={fieldErrors.expertise}>
          <ExpertisePicker
            selected={expertise}
            onChange={(next) => { clearError('expertise'); setExpertise(next); }}
          />
          <p className="mt-1 text-xs text-slate-500">Select at least 1 that matches the role.</p>
        </Field>

        <Field label="Description (optional)" error={fieldErrors.description}>
          <textarea
            value={description}
            onChange={(e) => { clearError('description'); setDescription(e.target.value); }}
            maxLength={2000}
            rows={4}
            placeholder="Describe the role. Don't include email addresses, phone numbers, or direct contact info — Andrel handles introductions."
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-slate-500">Contact details will be removed before candidates see this.</p>
        </Field>

        <label className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-4">
          <input type="checkbox" checked={includeRecruiters} onChange={(e) => setIncludeRecruiters(e.target.checked)} className="mt-0.5" />
          <div>
            <div className="text-sm font-medium text-slate-900">Include recruiters</div>
            <p className="mt-0.5 text-xs text-slate-500">Only recruiters already in your network will be notified.</p>
          </div>
        </label>

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
