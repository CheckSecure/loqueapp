'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { Search, ExternalLink, Loader2, Check } from 'lucide-react'

type CompanyRow = {
  slug: string
  name: string
  memberCount: number
  meta: {
    name?: string | null
    logo_url?: string | null
    website?: string | null
    industry?: string | null
    headquarters?: string | null
    company_size?: string | null
    description?: string | null
  } | null
}

const FIELDS: { key: keyof NonNullable<CompanyRow['meta']> | 'name'; label: string; textarea?: boolean; placeholder?: string }[] = [
  { key: 'name', label: 'Display name', placeholder: 'Google' },
  { key: 'logo_url', label: 'Logo URL', placeholder: 'https://…/logo.png' },
  { key: 'website', label: 'Website', placeholder: 'google.com' },
  { key: 'industry', label: 'Industry', placeholder: 'Software' },
  { key: 'headquarters', label: 'Headquarters', placeholder: 'Mountain View, CA' },
  { key: 'company_size', label: 'Company size', placeholder: '1000+' },
  { key: 'description', label: 'Description', textarea: true, placeholder: 'What the company does (2–5 sentences, no marketing copy).' },
]

export default function AdminCompaniesClient({ companies, tableReady }: { companies: CompanyRow[]; tableReady: boolean }) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<CompanyRow | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return companies
    return companies.filter(c => c.name.toLowerCase().includes(q) || c.slug.includes(q))
  }, [companies, query])

  function open(c: CompanyRow) {
    setEditing(c)
    setSaved(false); setError(null)
    setForm({
      name: c.meta?.name || c.name || '',
      logo_url: c.meta?.logo_url || '',
      website: c.meta?.website || '',
      industry: c.meta?.industry || '',
      headquarters: c.meta?.headquarters || '',
      company_size: c.meta?.company_size || '',
      description: c.meta?.description || '',
    })
  }

  async function save() {
    if (!editing) return
    setSaving(true); setError(null); setSaved(false)
    try {
      const res = await fetch('/api/admin/companies/upsert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: editing.slug, ...form }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Save failed'); return }
      setSaved(true)
    } catch {
      setError('Network error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      {/* List */}
      <div>
        <div className="relative mb-3">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search companies…"
            className="w-full text-sm pl-9 pr-3 py-2.5 rounded-xl border border-slate-200/80 bg-white focus:outline-none focus:border-brand-navy focus:ring-1 focus:ring-brand-navy/20"
          />
        </div>
        <div className="rounded-2xl border border-slate-200/70 bg-white divide-y divide-slate-100 overflow-hidden max-h-[70vh] overflow-y-auto">
          {filtered.map(c => (
            <button
              key={c.slug}
              onClick={() => open(c)}
              className={`w-full text-left flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50 transition-colors ${editing?.slug === c.slug ? 'bg-brand-cream/30' : ''}`}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-brand-navy truncate">{c.name}</p>
                <p className="text-xs text-slate-400 truncate">/{c.slug} · {c.memberCount} member{c.memberCount === 1 ? '' : 's'}</p>
              </div>
              {c.meta ? (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 flex-shrink-0">Enriched</span>
              ) : (
                <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400 flex-shrink-0">No data</span>
              )}
            </button>
          ))}
          {filtered.length === 0 && <p className="text-sm text-slate-500 p-4">No companies match.</p>}
        </div>
      </div>

      {/* Editor */}
      <div>
        {!tableReady && (
          <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
            The <code>companies</code> table isn&rsquo;t applied yet — saving will fail until migration 014 is run in Supabase.
          </div>
        )}
        {!editing ? (
          <div className="rounded-2xl border border-slate-200/70 bg-white p-8 text-center">
            <p className="text-sm text-slate-500">Select a company to edit its context.</p>
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200/70 bg-white p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold text-brand-navy">Editing /{editing.slug}</h3>
              <Link href={`/company/${editing.slug}`} target="_blank" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-navy hover:text-brand-gold">
                Preview <ExternalLink className="w-3 h-3" />
              </Link>
            </div>
            {FIELDS.map(f => (
              <div key={f.key}>
                <label className="block text-xs font-medium text-slate-600 mb-1">{f.label}</label>
                {f.textarea ? (
                  <textarea
                    value={form[f.key] || ''}
                    onChange={e => { setForm({ ...form, [f.key]: e.target.value }); setSaved(false) }}
                    placeholder={f.placeholder}
                    rows={4}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-brand-navy resize-none"
                  />
                ) : (
                  <input
                    value={form[f.key] || ''}
                    onChange={e => { setForm({ ...form, [f.key]: e.target.value }); setSaved(false) }}
                    placeholder={f.placeholder}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-brand-navy"
                  />
                )}
              </div>
            ))}
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-brand-navy text-white text-sm font-semibold rounded-lg hover:bg-brand-navy/90 disabled:opacity-60"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {saved ? <><Check className="w-4 h-4" /> Saved</> : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
