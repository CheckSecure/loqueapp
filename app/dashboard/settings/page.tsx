import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ProfileEditForm from '@/components/ProfileEditForm'
import EmailChangeForm from '@/components/EmailChangeForm'
import PasswordChangeForm from '@/components/PasswordChangeForm'
import AccountDeletion from '@/components/AccountDeletion'
import { OpportunityPreferences } from '@/components/opportunities/OpportunityPreferences'
import { Mail, FileText } from 'lucide-react'

export const metadata = { title: 'Settings | Andrel' }

export default async function SettingsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (!profile) redirect('/login')

  return (
    <div className="max-w-2xl mx-auto px-6 py-10 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="text-slate-500 text-sm mt-1">Manage your account and preferences.</p>
      </div>

      <ProfileEditForm initialData={profile} />
      <EmailChangeForm />
      <PasswordChangeForm />

      {/* Opportunities */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-900">Opportunities</h2>
        </div>
        <div className="px-6 py-5">
          <OpportunityPreferences
            initial={{
              open_to_roles: profile.open_to_roles ?? false,
              open_to_business_solutions: profile.open_to_business_solutions ?? false,
              recruiter: profile.recruiter ?? false,
            }}
          />
        </div>
      </div>

      {/* Help & Support */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-[#1B2850]" />
            <h2 className="text-sm font-semibold text-slate-900">Help & Support</h2>
          </div>
        </div>
        <div className="px-6 py-5 space-y-4">
          <a href="mailto:support@andrel.app" className="flex items-center gap-4 p-4 rounded-xl border border-slate-100 hover:border-[#1B2850]/20 hover:bg-slate-50 transition-colors group">
            <div className="w-9 h-9 rounded-lg bg-[#F5F6FB] flex items-center justify-center flex-shrink-0">
              <Mail className="w-4 h-4 text-[#1B2850]" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900">Email Support</p>
              <p className="text-xs text-slate-500 mt-0.5">support@andrel.app — we respond within 24 hours</p>
            </div>
          </a>
          <a href="/faq" target="_blank" rel="noopener noreferrer" className="flex items-center gap-4 p-4 rounded-xl border border-slate-100 hover:border-[#1B2850]/20 hover:bg-slate-50 transition-colors group">
            <div className="w-9 h-9 rounded-lg bg-[#F5F6FB] flex items-center justify-center flex-shrink-0">
              <FileText className="w-4 h-4 text-[#1B2850]" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900">FAQ</p>
              <p className="text-xs text-slate-500 mt-0.5">Answers to common questions about Andrel</p>
            </div>
          </a>
        </div>
      </div>

      {/* Legal */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-900">Legal</h2>
        </div>
        <div className="px-6 py-5 flex gap-6">
          <a href="/privacy" target="_blank" className="text-sm text-slate-500 hover:text-[#1B2850] transition-colors">Privacy Policy</a>
          <a href="/terms" target="_blank" className="text-sm text-slate-500 hover:text-[#1B2850] transition-colors">Terms of Service</a>
        </div>
      </div>

      <AccountDeletion />
    </div>
  )
}
