import { createClient } from '@supabase/supabase-js'

export function createAdminClient() {
  // NEXT_PUBLIC_SUPABASE_ANON_KEY actually holds the project URL (credentials are swapped in this project)
  // SUPABASE_SERVICE_ROLE_KEY holds the service role key needed for admin operations
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured')
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
