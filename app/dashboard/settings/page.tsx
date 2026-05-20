import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ProfileEditForm from '@/components/ProfileEditForm'
import EmailChangeForm from '@/components/EmailChangeForm'
import PasswordChangeForm from '@/components/PasswordChangeForm'
import AccountDeletion from '@/components/AccountDeletion'
import { OpportunityPreferences } from '@/components/opportunities/OpportunityPreferences'
import ReportIssueButton from '@/components/ReportIssueButton'
import EmailPreferencesForm from '@/components/EmailPreferencesForm'
import { ChevronDown, BookOpen, UserPlus, ChevronRight } from 'lucide-react'

export const metadata = { title: 'Settings | Andrel' }

const sectionCard = 'group bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden'
const sectionSummary = 'px-6 py-4 cursor-pointer flex items-center justify-between list-none [&::-webkit-details-marker]:hidden hover:bg-slate-50 transition-colors group-open:border-b group-open:border-slate-100'
const sectionTitle = 'text-sm font-semibold text-slate-900'
const sectionChevron = 'w-4 h-4 text-slate-400 transition-transform group-open:rotate-180'

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

  const { data: notifPrefs } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle()

  const initialNotifPrefs = {
    email_new_introductions: notifPrefs?.email_new_introductions ?? true,
    email_messages: notifPrefs?.email_messages ?? true,
    email_meeting_updates: notifPrefs?.email_meeting_updates ?? true,
    email_opportunities: notifPrefs?.email_opportunities ?? true,
    email_product_updates: notifPrefs?.email_product_updates ?? true,
    email_daily_digest: notifPrefs?.email_daily_digest ?? true,
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 sm:py-12 space-y-6 sm:space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Settings</h1>
        <p className="text-slate-500 text-sm mt-2">Manage your account and preferences.</p>
      </div>

      {/* Account */}
      <details className={sectionCard}>
        <summary className={sectionSummary}>
          <h2 className={sectionTitle}>Account</h2>
          <ChevronDown className={sectionChevron} />
        </summary>
        <div className="px-6 py-5 space-y-4">
          <ProfileEditForm initialData={profile} />
          <EmailChangeForm />
          <PasswordChangeForm />
        </div>
      </details>

      {/* Preferences */}
      <details className={sectionCard} open>
        <summary className={sectionSummary}>
          <h2 className={sectionTitle}>Preferences</h2>
          <ChevronDown className={sectionChevron} />
        </summary>
        <div>
          <section className="px-6 py-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-4">Opportunities</h3>
            <OpportunityPreferences
              initial={{
                open_to_roles: profile.open_to_roles ?? false,
                open_to_business_solutions: profile.open_to_business_solutions ?? false,
                recruiter: profile.recruiter ?? false,
              }}
            />
          </section>
          <section className="border-t border-slate-100 px-6 py-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">Email notifications</h3>
            <p className="text-xs text-slate-500 mb-4">
              Choose which updates you&apos;d like to receive. Important account, security, and billing emails will always be sent.
            </p>
            <EmailPreferencesForm initial={initialNotifPrefs} />
          </section>
        </div>
      </details>

      {/* Community */}
      <details className={sectionCard}>
        <summary className={sectionSummary}>
          <h2 className={sectionTitle}>Community</h2>
          <ChevronDown className={sectionChevron} />
        </summary>
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
              <p className="text-xs text-slate-500 mt-0.5">Andrel grows through trusted referrals. Invite someone you&apos;d genuinely want to meet — you&apos;ll earn 1 credit if they join.</p>
            </div>
            <span className="text-slate-400 text-sm">Manage referrals →</span>
          </Link>
        </div>
      </details>

      {/* Support */}
      <details className={sectionCard}>
        <summary className={sectionSummary}>
          <h2 className={sectionTitle}>Support</h2>
          <ChevronDown className={sectionChevron} />
        </summary>
        <div className="px-6 py-3">
          <ReportIssueButton
            variant="support"
            triggerVariant="row"
            description="Questions or need help? We'll respond within 24 hours."
          />
          <a
            href="/faq"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full flex items-center gap-4 px-2 py-3 -mx-2 rounded-lg hover:bg-slate-50 transition-colors"
          >
            <BookOpen className="w-4 h-4 text-slate-600 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-900">FAQ</p>
              <p className="text-xs text-slate-500 mt-0.5">Answers to common questions about Andrel.</p>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
          </a>
          <ReportIssueButton
            triggerVariant="row"
            description="Found a bug or have feedback? Let us know."
          />
        </div>
      </details>

      {/* Legal */}
      <details className={sectionCard}>
        <summary className={sectionSummary}>
          <h2 className={sectionTitle}>Legal</h2>
          <ChevronDown className={sectionChevron} />
        </summary>
        <div className="px-6 py-5 flex gap-6">
          <a href="/privacy" target="_blank" className="text-sm text-slate-500 hover:text-brand-navy transition-colors">Privacy Policy</a>
          <a href="/terms" target="_blank" className="text-sm text-slate-500 hover:text-brand-navy transition-colors">Terms of Service</a>
        </div>
      </details>

      {/* Danger Zone (always visible) */}
      <AccountDeletion />
    </div>
  )
}
