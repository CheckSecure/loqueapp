// Shared admin guard. Returns { user, error } where error is a NextResponse to return directly.
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export const ADMIN_EMAIL = process.env.ADMIN_USER_EMAIL || 'bizdev91@gmail.com'

export async function requireAdmin() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { user: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  if (user.email !== ADMIN_EMAIL) {
    return { user, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { user, error: null }
}
