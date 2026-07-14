'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { filterExpertiseOptions } from '@/lib/expertise'
import { Search, X, ChevronDown } from 'lucide-react'

interface Props {
  /** All currently selected expertise tags (canonical or previously-saved). */
  selected: string[]
  onChange: (next: string[]) => void
}

/**
 * Unified searchable expertise multi-select.
 *
 * ONE system: every value in `selected` — whether it's a canonical option or a
 * previously-saved value — renders as the same removable chip. The dropdown
 * offers canonical options that match the query and aren't already selected
 * (so nothing appears twice). Removing a chip lets any canonical value be added
 * back from the dropdown.
 *
 * Stored format unchanged: the caller serializes `selected` (flat string[]).
 */
export default function SearchableExpertiseSelect({ selected, onChange }: Props) {
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

  // Canonical options matching the query, minus anything already selected.
  const filtered = useMemo(() => filterExpertiseOptions(query, selected), [query, selected])

  function add(tag: string) {
    // Dropdown only surfaces non-selected options, so this always adds.
    if (selected.some((t) => t.toLowerCase() === tag.toLowerCase())) return
    onChange([...selected, tag])
    setQuery('')
  }

  function remove(tag: string) {
    onChange(selected.filter((t) => t !== tag))
  }

  return (
    <div className="space-y-3">
      {/* Selected tags — one unified, removable chip list */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => remove(tag)}
              className="inline-flex items-center gap-1 rounded-full bg-[#1B2850] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#162040] transition-colors"
              aria-label={`Remove ${tag}`}
            >
              {tag}
              <X className="h-3 w-3" />
            </button>
          ))}
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
                      onClick={() => add(tag)}
                      className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50"
                    >
                      <span className="text-slate-900">{tag}</span>
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
