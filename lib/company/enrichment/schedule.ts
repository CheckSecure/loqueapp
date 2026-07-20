import { waitUntil } from '@vercel/functions'
import { runEnrichment } from './run'

/**
 * Fire company enrichment in the BACKGROUND from a request/action context.
 *
 * Enrichment is triggered when a company first enters the network (a member
 * saves a profile with that company) — not when its page is viewed. This keeps
 * the initiating request fast: `waitUntil` lets the enrichment run after the
 * response is sent, on Vercel's Fluid Compute.
 *
 * Safe to call on every profile save: runEnrichment's atomic claim dedups, so an
 * already-enriched (or concurrently-enriching) company is a cheap no-op. Never
 * throws into the caller.
 */
export function scheduleEnrichment(admin: any, slug: string, name: string): void {
  if (!slug || !name?.trim()) return
  const task = runEnrichment(admin, slug, name).catch((e: any) =>
    console.error(`[company-enrich] background run failed slug=${slug}: ${e?.message || e}`),
  )
  try {
    // Extend the function's lifetime so the task completes after the response.
    waitUntil(task)
  } catch {
    // Outside a Vercel request context (e.g. local dev): the task still runs to
    // completion within the process; we just don't get lifetime extension.
    void task
  }
}
