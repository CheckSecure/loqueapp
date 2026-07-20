/**
 * Pure Meetings-list assembly. Extracted so the enrichment/ordering/state logic
 * is unit-testable without Supabase, and so participant profiles are resolved
 * from a single batched profile map (no per-meeting query — no N+1).
 *
 * Every meeting `status` is passed through verbatim, so all states
 * (draft / proposed / pending / booked / completed / cancelled / requested /
 * reschedule_requested …) are preserved regardless of their exact values.
 */

export type MeetingRow = {
  id: string
  purpose: string | null
  purpose_category: string | null
  format: string | null
  status: string | null
  scheduled_at: string
  duration_minutes: number | null
  location: string | null
  zoom_link: string | null
  notes: string | null
  requester_id: string
  recipient_id: string
  proposed_scheduled_at: string | null
  proposed_duration_minutes: number | null
  proposed_format: string | null
  proposed_location: string | null
  proposed_zoom_link: string | null
  proposed_notes: string | null
  updated_at?: string | null
}

export type EnrichedMeeting = {
  id: string
  title: string | null
  purpose_category: string | null
  scheduled_at: string
  duration_minutes: number | null
  meeting_type: string | null
  status: string | null
  location: string | null
  zoom_link: string | null
  notes: string | null
  proposed_scheduled_at: string | null
  proposed_duration_minutes: number | null
  proposed_format: string | null
  proposed_location: string | null
  proposed_zoom_link: string | null
  proposed_notes: string | null
  other: any | null
  isOrganizer: boolean
  isPast: boolean
  isNew: boolean
}

/** The two participant ids for a meeting (used to batch profile fetching). */
export function meetingParticipantIds(rows: MeetingRow[] | null | undefined, currentUserId: string): string[] {
  const ids = new Set<string>()
  for (const m of rows ?? []) {
    ids.add(m.requester_id === currentUserId ? m.recipient_id : m.requester_id)
  }
  ids.delete('')
  return Array.from(ids)
}

/**
 * Enrich + split meetings, preserving order: input rows are expected ordered by
 * scheduled_at asc; upcoming keeps that (soonest first), past is reversed
 * (most-recent first) — identical to the previous inline behavior.
 */
export function assembleMeetings(
  rows: MeetingRow[] | null | undefined,
  profileById: Map<string, any>,
  currentUserId: string,
  nowMs: number,
): { upcoming: EnrichedMeeting[]; past: EnrichedMeeting[] } {
  const enriched: EnrichedMeeting[] = (rows ?? []).map(m => {
    const isRequester = m.requester_id === currentUserId
    const otherId = isRequester ? m.recipient_id : m.requester_id
    return {
      id: m.id,
      title: m.purpose,
      purpose_category: m.purpose_category ?? null,
      scheduled_at: m.scheduled_at,
      duration_minutes: m.duration_minutes,
      meeting_type: m.format,
      status: m.status,
      location: m.location,
      zoom_link: m.zoom_link ?? null,
      notes: m.notes ?? null,
      proposed_scheduled_at: m.proposed_scheduled_at ?? null,
      proposed_duration_minutes: m.proposed_duration_minutes ?? null,
      proposed_format: m.proposed_format ?? null,
      proposed_location: m.proposed_location ?? null,
      proposed_zoom_link: m.proposed_zoom_link ?? null,
      proposed_notes: m.proposed_notes ?? null,
      other: profileById.get(otherId) ?? null,
      isOrganizer: isRequester,
      isPast: new Date(m.scheduled_at).getTime() < nowMs,
      isNew: (m.status === 'requested' || m.status === 'reschedule_requested') && !isRequester,
    }
  })
  const upcoming = enriched.filter(m => !m.isPast)
  const past = enriched.filter(m => m.isPast).reverse()
  return { upcoming, past }
}
