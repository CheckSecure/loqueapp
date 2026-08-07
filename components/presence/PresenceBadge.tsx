'use client'

import { formatLastActive } from '@/lib/presence/lastActive'

/**
 * Presence indicator. Two mutually-exclusive inputs, both already gated server-side:
 *   • `label` — a coarse, preformatted label from the member_presence_labels() RPC (the
 *     ONLY way another member's presence reaches the client; the raw timestamp never does).
 *   • `lastActiveAt` — a raw timestamp formatted client-side, used ONLY for a member's own
 *     presence (never another member's).
 * A small green dot shows only for "Online now"; historical activity is neutral. Renders
 * nothing when presence is unknown or older than 7 days.
 */
export default function PresenceBadge({
  label,
  lastActiveAt,
  className = '',
}: {
  label?: string | null
  lastActiveAt?: string | null
  className?: string
}) {
  const presence = label != null
    ? { label, isOnline: label === 'Online now' }
    : formatLastActive(lastActiveAt)
  if (!presence || !presence.label) return null
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${presence.isOnline ? 'text-green-600' : 'text-slate-400'} ${className}`}
      title={presence.label}
    >
      {presence.isOnline && <span className="w-2 h-2 rounded-full bg-green-500" aria-hidden="true" />}
      {presence.label}
    </span>
  )
}
