'use client';

import { useState } from 'react';

type Props = {
  initial: {
    open_to_roles: boolean;
    open_to_business_solutions: boolean;
    recruiter: boolean;
  };
  saveEndpoint?: string;
};

export function OpportunityPreferences({
  initial,
  saveEndpoint = '/api/profile/opportunity-preferences',
}: Props) {
  const [prefs, setPrefs] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function toggle(key: keyof typeof prefs) {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    setSaving(true);
    setSaved(false);
    try {
      await fetch(saveEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: next[key] }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      setPrefs(prefs);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-slate-900">Opportunities</h3>
        <p className="mt-1 text-xs text-slate-500">These preferences are never shown to other members.</p>
      </div>

      <Toggle label="Open to new roles" description="You'll be considered for hiring opportunities that match." checked={prefs.open_to_roles} onToggle={() => toggle('open_to_roles')} disabled={saving} />
      <Toggle label="Open to business opportunities" description="You'll be considered when someone needs a service you provide." checked={prefs.open_to_business_solutions} onToggle={() => toggle('open_to_business_solutions')} disabled={saving} />
      <Toggle label="I'm a recruiter" description="Members in your network can ask you to help when they hire." checked={prefs.recruiter} onToggle={() => toggle('recruiter')} disabled={saving} />

      {saved && <p className="text-xs text-slate-400">Saved.</p>}
    </section>
  );
}

function Toggle({
  label,
  description,
  checked,
  onToggle,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 bg-white p-4 hover:border-slate-300">
      <input type="checkbox" checked={checked} onChange={onToggle} disabled={disabled} className="mt-0.5" />
      <div>
        <div className="text-sm font-medium text-slate-900">{label}</div>
        <p className="mt-0.5 text-xs text-slate-500">{description}</p>
      </div>
    </label>
  );
}
