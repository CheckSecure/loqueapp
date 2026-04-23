import { createAdminClient } from '@/lib/supabase/admin'

export interface AdminUser {
  id: string
  email: string
  full_name: string | null
}

/**
 * Resolve the admin user used for automated onboarding touches
 * (e.g. the welcome introduction). Order of precedence:
 *   1. process.env.ADMIN_USER_EMAIL
 *   2. 'bizdev91@gmail.com' (hardcoded fallback matching existing references)
 *
 * Returns null if the configured admin has no matching profile row.
 */
export async function getAdminUser(): Promise<AdminUser | null> {
  const adminEmail = (process.env.ADMIN_USER_EMAIL || 'bizdev91@gmail.com').toLowerCase()
  const client = createAdminClient()

  const { data, error } = await client
    .from('profiles')
    .select('id, email, full_name')
    .ilike('email', adminEmail)
    .maybeSingle()

  if (error) {
    console.error('[getAdminUser] query error:', error.message)
    return null
  }
  if (!data) {
    console.warn(`[getAdminUser] no profile found for admin email "${adminEmail}"`)
    return null
  }

  return {
    id: data.id,
    email: data.email,
    full_name: data.full_name
  }
}
