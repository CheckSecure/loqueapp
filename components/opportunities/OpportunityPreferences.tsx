'use client';

import { useState } from 'react';
import { Lock } from 'lucide-react';
import { Toggle } from '@/components/ui/Toggle';
import { Pill } from '@/components/ui/Pill';

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
    <section className="space-y-5">
      <div className="flex items-start gap-2.5 rounded-xl bg-slate-50 border border-slate-100 px-4 py-3">
        <Lock className="w-4 h-4 text-slate-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-slate-600 leading-relaxed">
          Your preferences are never shown to other members.
        </p>
      </div>

      <div className="space-y-3">
        <PreferenceRow
          label="Open to new roles"
          description="Let hiring managers in your network privately consider you for relevant roles."
          checked={prefs.open_to_roles}
          onToggle={() => toggle('open_to_roles')}
          disabled={saving}
        />
        <PreferenceRow
          label="Open to business opportunities"
          description="Be considered when members need help with work that matches your expertise."
          checked={prefs.open_to_business_solutions}
          onToggle={() => toggle('open_to_business_solutions')}
          disabled={saving}
        />
        <PreferenceRow
          label="I'm a recruiter"
          description="Let members in your network include you when they need recruiting help."
          checked={prefs.recruiter}
          onToggle={() => toggle('recruiter')}
          disabled={saving}
        />
      </div>

      <div className="h-6 flex items-center">
        {saved && <Pill variant="gold" dot>Saved</Pill>}
      </div>
    </section>
  );
}

function PreferenceRow({
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
    <div className="flex items-start justify-between gap-4 rounded-xl border border-slate-100 bg-white px-4 py-4 transition-colors hover:border-slate-200">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-slate-900">{label}</div>
        <p className="mt-1 text-xs text-slate-500 leading-relaxed">{description}</p>
      </div>
      <Toggle
        checked={checked}
        onToggle={onToggle}
        disabled={disabled}
        ariaLabel={label}
      />
    </div>
  );
}
