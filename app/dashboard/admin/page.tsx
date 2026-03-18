import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { adminGetPendingRequests } from '@/lib/introRequests'
import AdminIntroRequests from '@/components/AdminIntroRequests'
import AdminWaitlist from '@/components/AdminWaitlist'
import { ShieldCheck, Users } from 'lucide-react'

export const metadata = { title: 'Admin | Loque' }

export default async function AdminPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (user.email !== 'bizdev91@gmail.com') redirect('/dashboard/introductions')

  const { data: pending } = await adminGetPendingRequests()

  const { data: waitlistEntries } = await supabase
    .from('waitlist')
    .select('id, full_name, email, company, role_type, referral_source, status, created_at')
    .order('created_at', { ascending: false })

  return (
    <div className="p-6 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <div className="max-w-5xl">
        <div className="flex items-center gap-3 mb-10">
          <div className="w-9 h-9 bg-[#FDF3E3] rounded-lg flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-[#C4922A]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Admin</h1>
            <p className="text-slate-500 text-sm mt-0.5">Manage waitlist applications and intro requests</p>
          </div>
        </div>

        {/* Waitlist section */}
        <section className="mb-12">
          <div className="flex items-center gap-2 mb-4">
            <Users className="w-4 h-4 text-[#C4922A]" />
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Waitlist · {waitlistEntries?.length ?? 0} total
            </h2>
          </div>
          <AdminWaitlist initial={waitlistEntries ?? []} />
        </section>

        {/* Intro requests section */}
        <section>
          <div className="mb-4">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Pending intro requests · {pending.length}
            </h2>
          </div>
          <AdminIntroRequests initial={pending} />
        </section>
      </div>
    </div>
  )
}
