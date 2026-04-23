import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Inbox, Wrench } from 'lucide-react'

export const metadata = { title: 'Operations | Admin | Andrel' }

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export default async function OperationsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="mb-6 flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-[#F5F6FB] flex items-center justify-center">
          <Wrench className="w-5 h-5 text-[#1B2850]" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Operations</h1>
          <p className="text-sm text-slate-500 mt-1">Advanced tools for support, debugging, and manual intervention.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

        {/* Intro Requests */}
        <Link
          href="/dashboard/admin/intros"
          className="bg-white rounded-xl border border-slate-200 p-6 hover:border-[#1B2850]/30 hover:shadow-md transition-all group"
        >
          <div className="flex items-start justify-between mb-4">
            <div className="w-12 h-12 rounded-lg bg-[#F5F6FB] flex items-center justify-center group-hover:bg-[#1B2850] transition-colors">
              <Inbox className="w-6 h-6 text-[#1B2850] group-hover:text-white transition-colors" />
            </div>
          </div>
          <h3 className="text-lg font-bold text-slate-900 mb-2">Intro Requests</h3>
          <p className="text-sm text-slate-500 mb-4">
            View and manage introduction requests and edge cases.
          </p>
          <div className="flex items-center gap-4 text-xs text-slate-600">
            <span>Support &amp; observability</span>
          </div>
        </Link>

      </div>
    </div>
  )
}
