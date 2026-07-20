import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import AdminCompaniesClient from '@/components/admin/AdminCompaniesClient'
import { companySlug, isLinkableCompany } from '@/lib/company/slug'

export const metadata = { title: 'Companies | Admin' }

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export default async function AdminCompaniesPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  const admin = createAdminClient()

  // Real companies in the network, derived from member company strings (deduped
  // by normalized slug), with a member count each.
  const { data: profs } = await admin.from('profiles').select('company').not('company', 'is', null)
  const bySlug = new Map<string, { slug: string; name: string; memberCount: number }>()
  for (const p of profs || []) {
    if (!isLinkableCompany(p.company)) continue
    const slug = companySlug(p.company)
    const e = bySlug.get(slug) || { slug, name: (p.company || '').trim(), memberCount: 0 }
    e.memberCount++
    bySlug.set(slug, e)
  }

  // Existing curated metadata (deploy-safe: empty if migration 014 isn't applied).
  const metaRes = await admin.from('companies').select('slug, name, logo_url, website, industry, headquarters, company_size, description')
  const tableReady = !metaRes.error
  const metaBySlug = new Map((metaRes.data || []).map((r: any) => [r.slug, r]))

  const companies = Array.from(bySlug.values())
    .map(c => ({ ...c, meta: metaBySlug.get(c.slug) ?? null }))
    .sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name))

  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-brand-navy tracking-tight">Companies</h1>
          <p className="text-slate-500 text-sm mt-1">Curate company context. {companies.length} companies across the network.</p>
        </div>
        <AdminCompaniesClient companies={companies} tableReady={tableReady} />
      </div>
    </div>
  )
}
