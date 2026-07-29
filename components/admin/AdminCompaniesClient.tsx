'use client'

import { useState, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Search, ExternalLink, Loader2, Check, RefreshCw, Upload, Trash2 } from 'lucide-react'
import { buildEditorFormFromPreview } from '@/lib/company/previewEditor'

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
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<CompanyRow | null>(null)
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoError, setLogoError] = useState<string | null>(null)
  const logoInputRef = useRef<HTMLInputElement | null>(null)
  // Deferred logo storage: the chosen file is held client-side (with a local
  // object-URL preview) and only stored in the bucket when Save succeeds — so an
  // uploaded-but-never-saved logo never creates an orphan file.
  const [pendingLogoFile, setPendingLogoFile] = useState<File | null>(null)
  const [pendingLogoPreview, setPendingLogoPreview] = useState<string | null>(null)

  function clearPendingLogo() {
    setPendingLogoFile(null)
    setPendingLogoPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null })
  }
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [repairing, setRepairing] = useState(false)
  const [repairMsg, setRepairMsg] = useState<string | null>(null)
  const [repairStages, setRepairStages] = useState<Record<string, any> | null>(null)
  // "Enrich Missing Company Data" backfill progress.
  const [backfilling, setBackfilling] = useState(false)
  const [bf, setBf] = useState<{ totalMissing: number; processed: number; total: number; succeeded: number; failed: number; done: boolean } | null>(null)
  // CSV enrichment import (one-time cleanup): paste → preview → apply → export audit.
  const [csv, setCsv] = useState('')
  const [impBusy, setImpBusy] = useState(false)
  const [impError, setImpError] = useState<string | null>(null)
  const [impPreview, setImpPreview] = useState<{ summary: any; preview: any[]; parseErrors: any[] } | null>(null)
  const [impResult, setImpResult] = useState<{ summary: any; results: any[] } | null>(null)
  const [showUnmatched, setShowUnmatched] = useState(false)

  async function runBackfill() {
    if (backfilling) return
    setBackfilling(true)
    let offset = 0
    let succeeded = 0
    let failed = 0
    try {
      // Walk the stable, resumable batches until done.
      for (let guard = 0; guard < 1000; guard++) {
        const res = await fetch('/api/admin/company-enrichment/backfill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offset }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) { setBf((p) => (p ? { ...p, done: true } : p)); break }
        succeeded += data.succeeded || 0
        failed += data.failed || 0
        setBf({
          totalMissing: data.totalMissing ?? 0,
          processed: data.processed ?? 0,
          total: data.totalCompanies ?? 0,
          succeeded,
          failed,
          done: !!data.done,
        })
        if (data.done || data.nextOffset == null) break
        offset = data.nextOffset
      }
    } catch {
      setBf((p) => (p ? { ...p, done: true } : { totalMissing: 0, processed: 0, total: 0, succeeded, failed, done: true }))
    }
    setBackfilling(false)
  }

  async function previewImport() {
    if (impBusy || !csv.trim()) return
    setImpBusy(true); setImpError(null); setImpResult(null); setImpPreview(null); setShowUnmatched(false)
    try {
      const res = await fetch('/api/admin/company-enrichment/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) setImpError(data.error || (data.reason === 'companies_table_absent' ? 'The companies table is not available yet.' : 'Preview failed.'))
      else setImpPreview({ summary: data.summary, preview: data.preview || [], parseErrors: data.parseErrors || [] })
    } catch (e: any) { setImpError(e?.message || 'Preview failed.') }
    setImpBusy(false)
  }

  async function applyImport() {
    if (impBusy || !csv.trim()) return
    if (!window.confirm('Apply these updates? This fills only missing logos/descriptions on matched companies. Existing values and admin-edited rows are never overwritten.')) return
    setImpBusy(true); setImpError(null)
    try {
      const res = await fetch('/api/admin/company-enrichment/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv, apply: true }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) setImpError(data.error || 'Import failed.')
      else { setImpResult({ summary: data.summary, results: data.results || [] }); setImpPreview(null) }
    } catch (e: any) { setImpError(e?.message || 'Import failed.') }
    setImpBusy(false)
  }

  function downloadAudit() {
    const rows = impResult?.results || []
    const esc = (v: any) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const header = ['company_name', 'fields_updated', 'previous_value', 'new_value', 'skipped_reason']
    const body = rows.map((r: any) => [r.company_name, r.fields_updated, r.previous_value, r.new_value, r.skipped_reason].map(esc).join(','))
    const csvText = [header.join(','), ...body].join('\n')
    const url = URL.createObjectURL(new Blob([csvText], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url; a.download = 'company-import-audit.csv'; a.click()
    URL.revokeObjectURL(url)
  }
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
    clearPendingLogo()
    setSaved(false); setError(null); setRepairMsg(null); setRepairStages(null); setLogoError(null)
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

  // Open the editor for ANY CSV preview row. Resolved rows edit the resolved
  // company (materialized or pending network company) with existing values winning.
  // not_found rows open a "pending company enrichment" editor keyed by the canonical
  // slug (p.slug === companySlug(company_name)); Save materializes it via the upsert
  // path with admin_edited = true.
  async function openFromPreview(p: any) {
    if (!p) return
    setLogoError(null)
    const existing = companies.find((c) => c.slug === p.slug) || null
    const base: CompanyRow = existing ?? { slug: p.slug, name: p.matched_company || p.company_name, memberCount: 0, meta: null }
    await open(base)
    // Overlay: existing values win; CSV fills the gaps.
    setForm(buildEditorFormFromPreview(p, existing))
  }

  const LOGO_MIME = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']

  // Choose a logo file — held locally until Save; server re-validates by magic bytes then.
  function selectLogo(file: File) {
    setLogoError(null)
    if (file.size < 200) { setLogoError('Image is too small (looks like a placeholder).'); return }
    if (file.size > 5_000_000) { setLogoError('Image is too large (max 5 MB).'); return }
    if (file.type && !LOGO_MIME.includes(file.type)) { setLogoError('Accepted formats: PNG, JPG, SVG, ICO.'); return }
    setPendingLogoFile(file)
    setPendingLogoPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file) })
    setSaved(false)
    if (logoInputRef.current) logoInputRef.current.value = ''
  }

  function removeLogo() {
    clearPendingLogo()
    setForm({ ...form, logo_url: '' }); setSaved(false); setLogoError(null)
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
    setSaving(true); setError(null); setSaved(false); setLogoError(null)
    try {
      // Finalize a pending logo into the company-logos bucket ONLY now (deferred
      // storage). Server re-validates by magic bytes; a rejection aborts the save.
      let logoUrl = form.logo_url
      if (pendingLogoFile) {
        setLogoUploading(true)
        const fd = new FormData()
        fd.append('slug', editing.slug)
        fd.append('file', pendingLogoFile)
        const up = await fetch('/api/admin/companies/logo', { method: 'POST', body: fd })
        const upData = await up.json().catch(() => ({}))
        setLogoUploading(false)
        if (!up.ok || !upData.ok) { setError(upData.error || 'Logo upload failed.'); return }
        logoUrl = upData.url
      }
      const res = await fetch('/api/admin/companies/upsert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: editing.slug, ...form, logo_url: logoUrl }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Save failed'); return }
      // Persisted: reflect the finalized logo and drop the pending file.
      clearPendingLogo()
      setForm((prev) => ({ ...prev, logo_url: logoUrl }))
      setSaved(true)
      // A pending (preview) company is created on save — refresh so it appears in the list.
      router.refresh()
    } catch {
      setError('Network error')
    } finally {
      setSaving(false); setLogoUploading(false)
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
        {/* Backfill: enrich companies missing a logo or description. */}
        <div className="mb-3 rounded-xl border border-slate-200/70 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">Enrich Missing Company Data</p>
              <p className="text-xs text-slate-500 mt-0.5">Fill logos &amp; descriptions for companies missing them. Safe &amp; resumable — already-enriched and admin-edited companies are skipped.</p>
            </div>
            <button
              onClick={runBackfill}
              disabled={backfilling || !tableReady}
              className="flex-shrink-0 flex items-center gap-2 px-4 py-2 bg-brand-navy text-white text-sm font-semibold rounded-lg hover:bg-brand-navy/90 disabled:opacity-50"
            >
              {backfilling ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {backfilling ? 'Enriching…' : 'Enrich Missing Company Data'}
            </button>
          </div>
          {bf && (
            <div className="mt-3 grid grid-cols-4 gap-2 text-center">
              <div className="rounded-lg bg-slate-50 border border-slate-100 py-2">
                <p className="text-base font-bold text-slate-900">{bf.totalMissing}</p>
                <p className="text-[11px] text-slate-500">Missing</p>
              </div>
              <div className="rounded-lg bg-slate-50 border border-slate-100 py-2">
                <p className="text-base font-bold text-slate-900">{bf.processed}/{bf.total}</p>
                <p className="text-[11px] text-slate-500">Processed</p>
              </div>
              <div className="rounded-lg bg-emerald-50 border border-emerald-100 py-2">
                <p className="text-base font-bold text-emerald-700">{bf.succeeded}</p>
                <p className="text-[11px] text-emerald-600">Completed</p>
              </div>
              <div className="rounded-lg bg-red-50 border border-red-100 py-2">
                <p className="text-base font-bold text-red-600">{bf.failed}</p>
                <p className="text-[11px] text-red-500">Failed</p>
              </div>
            </div>
          )}
          {bf?.done && !backfilling && <p className="mt-2 text-xs text-emerald-700">Done.</p>}
        </div>

        {/* CSV enrichment import: one-time cleanup of missing logos/descriptions. */}
        <div className="mb-3 rounded-xl border border-slate-200/70 bg-white p-4">
          <p className="text-sm font-semibold text-slate-900">Import Company Enrichment (CSV)</p>
          <p className="text-xs text-slate-500 mt-0.5">
            Paste a CSV (<code className="text-[11px]">company_name, website, logo_url, description</code>) to fill only <em>missing</em> fields.
            Preview first — existing values and admin-edited rows are never overwritten; logos are validated &amp; re-hosted.
          </p>
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={'company_name,website,logo_url,description\nAcme Corp,acme.com,https://…/logo.png,"What Acme does."'}
            rows={4}
            className="mt-2 w-full text-xs font-mono rounded-lg border border-slate-200/80 bg-white p-2 focus:outline-none focus:border-brand-navy focus:ring-1 focus:ring-brand-navy/20"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={previewImport}
              disabled={impBusy || !tableReady || !csv.trim()}
              className="flex items-center gap-2 px-3 py-1.5 border border-slate-300 text-slate-700 text-sm font-semibold rounded-lg hover:bg-slate-50 disabled:opacity-50"
            >
              {impBusy && !impResult ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Preview
            </button>
            {impPreview && impPreview.summary.toUpdate > 0 && (
              <button
                onClick={applyImport}
                disabled={impBusy}
                className="flex items-center gap-2 px-3 py-1.5 bg-brand-navy text-white text-sm font-semibold rounded-lg hover:bg-brand-navy/90 disabled:opacity-50"
              >
                {impBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Apply {impPreview.summary.toUpdate} update{impPreview.summary.toUpdate === 1 ? '' : 's'}
              </button>
            )}
          </div>
          {impError && <p className="mt-2 text-xs text-red-600">{impError}</p>}

          {impPreview && (
            <div className="mt-3">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600">
                <span>{impPreview.summary.csvRows} rows</span>
                <span className="text-emerald-700">{impPreview.summary.toUpdate} to update</span>
                <span className="text-slate-500">{impPreview.summary.toSkip} skip</span>
                <span className="text-amber-600">{impPreview.summary.notFound} not found</span>
                {impPreview.summary.parseErrors > 0 && <span className="text-red-600">{impPreview.summary.parseErrors} parse errors</span>}
                {typeof impPreview.summary.networkCount === 'number' && (
                  <span className="text-slate-400">{impPreview.summary.networkCount} network · {impPreview.summary.existingCount} existing candidates</span>
                )}
                {impPreview.summary.networkError && <span className="text-red-600">network load failed</span>}
              </div>
              <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-slate-100 divide-y divide-slate-100">
                {impPreview.preview.map((p: any, i: number) => {
                  const isNotFound = p.action === 'not_found'
                  return (
                  <div
                    key={i}
                    onClick={() => openFromPreview(p)} // every row is clickable
                    role="button"
                    title={isNotFound ? 'Click to create this company' : 'Click to edit this company'}
                    className="px-3 py-2 text-xs cursor-pointer hover:bg-slate-50"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0">
                        {/* Original CSV name → resolved company, slug, and match confidence. */}
                        <span className="font-medium text-slate-800">{p.company_name}</span>
                        {!isNotFound && (
                          <span className="text-slate-500"> → {p.matched_company || p.slug} <span className="text-slate-400">/{p.slug} · <span className={p.confidence === 'exact' ? 'text-emerald-600' : p.confidence === 'canonical' ? 'text-sky-600' : 'text-amber-600 font-semibold'}>{p.confidence}</span></span></span>
                        )}
                        {isNotFound && <span className="text-slate-400"> → /{p.slug} · not in network</span>}
                      </span>
                      <span className="flex items-center gap-2 flex-shrink-0">
                        <span className={p.action === 'update' ? 'text-emerald-700 font-semibold' : isNotFound ? 'text-brand-navy font-semibold' : 'text-slate-400'}>
                          {isNotFound ? 'create company' : `${p.action}${p.reason ? ` · ${p.reason}` : ''}`}
                        </span>
                        <span className="text-[10px] font-semibold text-brand-navy">{isNotFound ? 'Edit enrichment →' : 'Edit →'}</span>
                      </span>
                    </div>
                    {p.action === 'update' && (
                      <div className="mt-1 space-y-0.5 text-[11px] text-slate-500">
                        {p.new_logo_url && <div>logo: <span className="text-slate-400">{p.current_logo_url || '—'}</span> → <span className="text-emerald-700 break-all">{p.new_logo_url}</span></div>}
                        {p.new_description && <div>description: <span className="text-slate-400">{p.current_description ? '(existing)' : '—'}</span> → <span className="text-emerald-700">{p.new_description.slice(0, 120)}{p.new_description.length > 120 ? '…' : ''}</span></div>}
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>

              {/* Diagnostic: why did rows fail to match? Show unmatched + closest candidates. */}
              {impPreview.summary.notFound > 0 && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setShowUnmatched((v) => !v)}
                    className="text-[11px] font-semibold text-brand-navy hover:underline"
                  >
                    {showUnmatched ? 'Hide' : 'Show'} unmatched companies ({impPreview.summary.notFound})
                  </button>
                  {showUnmatched && (
                    <div className="mt-2 overflow-x-auto rounded-lg border border-slate-100">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="bg-slate-50 text-slate-500 text-left">
                            <th className="px-2 py-1.5 font-medium">CSV Name</th>
                            <th className="px-2 py-1.5 font-medium">CSV Slug</th>
                            <th className="px-2 py-1.5 font-medium">Possible Network Company</th>
                            <th className="px-2 py-1.5 font-medium">Network Slug</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {impPreview.preview.filter((p: any) => p.action === 'not_found').map((p: any, i: number) => {
                            const matches = (p.closest_network_matches || [])
                            if (!matches.length) return (
                              <tr key={i}>
                                <td className="px-2 py-1.5 text-slate-800">{p.company_name}</td>
                                <td className="px-2 py-1.5 text-slate-400">{p.slug}</td>
                                <td className="px-2 py-1.5 text-slate-400 italic" colSpan={2}>no similar network company</td>
                              </tr>
                            )
                            return matches.map((m: any, j: number) => (
                              <tr key={`${i}-${j}`}>
                                <td className="px-2 py-1.5 text-slate-800">{j === 0 ? p.company_name : ''}</td>
                                <td className="px-2 py-1.5 text-slate-400">{j === 0 ? p.slug : ''}</td>
                                <td className="px-2 py-1.5 text-slate-700">{m.company_name}</td>
                                <td className="px-2 py-1.5 text-slate-400">{m.slug}</td>
                              </tr>
                            ))
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {impResult && (
            <div className="mt-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-600">
                <span className="text-emerald-700 font-semibold">{impResult.summary.updatedCompanies} companies updated</span>
                <span>{impResult.summary.updatedFields} fields filled</span>
                {impResult.summary.logoRejected > 0 && <span className="text-amber-600">{impResult.summary.logoRejected} logos rejected</span>}
                <button onClick={downloadAudit} className="ml-auto flex items-center gap-1 text-brand-navy font-semibold hover:underline">
                  <ExternalLink className="w-3.5 h-3.5" /> Export audit CSV
                </button>
              </div>
              <p className="mt-1 text-[11px] text-emerald-700">Import complete. Re-uploading the same CSV will make no further changes.</p>
            </div>
          )}
        </div>

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
              <h3 className="text-sm font-bold text-brand-navy">
                {companies.some(c => c.slug === editing.slug) ? 'Editing' : 'Creating'} /{editing.slug}
                {!companies.some(c => c.slug === editing.slug) && <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-brand-navy bg-brand-cream/50 border border-brand-navy/20 rounded-full px-2 py-0.5">new</span>}
              </h3>
              <Link href={`/company/${editing.slug}`} target="_blank" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-navy hover:text-brand-gold">
                Preview <ExternalLink className="w-3 h-3" />
              </Link>
            </div>
            {FIELDS.map(f => (
              <div key={f.key}>
                <label className="block text-xs font-medium text-slate-600 mb-1">{f.label}</label>
                {f.key === 'logo_url' ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-3">
                      <div className="w-14 h-14 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-center overflow-hidden flex-shrink-0">
                        {(pendingLogoPreview || form.logo_url)
                          ? <img src={pendingLogoPreview || form.logo_url} alt="Logo" className="max-w-full max-h-full object-contain" />
                          : <span className="text-[10px] text-slate-400">No logo</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          ref={logoInputRef}
                          type="file"
                          accept="image/png,image/jpeg,image/svg+xml,image/x-icon,.png,.jpg,.jpeg,.svg,.ico"
                          onChange={e => { const file = e.target.files?.[0]; if (file) selectLogo(file) }}
                          className="hidden"
                        />
                        <button
                          type="button"
                          onClick={() => logoInputRef.current?.click()}
                          disabled={logoUploading || !tableReady}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 text-slate-700 text-xs font-semibold rounded-lg hover:bg-slate-50 disabled:opacity-50"
                        >
                          <Upload className="w-3.5 h-3.5" /> {pendingLogoFile ? 'Change Logo' : 'Upload Logo'}
                        </button>
                        {(pendingLogoFile || form.logo_url) && (
                          <button type="button" onClick={removeLogo} className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 text-slate-500 text-xs font-semibold rounded-lg hover:bg-slate-50">
                            <Trash2 className="w-3.5 h-3.5" /> Remove
                          </button>
                        )}
                      </div>
                    </div>
                    {pendingLogoFile && <p className="text-[11px] text-amber-600">Pending — this logo is stored only when you click Save.</p>}
                    {logoError && <p className="text-xs text-red-600">{logoError}</p>}
                    <input
                      value={form.logo_url || ''}
                      onChange={e => { setForm({ ...form, logo_url: e.target.value }); setSaved(false) }}
                      placeholder="…or paste a logo URL (advanced)"
                      className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-brand-navy"
                    />
                  </div>
                ) : f.textarea ? (
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
