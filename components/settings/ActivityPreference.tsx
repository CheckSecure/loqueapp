'use client'

import { useState } from 'react'
import { Toggle } from '@/components/ui/Toggle'

/**
 * "Show when I'm active" opt-out. Optimistic toggle → POST /api/profile/activity-preference
 * (server-scoped to the caller's own row). When off, other members see no presence status.
 */
export default function ActivityPreference({ initial }: { initial: { show_activity_status: boolean } }) {
  const [on, setOn] = useState(initial.show_activity_status)
  const [saving, setSaving] = useState(false)

  async function toggle() {
    const next = !on
    setOn(next)
    setSaving(true)
    try {
      const res = await fetch('/api/profile/activity-preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show_activity_status: next }),
      })
      if (!res.ok) setOn(!next) // revert on failure
    } catch {
      setOn(!next)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center justify-between py-3">
      <div className="pr-4">
        <p className="text-sm font-medium text-slate-900">Show when I&apos;m active</p>
        <p className="text-xs text-slate-500 mt-0.5">
          Let members you&apos;re connected with see your &ldquo;online now&rdquo; / last-active status. Your exact time is never shown.
        </p>
      </div>
      <Toggle checked={on} onToggle={toggle} disabled={saving} ariaLabel="Show when I'm active" />
    </div>
  )
}
