'use client'

import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, ArrowUp, ArrowDown, Loader2, X } from 'lucide-react'
import { ROLE_CATEGORIES, ROLE_CATEGORY_LABELS, type ProfileRole, type RoleCategory } from '@/lib/profileRoles'

/**
 * Additional roles & affiliations editor — a self-contained CRUD panel that saves
 * each change immediately through /api/profile/roles (independent of the main
 * "Save profile" button). Optional; never part of profile completion; never
 * touches the primary role fields.
 */

type Draft = {
  organization_name: string
  title: string
  role_category: RoleCategory
  industry: string
  is_current: boolean
  description: string
}
const emptyDraft = (): Draft => ({
  organization_name: '', title: '', role_category: 'board_member', industry: '', is_current: true, description: '',
})

export default function AdditionalRolesEditor() {
  const [roles, setRoles] = useState<ProfileRole[]>([])
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false) // migration 042 pending
  const [editingId, setEditingId] = useState<string | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function refresh() {
    try {
      const res = await fetch('/api/profile/roles')
      const data = await res.json().catch(() => ({}))
      setRoles(Array.isArray(data.roles) ? data.roles : [])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { refresh() }, [])

  function startAdd() { setDraft(emptyDraft()); setEditingId('new'); setError('') }
  function startEdit(r: ProfileRole) {
    setDraft({
      organization_name: r.organization_name, title: r.title ?? '', role_category: r.role_category,
      industry: r.industry ?? '', is_current: r.is_current, description: r.description ?? '',
    })
    setEditingId(r.id); setError('')
  }
  function cancel() { setEditingId(null); setError('') }

  async function save() {
    if (!draft.organization_name.trim()) { setError('Organization is required.'); return }
    setBusy(true); setError('')
    try {
      const isNew = editingId === 'new'
      const res = await fetch(isNew ? '/api/profile/roles' : `/api/profile/roles/${editingId}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 503) { setUnavailable(true); setEditingId(null); return }
        setError(data.error || 'Could not save'); return
      }
      setEditingId(null)
      await refresh()
    } finally { setBusy(false) }
  }

  async function remove(id: string) {
    setBusy(true)
    try {
      const res = await fetch(`/api/profile/roles/${id}`, { method: 'DELETE' })
      if (res.status === 503) { setUnavailable(true); return }
      await refresh()
    } finally { setBusy(false) }
  }

  async function move(index: number, dir: -1 | 1) {
    const next = [...roles]
    const j = index + dir
    if (j < 0 || j >= next.length) return
    ;[next[index], next[j]] = [next[j], next[index]]
    setRoles(next) // optimistic
    setBusy(true)
    try {
      await fetch('/api/profile/roles/reorder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: next.map((r) => r.id) }),
      })
    } finally { setBusy(false) }
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-900 mb-1">Additional roles &amp; affiliations</h3>
      <p className="text-xs text-slate-500 mb-3 leading-relaxed">
        Add board seats, advisory roles, association leadership, committee work, investment roles, and other
        professional affiliations. Optional — your primary role above stays your main profile headline.
      </p>

      {unavailable && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg mb-3">
          Additional roles aren&rsquo;t available just yet. Please check back soon.
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : (
        <>
          {/* Saved roles */}
          {roles.length > 0 && (
            <ul className="space-y-2 mb-3">
              {roles.map((r, i) => (
                <li key={r.id} className="flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2">
                  <div className="flex flex-col gap-0.5 pt-0.5">
                    <button type="button" onClick={() => move(i, -1)} disabled={busy || i === 0} className="text-slate-300 hover:text-slate-600 disabled:opacity-30" aria-label="Move up"><ArrowUp className="w-3.5 h-3.5" /></button>
                    <button type="button" onClick={() => move(i, 1)} disabled={busy || i === roles.length - 1} className="text-slate-300 hover:text-slate-600 disabled:opacity-30" aria-label="Move down"><ArrowDown className="w-3.5 h-3.5" /></button>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800 truncate">
                      {r.title ? `${r.title} — ` : ''}{r.organization_name}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {ROLE_CATEGORY_LABELS[r.role_category] ?? r.role_category}
                      {' · '}{r.is_current ? 'Current' : 'Past'}
                      {r.industry ? ` · ${r.industry}` : ''}
                    </p>
                  </div>
                  <button type="button" onClick={() => startEdit(r)} className="text-slate-400 hover:text-brand-navy" aria-label="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                  <button type="button" onClick={() => remove(r.id)} disabled={busy} className="text-slate-400 hover:text-red-600" aria-label="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                </li>
              ))}
            </ul>
          )}

          {/* Add / edit form */}
          {editingId ? (
            <div className="rounded-lg border border-brand-navy/15 bg-[#F8F9FC] p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-brand-navy">{editingId === 'new' ? 'Add a role' : 'Edit role'}</span>
                <button type="button" onClick={cancel} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
              </div>
              <input value={draft.organization_name} onChange={(e) => setDraft({ ...draft, organization_name: e.target.value })} maxLength={120} placeholder="Organization *" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={120} placeholder="Title / role (optional)" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              <div className="grid grid-cols-2 gap-2">
                <select value={draft.role_category} onChange={(e) => setDraft({ ...draft, role_category: e.target.value as RoleCategory })} className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white">
                  {ROLE_CATEGORIES.map((c) => <option key={c} value={c}>{ROLE_CATEGORY_LABELS[c]}</option>)}
                </select>
                <select value={draft.is_current ? 'current' : 'past'} onChange={(e) => setDraft({ ...draft, is_current: e.target.value === 'current' })} className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white">
                  <option value="current">Current</option>
                  <option value="past">Past</option>
                </select>
              </div>
              <input value={draft.industry} onChange={(e) => setDraft({ ...draft, industry: e.target.value })} maxLength={80} placeholder="Industry (optional)" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={500} rows={2} placeholder="Description (optional)" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm resize-none" />
              {error && <p className="text-xs text-red-600">{error}</p>}
              <div className="flex gap-2">
                <button type="button" onClick={save} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold bg-[#1B2850] text-white rounded-lg hover:bg-[#2E4080] disabled:opacity-60">
                  {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save role
                </button>
                <button type="button" onClick={cancel} className="px-3 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-white">Cancel</button>
              </div>
            </div>
          ) : (
            !unavailable && (
              <button type="button" onClick={startAdd} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-brand-navy border border-slate-200 rounded-lg hover:bg-slate-50">
                <Plus className="w-3.5 h-3.5" /> Add role or affiliation
              </button>
            )
          )}
        </>
      )}
    </div>
  )
}
