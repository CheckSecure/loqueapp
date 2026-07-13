'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import SearchableExpertiseSelect from '@/components/SearchableExpertiseSelect';
import RolePicker from '@/components/opportunities/RolePicker';

const SENIORITY_OPTIONS = ['Junior', 'Mid-Level', 'Senior', 'Executive', 'C-Suite'];

// Compact quick-add row. Values MUST be valid EXPERTISE_OPTIONS so they feed the
// same selected-expertise state (and matching) as the searchable selector.
const POPULAR_EXPERTISE = [
  'AI', 'Privacy', 'Cybersecurity', 'Litigation', 'M&A',
  'Finance', 'Healthcare', 'Sales', 'Marketing', 'Operations',
];

const SPECIFIC_HINT_MAX = 200;

export default function HiringForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [title, setTitle] = useState('');
  const [seniority, setSeniority] = useState('');
  const [industry, setIndustry] = useState('');
  const [expertise, setExpertise] = useState<string[]>([]);
  const [roleTypes, setRoleTypes] = useState<string[]>([]);
  const [specificHint, setSpecificHint] = useState('');
  const [description, setDescription] = useState('');
  const [includeRecruiters, setIncludeRecruiters] = useState(false);

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
      if (roleTypes.length < 1) {
        setFieldErrors({ role_types: 'Select at least one role.' });
        setBusy(false);
        return;
      }
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
            specific_hint: specificHint.trim() || undefined,
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

        <Field label="Who are you looking for? *" error={fieldErrors.role_types}>
          <p className="mb-2 text-xs text-slate-500">Search and select one or more roles.</p>
          <RolePicker value={roleTypes} onChange={(next) => { clearError('role_types'); setRoleTypes(next); }} />
        </Field>

        <Field label="Looking for someone specific? (optional)">
          <p className="mb-2 text-xs text-slate-500">Company, organization, person, or short description.</p>
          <input
            type="text"
            value={specificHint}
            onChange={(e) => setSpecificHint(e.target.value)}
            maxLength={SPECIFIC_HINT_MAX}
            placeholder="Someone at OpenAI, a healthcare GC, or a former FTC attorney"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </Field>

        <Field label="Helpful expertise" error={fieldErrors.expertise}>
          <p className="mb-2 text-xs text-slate-500">Search and select at least one area that matches the role.</p>
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

        <Field label="Anything else candidates should know? (optional)" error={fieldErrors.description}>
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

        <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
          <div className="text-sm font-medium text-slate-900">Expand the search</div>
          <label className="mt-3 flex items-start gap-3">
            <input type="checkbox" checked={includeRecruiters} onChange={(e) => setIncludeRecruiters(e.target.checked)} className="mt-0.5" />
            <div>
              <div className="text-sm text-slate-900">Include recruiters in my network</div>
              <p className="mt-0.5 text-xs text-slate-500">Relevant recruiters already connected to you may also be notified.</p>
            </div>
          </label>
        </div>

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
