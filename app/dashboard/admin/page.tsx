import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { adminGetPendingRequests } from '@/lib/introRequests'
import AdminIntroRequests from '@/components/AdminIntroRequests'
import { ShieldCheck } from 'lucide-react'

export const metadata = { title: 'Admin | Cadre' }

export default async function AdminPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: pending } = await adminGetPendingRequests()

  return (
    <div className="p-6 md:p-8 pt-20 md:pt-8">
      <div className="max-w-5xl">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-9 h-9 bg-[#FDF3E3] rounded-lg flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-[#C4922A]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Admin</h1>
            <p className="text-slate-500 text-sm mt-0.5">Manage introduction requests</p>
          </div>
        </div>

        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
            Pending intro requests · {pending.length}
          </h2>
        </div>

        <AdminIntroRequests initial={pending} />
      </div>
    </div>
  )
}
