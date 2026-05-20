'use client'

import { useState } from 'react'

type Prefs = {
  email_new_introductions: boolean
  email_messages: boolean
  email_meeting_updates: boolean
  email_opportunities: boolean
  email_product_updates: boolean
  email_daily_digest: boolean
}

const ROWS: { key: keyof Prefs; label: string; description: string }[] = [
  {
    key: 'email_new_introductions',
    label: 'New introductions',
    description: 'Get notified when new curated introductions become available.',
  },
  {
    key: 'email_messages',
    label: 'Messages',
    description: 'Get notified when someone sends you a new message.',
  },
  {
    key: 'email_meeting_updates',
    label: 'Meeting updates',
    description: 'Meeting requests, accepted meetings, reschedules, reminders, and calendar updates.',
  },
  {
    key: 'email_opportunities',
    label: 'Opportunities',
    description: 'Get notified about relevant opportunities and matches.',
  },
  {
    key: 'email_product_updates',
    label: 'Product updates',
    description: 'Founding member updates, new features, and important platform announcements.',
  },
  {
    key: 'email_daily_digest',
    label: 'Daily digest',
    description: "Receive a summary of unread activity if you haven't visited recently.",
  },
]

export default function EmailPreferencesForm({ initial }: { initial: Prefs }) {
  const [prefs, setPrefs] = useState<Prefs>(initial)
  const [saving, setSaving] = useState<keyof Prefs | null>(null)

  async function toggle(key: keyof Prefs) {
    const next = !prefs[key]
    setPrefs(prev => ({ ...prev, [key]: next }))
    setSaving(key)
    try {
      await fetch('/api/profile/notification-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: next }),
      })
    } catch {
      setPrefs(prev => ({ ...prev, [key]: !next }))
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="space-y-6">
      {ROWS.map(({ key, label, description }) => (
        <div key={key} className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-slate-900">{label}</p>
            <p className="text-xs text-slate-500 mt-0.5">{description}</p>
          </div>
          <button
            onClick={() => toggle(key)}
            disabled={saving === key}
            aria-pressed={prefs[key]}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-50 ${prefs[key] ? 'bg-[#1B2850]' : 'bg-slate-200'}`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${prefs[key] ? 'translate-x-5' : 'translate-x-0'}`}
            />
          </button>
        </div>
      ))}
    </div>
  )
}
