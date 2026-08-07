/**
 * Shared presence formatter — the SINGLE source of truth for how a member's
 * last-active time is rendered, so wording is consistent everywhere.
 *
 * Display rules (privacy-conscious — never exposes an exact timestamp):
 *   • active within 5 min      → "Online now"   (green dot)
 *   • under 60 minutes         → "Active Xm ago"
 *   • under 24 hours           → "Active Xh ago"
 *   • the previous calendar day → "Active yesterday"
 *   • under 7 days             → "Active Xd ago"
 *   • older than 7 days / unknown → null (show NO status)
 *
 * Calendar-day comparisons use UTC so the label is deterministic and testable.
 */

export const PRESENCE_ONLINE_MS = 5 * 60 * 1000 // "Online now" window

export interface PresenceLabel {
  label: string
  /** true only within the 5-minute online window (drives the green dot). */
  isOnline: boolean
}

function utcMidnight(ts: number): number {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

export function formatLastActive(
  lastActiveAt: string | null | undefined,
  now: number = Date.now(),
): PresenceLabel | null {
  if (!lastActiveAt) return null
  const t = new Date(lastActiveAt).getTime()
  if (Number.isNaN(t)) return null

  const diff = now - t
  // Clock skew (future timestamp) is treated as currently online, never negative.
  if (diff < PRESENCE_ONLINE_MS) return { label: 'Online now', isOnline: true }

  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return { label: `Active ${minutes}m ago`, isOnline: false }

  const hours = Math.floor(diff / 3_600_000)
  if (hours < 24) return { label: `Active ${hours}h ago`, isOnline: false }

  const dayDiff = Math.round((utcMidnight(now) - utcMidnight(t)) / 86_400_000)
  if (dayDiff <= 1) return { label: 'Active yesterday', isOnline: false }
  if (dayDiff < 7) return { label: `Active ${dayDiff}d ago`, isOnline: false }
  return null // older than 7 days → no status
}

/**
 * Server-side visibility gate for presence. `lastActiveAt` should already have passed
 * the SURFACE's relationship/discoverability check (RLS or canViewerDiscoverMember) —
 * this applies the member's OWN "Show when I'm active" preference on top:
 *   • the member always sees their own status;
 *   • other members see it only when show_activity_status is not explicitly false.
 * Returns the timestamp to render, or null to hide entirely.
 */
export function presenceForViewer(opts: {
  lastActiveAt: string | null | undefined
  showActivityStatus: boolean | null | undefined
  viewerIsSelf?: boolean
}): string | null {
  const { lastActiveAt, showActivityStatus, viewerIsSelf } = opts
  if (viewerIsSelf) return lastActiveAt ?? null
  if (showActivityStatus === false) return null
  return lastActiveAt ?? null
}
