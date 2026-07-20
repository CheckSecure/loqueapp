import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { MapPin, Globe, Building2 } from 'lucide-react'
import CompanyLogo from '@/components/CompanyLogo'
import { companySlug, isLinkableCompany, titleCaseSlug } from '@/lib/company/slug'
import { professionalIdentity, professionalIdentityLine } from '@/lib/professionalIdentity'

export const metadata = { title: 'Company | Andrel' }

function toHref(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`
}

export default async function CompanyPage({ params }: { params: { slug: string } }) {
  const slug = (params.slug || '').toLowerCase()
  if (!slug) notFound()

  // Auth via the user client; data via admin client with strict in-code
  // visibility (this page must NEVER become a directory).
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const admin = createAdminClient()

  // Metadata (deploy-safe: if the companies table isn't applied yet, this
  // resolves to null and the page still renders name + members), plus the
  // viewer's matches and blocks — all in parallel.
  const [companyRes, matchRes, blockRes] = await Promise.all([
    admin.from('companies')
      .select('slug, name, industry, headquarters, website, size, description, logo_url')
      .eq('slug', slug).maybeSingle(),
    admin.from('matches')
      .select('user_a_id, user_b_id, status')
      .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`),
    admin.from('blocked_users')
      .select('user_id, blocked_user_id')
      .or(`user_id.eq.${user.id},blocked_user_id.eq.${user.id}`),
  ])
  const company = companyRes.data ?? null

  // Visible people = the current user + their non-blocked connections. This set
  // is already fully visible on the Network page, so filtering it by company
  // exposes nobody new.
  const blocked = new Set<string>()
  for (const b of blockRes.data || []) {
    blocked.add(b.user_id === user.id ? b.blocked_user_id : b.user_id)
  }
  const connectionIds = (matchRes.data || [])
    .filter((m: any) => m.status !== 'removed')
    .map((m: any) => (m.user_a_id === user.id ? m.user_b_id : m.user_a_id))
    .filter((id: string) => id && !blocked.has(id))
  const visibleIds = Array.from(new Set<string>([user.id, ...connectionIds]))

  const { data: visibleProfiles } = await admin
    .from('profiles')
    .select('id, full_name, company, title, exact_job_title, role_type, avatar_url, location, account_status')
    .in('id', visibleIds)

  // Members at THIS company = visible profiles whose normalized company matches
  // the slug (placeholders excluded). Self sorted first, then alphabetical.
  const members = (visibleProfiles || [])
    .filter((p: any) => isLinkableCompany(p.company) && companySlug(p.company) === slug)
    .sort((a: any, b: any) => {
      if (a.id === user.id) return -1
      if (b.id === user.id) return 1
      return (a.full_name || '').localeCompare(b.full_name || '')
    })

  // Display name: curated row → a real member's raw company string → titled slug.
  const displayName =
    company?.name ||
    members.map((m: any) => (m.company || '').trim()).find(Boolean) ||
    titleCaseSlug(slug)

  const metaBits = [company?.industry, company?.headquarters, company?.size].filter(Boolean) as string[]

  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <div className="max-w-2xl mx-auto">
        <Link href="/dashboard/network" className="text-xs text-slate-400 hover:text-brand-navy transition-colors">&larr; Back</Link>

        {/* Header — context, not a hero */}
        <div className="mt-4 flex items-start gap-4">
          <CompanyLogo url={company?.logo_url} name={displayName} size={56} />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-brand-navy tracking-tight truncate">{displayName}</h1>
            {metaBits.length > 0 && (
              <p className="text-sm text-slate-500 mt-1">{metaBits.join(' · ')}</p>
            )}
            {company?.website && (
              <a
                href={toHref(company.website)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-brand-navy hover:text-brand-gold transition-colors"
              >
                <Globe className="w-3.5 h-3.5" />
                {company.website.replace(/^https?:\/\//i, '')}
              </a>
            )}
          </div>
        </div>

        {/* About — only if a curated description exists */}
        {company?.description && (
          <section className="mt-8">
            <h2 className="text-[11px] uppercase tracking-[0.15em] text-brand-gold font-semibold mb-2">About</h2>
            <p className="text-sm text-slate-600 leading-relaxed">{company.description}</p>
          </section>
        )}

        {/* Members at this company — ONLY the viewer's visible connections + self */}
        <section className="mt-8">
          <h2 className="text-[11px] uppercase tracking-[0.15em] text-brand-gold font-semibold mb-3">
            In your network here{members.length > 0 && <span className="ml-1.5 font-medium text-slate-400 tabular-nums">({members.length})</span>}
          </h2>

          {members.length === 0 ? (
            <div className="rounded-2xl border border-slate-200/70 bg-white p-6">
              <div className="flex items-start gap-3">
                <Building2 className="w-4 h-4 text-slate-300 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-slate-500 leading-relaxed">
                  No one in your Andrel network is at {displayName} yet.
                </p>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-200/70 bg-white divide-y divide-slate-100">
              {members.map((m: any) => {
                const isSelf = m.id === user.id
                const line = professionalIdentityLine({ role_type: m.role_type, company: m.company }) || professionalIdentity(m).primary
                const initials = (m.full_name || '?').trim().split(/\s+/).slice(0, 2).map((w: string) => w[0]?.toUpperCase() || '').join('') || '?'
                return (
                  <Link
                    key={m.id}
                    href={isSelf ? '/dashboard/profile' : `/dashboard/profile/${m.id}`}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors first:rounded-t-2xl last:rounded-b-2xl"
                  >
                    {m.avatar_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.avatar_url} alt={m.full_name || ''} className="w-9 h-9 rounded-full object-cover ring-1 ring-slate-200 flex-shrink-0" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-brand-navy/[0.06] ring-1 ring-brand-navy/10 flex items-center justify-center text-brand-navy text-xs font-semibold flex-shrink-0">{initials}</div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-brand-navy truncate">
                        {m.full_name || 'Member'}{isSelf && <span className="ml-1.5 text-xs font-normal text-slate-400">You</span>}
                      </p>
                      {line && <p className="text-xs text-slate-500 truncate">{line}</p>}
                    </div>
                    {m.location && (
                      <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-slate-400 flex-shrink-0">
                        <MapPin className="w-3 h-3" /> {m.location}
                      </span>
                    )}
                  </Link>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
