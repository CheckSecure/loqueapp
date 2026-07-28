import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'

/**
 * Request-deduplicated authenticated user.
 *
 * `supabase.auth.getUser()` makes a NETWORK round-trip to the Supabase Auth server
 * every call (it revalidates the JWT — that's the secure check). The dashboard
 * layout and the page it renders each need the user, and without deduping they
 * each pay that round-trip. React's `cache()` memoizes the result for the duration
 * of a single server render, so layout + page share ONE getUser call instead of
 * two. Security is unchanged: the token is still server-validated once per request.
 *
 * (Middleware runs in a separate request context and cannot share this cache; it
 * keeps its own getUser to refresh the session cookie.)
 */
export const getAuthUser = cache(async () => {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
})
