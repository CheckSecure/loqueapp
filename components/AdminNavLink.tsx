import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ShieldCheck } from 'lucide-react'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/**
 * Server component — runs its own auth check independently.
 * Returns null (no HTML at all) for any user who is not the admin.
 * The parent Sidebar applies active styling via usePathname().
 */
export default async function AdminNavLink() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user || user.email !== ADMIN_EMAIL) return null

  return (
    <Link
      href="/dashboard/admin"
      className="flex items-center gap-3 w-full text-inherit"
    >
      <ShieldCheck className="w-4 h-4 flex-shrink-0" />
      Admin
    </Link>
  )
}
