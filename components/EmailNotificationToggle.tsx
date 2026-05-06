'use client'

import { useState } from 'react'

export default function EmailNotificationToggle({ enabled }: { enabled: boolean }) {
  const [on, setOn] = useState(enabled)
  const [saving, setSaving] = useState(false)

  async function toggle() {
    const next = !on
    setOn(next)
    setSaving(true)
    try {
      await fetch('/api/profile/email-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email_notifications_enabled: next }),
      })
    } catch {
      setOn(!next)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-semibold text-slate-900">Email notifications</p>
        <p className="text-xs text-slate-500 mt-0.5">
          Daily digest of unread messages and meeting requests when you haven&apos;t visited in 24 hours.
        </p>
      </div>
      <button
        onClick={toggle}
        disabled={saving}
        aria-pressed={on}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-50 ${on ? 'bg-[#1B2850]' : 'bg-slate-200'}`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${on ? 'translate-x-5' : 'translate-x-0'}`}
        />
      </button>
    </div>
  )
}
