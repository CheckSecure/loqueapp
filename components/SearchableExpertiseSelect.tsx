'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { EXPERTISE_OPTIONS } from '@/lib/profile-options'
import { Search, X, ChevronDown } from 'lucide-react'

interface Props {
  /** Canonical expertise tags currently selected (subset of EXPERTISE_OPTIONS). */
  selected: string[]
  /** Legacy non-canonical tags preserved from prior writes (display + remove only). */
  additional?: string[]
  onChange: (next: string[]) => void
  onRemoveAdditional?: (tag: string) => void
}

/**
 * Searchable expertise multi-select for Phase D.
 *
 * - Typeahead filter over EXPERTISE_OPTIONS
 * - Multi-select via Array.from(new Set(...)) dedup
 * - Selected tags shown as removable chips above the search
 * - Stored format unchanged: flat string[] (caller's onChange handles
 *   serialization via .join(',') in the form, same as before)
 *
 * Matching is exact-string set intersection (calculateAlignmentScore), so this
 * picker ONLY ever stores canonical strings from EXPERTISE_OPTIONS.
 * Legacy non-canonical tags persisted by older versions surface as a separate
 * "Additional" chip row — removable but not re-selectable here.
 */
export default function SearchableExpertiseSelect({ selected, additional = [], onChange, onRemoveAdditional }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const selectedSet = useMemo(() => new Set(selected), [selected])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return EXPERTISE_OPTIONS.filter((tag) => {
      if (q && !tag.toLowerCase().includes(q)) return false
      return true
    })
  }, [query])

  function toggle(tag: string) {
    if (!EXPERTISE_OPTIONS.includes(tag)) return // belt-and-suspenders
    const next = selectedSet.has(tag)
      ? selected.filter((t) => t !== tag)
      : Array.from(new Set([...selected, tag]))
    onChange(next)
  }

  function removeSelected(tag: string) {
    onChange(selected.filter((t) => t !== tag))
  }

  return (
    <div className="space-y-3">
      {/* Selected canonical tags */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => removeSelected(tag)}
              className="inline-flex items-center gap-1 rounded-full bg-[#1B2850] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#162040] transition-colors"
              aria-label={`Remove ${tag}`}
            >
              {tag}
              <X className="h-3 w-3" />
            </button>
          ))}
        </div>
      )}

      {/* Legacy non-canonical tags — display + remove only */}
      {additional.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold text-slate-700">
            Additional expertise <span className="font-normal text-slate-400">(legacy values you've previously saved)</span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {additional.map((tag) => (
              <span key={tag} className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600">
                {tag}
                {onRemoveAdditional && (
                  <button
                    type="button"
                    onClick={() => onRemoveAdditional(tag)}
                    className="text-slate-400 hover:text-slate-700"
                    aria-label={`Remove ${tag}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            ))}
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
            {open ? 'Type to search expertise tags…' : 'Add expertise'}
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
                placeholder="e.g. Privacy, Cybersecurity, FP&A…"
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-sm focus:border-[#1B2850] focus:outline-none"
                autoFocus
              />
            </div>
            <ul className="py-1">
              {filtered.length === 0 ? (
                <li className="px-3 py-2 text-xs text-slate-400">No matches.</li>
              ) : (
                filtered.map((tag) => (
                  <li key={tag}>
                    <button
                      type="button"
                      onClick={() => toggle(tag)}
                      className={cn(
                        'flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50',
                        selectedSet.has(tag) && 'bg-[#1B2850]/5 text-[#1B2850]'
                      )}
                    >
                      <span className="text-slate-900">{tag}</span>
                      {selectedSet.has(tag) && <span className="text-xs text-[#1B2850]">selected</span>}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
