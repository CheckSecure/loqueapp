import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ProfileEditForm from '@/components/ProfileEditForm'
import EmailChangeForm from '@/components/EmailChangeForm'
import PasswordChangeForm from '@/components/PasswordChangeForm'
import AccountDeletion from '@/components/AccountDeletion'
import { OpportunityPreferences } from '@/components/opportunities/OpportunityPreferences'
import ReportIssueButton from '@/components/ReportIssueButton'
import { Mail, FileText, AlertCircle, UserPlus } from 'lucide-react'

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
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 sm:py-12 space-y-6 sm:space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Settings</h1>
        <p className="text-slate-500 text-sm mt-2">Manage your account and preferences.</p>
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

      {/* Referrals */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-900">Referrals</h2>
        </div>
        <div className="px-6 py-5">
          <Link
            href="/dashboard/referrals"
            className="flex items-center gap-4 p-4 rounded-xl border border-slate-100 hover:border-brand-navy/20 hover:bg-slate-50 transition-colors group"
          >
            <div className="w-9 h-9 rounded-lg bg-brand-cream flex items-center justify-center flex-shrink-0">
              <UserPlus className="w-4 h-4 text-brand-navy" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-slate-900">Invite someone valuable</p>
              <p className="text-xs text-slate-500 mt-0.5">Andrel grows through trusted referrals. Invite someone you'd genuinely want to meet or introduce to others.</p>
            </div>
            <span className="text-slate-400 text-sm">Manage referrals →</span>
          </Link>
        </div>
      </div>

      {/* Help & Support */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-brand-navy" />
            <h2 className="text-sm font-semibold text-slate-900">Help & Support</h2>
          </div>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-slate-100">
            <div className="flex items-center gap-4">
              <div className="w-9 h-9 rounded-lg bg-brand-cream flex items-center justify-center flex-shrink-0">
                <Mail className="w-4 h-4 text-brand-navy" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">Message support</p>
                <p className="text-xs text-slate-500 mt-0.5">Questions or need help? We'll respond within 24 hours.</p>
              </div>
            </div>
            <ReportIssueButton variant="support" />
          </div>
          <a href="/faq" target="_blank" rel="noopener noreferrer" className="flex items-center gap-4 p-4 rounded-xl border border-slate-100 hover:border-brand-navy/20 hover:bg-slate-50 transition-colors group">
            <div className="w-9 h-9 rounded-lg bg-brand-cream flex items-center justify-center flex-shrink-0">
              <FileText className="w-4 h-4 text-brand-navy" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900">FAQ</p>
              <p className="text-xs text-slate-500 mt-0.5">Answers to common questions about Andrel</p>
            </div>
          </a>
          <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-slate-100">
            <div className="flex items-center gap-4">
              <div className="w-9 h-9 rounded-lg bg-brand-cream flex items-center justify-center flex-shrink-0">
                <AlertCircle className="w-4 h-4 text-brand-navy" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">Report an issue</p>
                <p className="text-xs text-slate-500 mt-0.5">Found a bug or have feedback? Let us know.</p>
              </div>
            </div>
            <ReportIssueButton />
          </div>
        </div>
      </div>

      {/* Legal */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-900">Legal</h2>
        </div>
        <div className="px-6 py-5 flex gap-6">
          <a href="/privacy" target="_blank" className="text-sm text-slate-500 hover:text-brand-navy transition-colors">Privacy Policy</a>
          <a href="/terms" target="_blank" className="text-sm text-slate-500 hover:text-brand-navy transition-colors">Terms of Service</a>
        </div>
      </div>

      <AccountDeletion />
    </div>
  )
}
