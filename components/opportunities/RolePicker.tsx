'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { TITLE_ALIASES, resolveTitlePick } from '@/lib/searchable-titles'
import { Search, X, ChevronDown, Check } from 'lucide-react'

interface Props {
  /** Selected canonical role_type strings (what criteria.role_types stores). */
  value: string[]
  onChange: (next: string[]) => void
}

/**
 * Searchable multi-select role picker for opportunity targeting.
 *
 * Emits ONLY canonical role_type strings sourced from TITLE_ALIASES (which is
 * firewall-validated in lib/searchable-titles.ts — every entry's role_type
 * resolves via titleToCategory). Search matches display names/aliases AND the
 * underlying role_type; selecting an alias stores its canonical role_type. No
 * arbitrary free text can enter role_types. De-duplicated by role_type.
 */
export default function RolePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapperRef = useRef<HTMLDivElement>(null)

  const selectedSet = useMemo(() => new Set(value), [value])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = q
      ? TITLE_ALIASES.filter(
          (e) => e.display.toLowerCase().includes(q) || e.role_type.toLowerCase().includes(q)
        )
      : TITLE_ALIASES
    return base.slice(0, 50)
  }, [query])

  function pick(display: string) {
    const resolved = resolveTitlePick(display)
    if (!resolved) return // display came from TITLE_ALIASES, so this won't happen
    if (selectedSet.has(resolved.role_type)) return // de-dup by canonical role_type
    onChange([...value, resolved.role_type])
    setQuery('')
  }

  function remove(roleType: string) {
    onChange(value.filter((r) => r !== roleType))
  }

  return (
    <div className="space-y-2">
      {/* Selected canonical role_types as removable chips */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((rt) => (
            <span
              key={rt}
              className="inline-flex items-center gap-1 rounded-full border border-[#1B2850]/20 bg-[#1B2850]/5 px-2.5 py-1 text-xs font-medium text-[#1B2850]"
            >
              {rt}
              <button
                type="button"
                onClick={() => remove(rt)}
                aria-label={`Remove ${rt}`}
                className="text-[#1B2850]/50 transition-colors hover:text-[#1B2850]"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div ref={wrapperRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-left text-sm hover:border-slate-400"
        >
          <Search className="h-4 w-4 text-slate-400" />
          <span className="flex-1 text-slate-500">
            {open ? 'Type to search roles…' : value.length > 0 ? 'Add another role' : 'Search and select one or more roles'}
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
                placeholder="e.g. CEO, General Counsel, Investor…"
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-sm focus:border-[#1B2850] focus:outline-none"
                autoFocus
              />
            </div>
            <ul role="listbox" className="py-1">
              {filtered.length === 0 ? (
                <li className="px-3 py-2 text-xs text-slate-400">No matches. Refine your search.</li>
              ) : (
                filtered.map((e) => {
                  const isSelected = selectedSet.has(e.role_type)
                  const isAlias = e.display !== e.role_type
                  return (
                    <li key={`${e.category}:${e.display}`}>
                      <button
                        type="button"
                        onClick={() => pick(e.display)}
                        disabled={isSelected}
                        className={cn(
                          'flex w-full items-start justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50',
                          isSelected && 'opacity-60'
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-slate-900">{e.display}</p>
                          <p className="truncate text-xs text-slate-500">
                            {e.category}
                            {isAlias && <span className="text-slate-400"> · stored as {e.role_type}</span>}
                          </p>
                        </div>
                        {isSelected && <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#1B2850]" />}
                      </button>
                    </li>
                  )
                })
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
