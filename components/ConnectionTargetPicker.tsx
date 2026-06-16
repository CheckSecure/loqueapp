'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  ROLE_CATEGORIES,
  type Category,
  type CategoryTitleSelection,
} from '@/lib/role-taxonomy'
import { ChevronDown, ChevronUp, X } from 'lucide-react'

interface Props {
  value: CategoryTitleSelection
  onChange: (next: CategoryTitleSelection) => void
}

/**
 * Multi-select category→title picker for "who do you want to meet" targeting.
 *
 * Storage shape (CategoryTitleSelection):
 *   absent category   → no preference for that category
 *   value[cat] === [] → "Anyone in [cat]" (whole category sentinel)
 *   value[cat] !== [] → specific titles selected
 *
 * Distinct from RoleCategoryPicker (single-select "your role"). This is
 * multi-category, multi-title. Mobile-first accordion.
 */
export default function ConnectionTargetPicker({ value, onChange }: Props) {
  const [expanded, setExpanded] = useState<Category | null>(null)

  // Mutation helpers — all return a fresh object so React re-renders cleanly.

  function toggleAnyone(cat: Category) {
    const cur = value[cat]
    const next: CategoryTitleSelection = { ...value }
    if (cur === undefined) {
      next[cat] = [] // mark whole category
    } else if (cur.length === 0) {
      delete next[cat] // turning off "Anyone"
    } else {
      next[cat] = [] // override specific titles with whole-category
    }
    onChange(next)
  }

  function toggleTitle(cat: Category, title: string) {
    const cur = value[cat]
    const next: CategoryTitleSelection = { ...value }
    if (cur === undefined || cur.length === 0) {
      // Was absent or was whole-category → set to just this title.
      next[cat] = [title]
    } else if (cur.includes(title)) {
      // Already selected → remove it.
      const filtered = cur.filter(t => t !== title)
      if (filtered.length === 0) delete next[cat]
      else next[cat] = filtered
    } else {
      // Add this title.
      next[cat] = [...cur, title]
    }
    onChange(next)
  }

  function removeFromPill(cat: Category, title?: string) {
    const cur = value[cat]
    if (cur === undefined) return
    const next: CategoryTitleSelection = { ...value }
    if (title === undefined) {
      // Pill for "Anyone in cat" — remove the whole category.
      delete next[cat]
    } else {
      const filtered = cur.filter(t => t !== title)
      if (filtered.length === 0) delete next[cat]
      else next[cat] = filtered
    }
    onChange(next)
  }

  // ── Render ────────────────────────────────────────────────────────

  const categories = Object.keys(ROLE_CATEGORIES) as Category[]
  const hasSelection = Object.keys(value).length > 0

  return (
    <div className="space-y-3">
      {/* Removable pills for current selection */}
      {hasSelection && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(value).map(([cat, titles]) => {
            if (titles.length === 0) {
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => removeFromPill(cat as Category)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#1B2850] px-3 py-1 text-xs font-medium text-white"
                  aria-label={`Remove Anyone in ${cat}`}
                >
                  Anyone in {cat}
                  <X className="h-3 w-3" />
                </button>
              )
            }
            return titles.map(t => (
              <button
                key={`${cat}:${t}`}
                type="button"
                onClick={() => removeFromPill(cat as Category, t)}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#1B2850] px-3 py-1 text-xs font-medium text-white"
                aria-label={`Remove ${t}`}
              >
                <span className="text-white/70">{cat}:</span> {t}
                <X className="h-3 w-3" />
              </button>
            ))
          })}
        </div>
      )}

      {/* Accordion of categories */}
      <div className="overflow-hidden rounded-lg border border-slate-200">
        {categories.map((cat, i) => {
          const isExpanded = expanded === cat
          const cur = value[cat]
          const isWholeCategory = cur !== undefined && cur.length === 0
          const titleCount = cur === undefined ? 0 : cur.length

          const badge = isWholeCategory ? 'Anyone' : titleCount > 0 ? `${titleCount}` : null

          return (
            <div key={cat} className={cn('bg-white', i !== 0 && 'border-t border-slate-100')}>
              <button
                type="button"
                onClick={() => setExpanded(isExpanded ? null : cat)}
                className="flex w-full items-center justify-between px-3.5 py-3 text-left hover:bg-slate-50 transition-colors"
                aria-expanded={isExpanded}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-700">{cat}</span>
                  {badge !== null && (
                    <span className="inline-flex items-center rounded-full bg-[#1B2850] px-2 py-0.5 text-[10px] font-semibold text-white">
                      {badge}
                    </span>
                  )}
                </div>
                {isExpanded ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
              </button>

              {isExpanded && (
                <div className="px-3.5 pb-3.5 space-y-2">
                  <button
                    type="button"
                    onClick={() => toggleAnyone(cat)}
                    className={cn(
                      'w-full rounded-md border px-3 py-2 text-left text-xs font-medium transition-all',
                      isWholeCategory
                        ? 'border-[#1B2850] bg-[#1B2850] text-white'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-[#1B2850]/40 hover:text-[#1B2850]'
                    )}
                  >
                    Anyone in {cat}
                  </button>
                  <div className="flex flex-wrap gap-1.5">
                    {(ROLE_CATEGORIES[cat] as readonly string[]).map(title => {
                      const selected = !isWholeCategory && cur !== undefined && cur.includes(title)
                      return (
                        <button
                          key={title}
                          type="button"
                          onClick={() => toggleTitle(cat, title)}
                          className={cn(
                            'rounded-full border px-2.5 py-1 text-xs font-medium transition-all',
                            selected
                              ? 'border-[#1B2850] bg-[#1B2850] text-white'
                              : 'border-slate-200 bg-white text-slate-600 hover:border-[#1B2850]/40 hover:text-[#1B2850]'
                          )}
                        >
                          {title}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
