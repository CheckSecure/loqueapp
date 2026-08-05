import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, MapPin, Globe, Building2, Users } from 'lucide-react'
import CompanyLogo from '@/components/CompanyLogo'
import { companySlug, isLinkableCompany, titleCaseSlug, resolveLegacySlug } from '@/lib/company/slug'
import { professionalIdentityLine, professionalIdentity } from '@/lib/professionalIdentity'
import { discoverableMemberIds } from '@/lib/privacy/canViewerDiscoverMember'

export const metadata = { title: 'Company | Andrel' }

function toHref(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`
}

export default async function CompanyPage({ params }: { params: { slug: string } }) {
  const slug = (params.slug || '').toLowerCase()
  if (!slug) notFound()

  // Backwards-compat: bookmarked/cached old slugs (e.g. /company/bd,
  // /company/dentsu-merkle, /company/baker-botts-l-l-p) redirect to the canonical
  // page rather than 404ing. Registry-derived; extends automatically.
  const legacyTarget = resolveLegacySlug(slug)
  if (legacyTarget && legacyTarget !== slug) redirect(`/company/${legacyTarget}`)

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const admin = createAdminClient()

  // Company metadata (deploy-safe: null if the companies table/row isn't present).
  const { data: companyRow } = await admin.from('companies')
    .select('id, slug, name, industry, headquarters, website, company_size, description, logo_url, admin_edited, enrichment_status')
    .eq('slug', slug).maybeSingle()
  const company: any = companyRow ?? null

  // Backwards-compat: if this row's stored name canonicalizes to a different slug,
  // redirect to the canonical page.
  if (company?.name) {
    const canonicalSlug = companySlug(company.name)
    if (canonicalSlug && canonicalSlug !== slug) redirect(`/company/${canonicalSlug}`)
  }

  // Member visibility (server-side, curated-network rule):
  //   • NAMED members = self + members the viewer may discover (canViewerDiscoverMember).
  //   • Every OTHER active, non-test member at the company is counted only, as an
  //     aggregate — no id/name/title/photo/URL is sent to the client for them.
  const SAFE = 'id, full_name, company, company_id, title, exact_job_title, role_type, avatar_url, location, account_status, is_test_account'
  const sortSelfFirst = (a: any, b: any) => {
    if (a.id === user.id) return -1
    if (b.id === user.id) return 1
    return (a.full_name || '').localeCompare(b.full_name || '')
  }
  // Determine this company's full membership, then split into discoverable NAMED
  // members vs a hidden aggregate count. Membership is matched by BOTH the canonical
  // company_id AND the free-text company slug (company_id backfill is incomplete),
  // and excludes placeholder/non-company identities (isLinkableCompany). At the
  // current member scale a single active-members scan is cheap; hidden members never
  // leave the server (only the integer count is rendered).
  const { data: allActive } = await admin.from('profiles').select(SAFE).eq('account_status', 'active')
  const candidates = (allActive || []).filter((p: any) => {
    if (p.is_test_account) return false
    const byId = Boolean(company?.id) && p.company_id === company.id
    const byText = isLinkableCompany(p.company) && companySlug(p.company) === slug
    return byId || byText
  })
  const memberName = candidates.map((p: any) => (p.company || '').trim()).find(Boolean) || ''
  const otherIds = candidates.filter((p: any) => p.id !== user.id).map((p: any) => p.id)
  const discoverable = await discoverableMemberIds(admin, user.id, otherIds)
  const members = candidates.filter((p: any) => p.id === user.id || discoverable.has(p.id)).sort(sortSelfFirst)
  const hiddenCount = candidates.filter((p: any) => p.id !== user.id && !discoverable.has(p.id)).length

  // Display only. This page never initiates enrichment — records are created and
  // enriched in the background the moment a company first enters the network (a
  // member saves their profile; see scheduleEnrichment in app/actions.ts), with
  // the weekly cron as backfill. The page simply renders whatever data exists.
  const displayName = company?.name || memberName || titleCaseSlug(slug)

  // Header metadata rows — only present fields render (never "Unknown"/"None").
  const rows: { icon: any; value: string }[] = []
  if (company?.industry) rows.push({ icon: Building2, value: company.industry })
  if (company?.headquarters) rows.push({ icon: MapPin, value: company.headquarters })
  if (company?.company_size) rows.push({ icon: Users, value: `${company.company_size} employees` })

  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <div className="max-w-2xl mx-auto">
        <Link href="/dashboard/network" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-brand-navy transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </Link>

        {/* Identity header */}
        <div className="mt-5 flex items-start gap-4">
          <CompanyLogo url={company?.logo_url} name={displayName} size={64} />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-brand-navy tracking-tight break-words">{displayName}</h1>
            {(rows.length > 0 || company?.website) && (
              <div className="mt-2 space-y-1">
                {rows.map((r, i) => (
                  <p key={i} className="flex items-center gap-1.5 text-sm text-slate-600">
                    <r.icon className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                    {r.value}
                  </p>
                ))}
                {company?.website && (
                  <a
                    href={toHref(company.website)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-navy hover:text-brand-gold hover:underline underline-offset-2 transition-colors"
                  >
                    <Globe className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                    {company.website.replace(/^https?:\/\//i, '').replace(/\/$/, '')}
                  </a>
                )}
              </div>
            )}
          </div>
        </div>

        {/* About — only if a real, curated description exists (never fabricated) */}
        {company?.description && (
          <section className="mt-8">
            <h2 className="text-[11px] uppercase tracking-[0.15em] text-brand-gold font-semibold mb-2">About</h2>
            <p className="text-sm text-slate-600 leading-relaxed">{company.description}</p>
          </section>
        )}

        {/* People you know through Andrel — named members are self + those the
            viewer may discover; everyone else at the company is an aggregate count
            only (no id/name/title/photo/URL is sent to the client for them). The
            section is omitted entirely when there is nothing to show. */}
        {(members.length > 0 || hiddenCount > 0) && (
        <section className="mt-8">
          <h2 className="text-[11px] uppercase tracking-[0.15em] text-brand-gold font-semibold mb-3">
            People you know through Andrel
            {members.length > 0 && <span className="ml-1.5 font-medium text-slate-400 tabular-nums">({members.length})</span>}
          </h2>

          {members.length > 0 && (
            <div className="rounded-2xl border border-slate-200/70 bg-white divide-y divide-slate-100 overflow-hidden">
              {members.map((m: any) => {
                const isSelf = m.id === user.id
                const line = professionalIdentityLine({ role_type: m.role_type, company: m.company }) || professionalIdentity(m).primary
                const initials = (m.full_name || '?').trim().split(/\s+/).slice(0, 2).map((w: string) => w[0]?.toUpperCase() || '').join('') || '?'
                return (
                  <Link
                    key={m.id}
                    href={isSelf ? '/dashboard/profile' : `/dashboard/profile/${m.id}`}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors"
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

          {hiddenCount > 0 && (
            <p className={`text-sm text-slate-500 leading-relaxed ${members.length > 0 ? 'mt-3' : ''}`}>
              {hiddenCount} other Andrel {hiddenCount === 1 ? 'member works' : 'members work'} here.
            </p>
          )}
        </section>
        )}
      </div>
    </div>
  )
}
