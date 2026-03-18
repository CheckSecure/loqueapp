import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import MeetingsClient from '@/components/MeetingsClient'
import pool from '@/lib/db'

export const metadata = { title: 'Meetings | Cadre' }

export default async function MeetingsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { rows } = await pool.query(
    `SELECT m.id, m.title, m.scheduled_at, m.duration_minutes, m.meeting_type, m.location,
            m.organizer_id,
            pa.id as att_id, pa.full_name as att_name, pa.avatar_color as att_color,
            po.id as org_id, po.full_name as org_name, po.avatar_color as org_color
     FROM meetings m
     LEFT JOIN profiles pa ON pa.id = m.attendee_id
     LEFT JOIN profiles po ON po.id = m.organizer_id
     WHERE m.organizer_id = $1 OR m.attendee_id = $1
     ORDER BY m.scheduled_at ASC`,
    [user.id]
  )

  const enriched = rows.map((m: any) => {
    const isOrganizer = m.organizer_id === user.id
    const other = isOrganizer
      ? (m.att_id ? { id: m.att_id, full_name: m.att_name, avatar_color: m.att_color } : null)
      : { id: m.org_id, full_name: m.org_name, avatar_color: m.org_color }
    return {
      id: m.id,
      title: m.title,
      scheduled_at: m.scheduled_at,
      duration_minutes: m.duration_minutes,
      meeting_type: m.meeting_type,
      location: m.location,
      other,
      isOrganizer,
      isPast: new Date(m.scheduled_at) < new Date(),
    }
  })

  const upcoming = enriched.filter(m => !m.isPast)
  const past = enriched.filter(m => m.isPast).reverse()

  return <MeetingsClient upcoming={upcoming} past={past} currentUserId={user.id} />
}
