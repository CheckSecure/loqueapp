'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { Search, ExternalLink, Loader2, Check, RefreshCw } from 'lucide-react'

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
  const [repairing, setRepairing] = useState(false)
  const [repairMsg, setRepairMsg] = useState<string | null>(null)
  const [repairStages, setRepairStages] = useState<Record<string, any> | null>(null)
  // Fallback metadata (company_metadata) — used only when scraping is blocked.
  const [fb, setFb] = useState<Record<string, string>>({})
  const [fbSaving, setFbSaving] = useState(false)
  const [fbSaved, setFbSaved] = useState(false)
  const [fbError, setFbError] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return companies
    return companies.filter(c => c.name.toLowerCase().includes(q) || c.slug.includes(q))
  }, [companies, query])

  async function open(c: CompanyRow) {
    setEditing(c)
    setSaved(false); setError(null); setRepairMsg(null); setRepairStages(null)
    setForm({
      name: c.meta?.name || c.name || '',
      logo_url: c.meta?.logo_url || '',
      website: c.meta?.website || '',
      industry: c.meta?.industry || '',
      headquarters: c.meta?.headquarters || '',
      company_size: c.meta?.company_size || '',
      description: c.meta?.description || '',
    })
    // Load the curated fallback layer for this company.
    setFb({}); setFbSaved(false); setFbError(null)
    try {
      const res = await fetch(`/api/admin/companies/metadata?slug=${encodeURIComponent(c.slug)}`)
      const data = await res.json()
      const m = data?.metadata || {}
      setFb({ description: m.description || '', industry: m.industry || '', headquarters: m.headquarters || '', logo_url: m.logo_url || '' })
    } catch { /* non-fatal */ }
  }

  async function saveFallback() {
    if (!editing) return
    setFbSaving(true); setFbError(null); setFbSaved(false)
    try {
      const res = await fetch('/api/admin/companies/metadata', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: editing.slug, ...fb }),
      })
      const data = await res.json()
      if (!res.ok || data.error) { setFbError(data.error || 'Save failed'); return }
      setFbSaved(true)
    } catch {
      setFbError('Network error')
    } finally {
      setFbSaving(false)
    }
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

  // Repair = re-run enrichment for this one company (registry domain-first).
  // admin-edited values are preserved (the pipeline never overwrites them).
  async function repair() {
    if (!editing) return
    setRepairing(true); setRepairMsg(null); setError(null); setRepairStages(null)
    try {
      const res = await fetch('/api/company/enrich', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: editing.slug, refresh: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error || 'Repair failed'); return }
      setRepairStages(data.stages || null)
      const s = data.status
      setRepairMsg(
        s === 'enriched' ? 'Re-enriched from the authoritative homepage.'
        : s === 'partial' ? 'Identity set (homepage blocked — description/logo unavailable).'
        : s === 'not_found' ? 'No canonical domain — company is not in the registry.'
        : s === 'skipped' ? 'Skipped — admin-edited values are preserved.'
        : `Done (${s ?? 'unknown'}).`,
      )
    } catch {
      setError('Network error')
    } finally {
      setRepairing(false)
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
            {repairMsg && <p className="text-xs text-emerald-700">{repairMsg}</p>}
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-brand-navy text-white text-sm font-semibold rounded-lg hover:bg-brand-navy/90 disabled:opacity-60"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {saved ? <><Check className="w-4 h-4" /> Saved</> : 'Save'}
              </button>
              <button
                onClick={repair}
                disabled={repairing}
                title="Re-run enrichment from the authoritative homepage (preserves admin edits)"
                className="inline-flex items-center gap-1.5 px-4 py-2 border border-brand-navy/25 text-brand-navy text-sm font-semibold rounded-lg hover:bg-brand-cream/40 disabled:opacity-60"
              >
                {repairing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Repair
              </button>
            </div>

            {repairStages && (
              <div className="grid grid-cols-2 gap-1.5 text-[11px] pt-1">
                {([['Identity', repairStages.identity], ['Website', repairStages.website ? 'set' : 'none'], ['Description', repairStages.description], ['Logo', repairStages.logo]] as [string, any][]).map(([label, val]) => {
                  const ok = val && val !== 'none' && val !== 'unresolved' && val !== false
                  return (
                    <div key={label} className={`flex items-center justify-between rounded-md px-2 py-1 border ${ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
                      <span className="font-medium">{label}</span>
                      <span>{String(val)}</span>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Fallback metadata (company_metadata) */}
            <div className="mt-4 pt-4 border-t border-slate-100">
              <h4 className="text-xs font-bold text-brand-navy">Fallback metadata</h4>
              <p className="text-[11px] text-slate-400 mb-2">Used only when scraping is blocked and no value exists. Scraped and admin-override values take precedence.</p>
              {([{ key: 'description', label: 'Description', textarea: true }, { key: 'industry', label: 'Industry' }, { key: 'headquarters', label: 'Headquarters' }, { key: 'logo_url', label: 'Logo URL' }] as { key: string; label: string; textarea?: boolean }[]).map(f => (
                <div key={f.key} className="mb-2">
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">{f.label}</label>
                  {f.textarea ? (
                    <textarea value={fb[f.key] || ''} onChange={e => { setFb({ ...fb, [f.key]: e.target.value }); setFbSaved(false) }} rows={2} className="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-brand-navy resize-none" />
                  ) : (
                    <input value={fb[f.key] || ''} onChange={e => { setFb({ ...fb, [f.key]: e.target.value }); setFbSaved(false) }} className="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-brand-navy" />
                  )}
                </div>
              ))}
              {fbError && <p className="text-xs text-red-600">{fbError}</p>}
              <button onClick={saveFallback} disabled={fbSaving} className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-brand-navy/25 text-brand-navy text-xs font-semibold rounded-lg hover:bg-brand-cream/40 disabled:opacity-60">
                {fbSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {fbSaved ? <><Check className="w-3.5 h-3.5" /> Saved</> : 'Save fallback'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
