'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { TITLE_ALIASES, resolveTitlePick, type SearchableTitle } from '@/lib/searchable-titles'
import { titleToCategory } from '@/lib/role-taxonomy'
import { Search, X, ChevronDown } from 'lucide-react'

interface Props {
  /** Current stored role_type (must already be in ROLE_CATEGORIES or legacy). */
  roleType: string
  /** Current stored exact_job_title (display override). null = use role_type. */
  exactJobTitle: string | null
  /** Emits the resolved write payload. role_type is ALWAYS a structured value. */
  onChange: (next: { role_type: string; exact_job_title: string | null }) => void
}

/**
 * Searchable role-title combobox for onboarding + profile edit.
 *
 * Two-part state:
 *  - Picker: selects from TITLE_ALIASES (display strings). Resolves to a
 *    structured/legacy role_type via resolveTitlePick.
 *  - Custom-title text input (optional): user can override exact_job_title
 *    with a free-text string while keeping the structured role_type.
 *
 * THE FIREWALL: this component CANNOT write a non-structured value to
 * role_type. The only paths to onChange.role_type are TITLE_ALIASES entries,
 * each of which has its role_type pre-validated against titleToCategory.
 */
export default function SearchableTitleSelect({ roleType, exactJobTitle, onChange }: Props) {
  // Find the TITLE_ALIASES entry whose display matches the user's current display:
  //   - prefer the alias whose role_type === current roleType AND display === exactJobTitle
  //   - fallback: the alias whose role_type matches and display === roleType
  const initial: SearchableTitle | undefined = useMemo(() => {
    if (exactJobTitle) {
      return TITLE_ALIASES.find((e) => e.role_type === roleType && e.display === exactJobTitle)
    }
    return TITLE_ALIASES.find((e) => e.role_type === roleType && e.display === roleType)
  }, [roleType, exactJobTitle])

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pickedDisplay, setPickedDisplay] = useState<string>(
    initial?.display ?? exactJobTitle ?? roleType ?? ''
  )
  const [customExact, setCustomExact] = useState<string>(
    // Show custom override field only when user has typed an exact title
    // that DOESN'T equal the alias's display string (a true override).
    initial && exactJobTitle && exactJobTitle !== initial.display ? exactJobTitle : ''
  )
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return TITLE_ALIASES.slice(0, 50)
    return TITLE_ALIASES
      .filter((e) => e.display.toLowerCase().includes(q) || e.role_type.toLowerCase().includes(q))
      .slice(0, 50)
  }, [query])

  function pickDisplay(display: string) {
    const resolved = resolveTitlePick(display)
    if (!resolved) return // shouldn't happen — display came from filtered list
    setPickedDisplay(display)
    setQuery('')
    setOpen(false)
    // Reset custom override on a fresh pick
    setCustomExact('')
    // Emit. exact_job_title comes from the alias mapping (null if structured).
    onChange({ role_type: resolved.role_type, exact_job_title: resolved.exact_job_title })
  }

  function applyCustomExact(text: string) {
    setCustomExact(text)
    const resolved = resolveTitlePick(pickedDisplay)
    if (!resolved) return
    const trimmed = text.trim()
    onChange({
      role_type: resolved.role_type,
      exact_job_title: trimmed.length > 0 ? trimmed : resolved.exact_job_title,
    })
  }

  // Display labels
  const currentCategory = titleToCategory(roleType)
  const currentMatch = TITLE_ALIASES.find((e) => e.display === pickedDisplay)

  return (
    <div className="space-y-3">
      {/* Selected title pill (showing the picked display + structured role) */}
      {pickedDisplay && (
        <div className="flex items-start gap-2 rounded-lg border border-[#1B2850]/20 bg-[#1B2850]/5 px-3 py-2">
          <div className="flex-1">
            <p className="text-sm font-medium text-[#1B2850]">{pickedDisplay}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              Stored as <span className="font-mono">{currentMatch?.role_type ?? roleType}</span>
              {currentCategory && ` · ${currentCategory}`}
            </p>
          </div>
        </div>
      )}

      {/* Combobox */}
      <div ref={wrapperRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left text-sm hover:border-[#1B2850]/40 transition-colors"
          aria-expanded={open}
        >
          <Search className="h-4 w-4 text-slate-400" />
          <span className="flex-1 text-slate-500">
            {open ? 'Type to search titles…' : pickedDisplay ? 'Change role title' : 'Pick a role title'}
          </span>
          <ChevronDown className={cn('h-4 w-4 text-slate-400 transition-transform', open && 'rotate-180')} />
        </button>

        {open && (
          <div className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
            <div className="sticky top-0 border-b border-slate-100 bg-white p-2">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. CFO, Privacy Officer, Board Member…"
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-sm focus:border-[#1B2850] focus:outline-none"
                autoFocus
              />
            </div>
            <ul role="listbox" className="py-1">
              {filtered.length === 0 ? (
                <li className="px-3 py-2 text-xs text-slate-400">No matches. Refine your search.</li>
              ) : (
                filtered.map((e) => {
                  const isAlias = e.display !== e.role_type
                  return (
                    <li key={`${e.category}:${e.display}`}>
                      <button
                        type="button"
                        onClick={() => pickDisplay(e.display)}
                        className={cn(
                          'flex w-full items-start justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50',
                          pickedDisplay === e.display && 'bg-[#1B2850]/5 text-[#1B2850]'
                        )}
                      >
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-slate-900">{e.display}</p>
                          <p className="truncate text-xs text-slate-500">
                            {e.category}
                            {isAlias && (
                              <>
                                {' · '}
                                <span className="text-slate-400">stored as {e.role_type}</span>
                              </>
                            )}
                          </p>
                        </div>
                      </button>
                    </li>
                  )
                })
              )}
            </ul>
          </div>
        )}
      </div>

      {/* Optional free-text exact title — lets a user on a structured pick add a custom display */}
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-600">
          Exact job title <span className="text-slate-400 font-normal">(optional — overrides display only, never matching)</span>
        </label>
        <input
          type="text"
          value={customExact}
          onChange={(e) => applyCustomExact(e.target.value)}
          placeholder="e.g. SVP, Strategic Partnerships"
          maxLength={140}
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-[#1B2850] focus:outline-none"
        />
      </div>
    </div>
  )
}
