import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import MatchInspectorClient from '@/components/admin/MatchInspectorClient'

export const metadata = { title: 'Match Inspector | Admin | Andrel' }

const ADMIN_EMAIL = process.env.ADMIN_USER_EMAIL || 'bizdev91@gmail.com'

export default async function MatchInspectorPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Match Inspector</h1>
        <p className="text-sm text-slate-500 mt-1">Inspect relationship state, eligibility, and insights between any two users.</p>
      </div>
      <MatchInspectorClient />
    </div>
  )
}
