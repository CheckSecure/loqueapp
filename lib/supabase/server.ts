import { createServerClient } from '@supabase/ssr'
import type { CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'

export function createClient() {
  const cookieStore = cookies()

  return createServerClient(
    'https://cyjyutmtsovfnnbbluxc.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5anl1dG10c292Zm5uYmJsdXhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3OTc2ODIsImV4cCI6MjA4OTM3MzY4Mn0.-_yAw3vfssLwS0CGSZLCrrFlTsfGtXHPQmUOtQoF6S4',
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Component read-only cookie store — ignored
          }
        },
      },
    }
  )
}

export function createAdminClient() {
  const cookieStore = cookies()

  return createServerClient(
    'https://cyjyutmtsovfnnbbluxc.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5anl1dG10c292Zm5uYmJsdXhjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mzc5NzY4MiwiZXhwIjoyMDg5MzczNjgyfQ.rMqt9DQeKZCWw0fSmx2J1FvjtbZJucht0veWBZw77fY',
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Component read-only cookie store — ignored
          }
        },
      },
    }
  )
}
