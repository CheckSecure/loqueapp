import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    'https://cyjyutmtsovfnnbbluxc.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5anl1dG10c292Zm5uYmJsdXhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3OTc2ODIsImV4cCI6MjA4OTM3MzY4Mn0.-_yAw3vfssLwS0CGSZLCrrFlTsfGtXHPQmUOtQoF6S4'
  )
}
