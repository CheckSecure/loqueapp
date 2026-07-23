# Company enrichment — incremental & versioned

Self-hosted company enrichment (no LLM, no third-party API key). "Enrichment"
resolves a company's canonical identity + authoritative website from a registry,
scrapes its homepage for metadata, stores its logo in Supabase Storage, and
writes those values as columns on the `companies` row. The rendered "company
page" (`app/company/[slug]/page.tsx`) is just those columns.

## Incremental & idempotent by design

There is **no manual list** of companies to enrich. The set Andrel cares about is
derived from members' `company` fields (`computeNetworkCompanies`). A single
predicate decides what to process:

`needsEnrichment(row)` in [`version.ts`](./version.ts) — the source of truth. It
returns `true` for a company that is:

| Category | Condition |
| --- | --- |
| missing | in the member graph but no `companies` row yet |
| never_enriched | row exists, `enrichment_status` is `NULL` |
| outdated_version | `enriched` but `enrichment_version` is `NULL` or `< ENRICHMENT_VERSION` |
| failed / not_found / partial | past the 7-day retry cooldown (`ENRICH_RETRY_MS`) |
| in_progress (stale) | claim older than the cooldown |

…and `false` for `up_to_date` (enriched at the current version) and for any
`admin_edited` row (human edits are never overwritten).

`runEnrichment`'s atomic claim admits `null / failed / not_found / partial /
stale`. Only an **outdated** `enriched` row needs `{ force: true }` — that's what
`requiresForce(row)` flags.

## Versioning — how to trigger a re-enrich

`ENRICHMENT_VERSION` (in [`version.ts`](./version.ts)) is the current standard.
Every successful enrich stamps `companies.enrichment_version` with it.

**To re-flow improved enrichment through every page: bump `ENRICHMENT_VERSION`
by 1.** On the next incremental run, every row below the new version is detected
as `outdated_version` and force-re-enriched; everything already at the new
version is skipped. No data migration, no manual list.

History of the constant lives in its doc comment.

## Persisted tracking columns (on `companies`)

| Column | Meaning |
| --- | --- |
| `enrichment_status` | `enriched` / `partial` / `not_found` / `failed` / `in_progress` (≈ complete / incomplete / not found / failed / pending) |
| `enrichment_version` | version stamped on last successful enrich (migration 017) |
| `enrichment_attempted_at` | last attempt (drives the retry cooldown) |
| `enriched_at` | last successful enrich |
| `enrichment_error` | last failure reason |
| `enrichment_source` | provenance (`registry`, `registry:homepage`, `search`, `self:homepage`, …) |

`not_found` / `failed` rows are intentionally left **unstamped**, so they stay
retry-eligible and **self-heal** once discovery improves (e.g. `SEARCH_API_KEY`
is configured) — the next post-cooldown run picks them up automatically.

## Running it

- **Automatic (primary):** on profile save, `scheduleEnrichment` enriches a
  newly-seen company in the background. New companies need no intervention.
- **Reconciliation (backfill):** `GET /api/cron/enrich-companies`
  (`CRON_SECRET`-gated) sweeps the network for anything `needsEnrichment` flags,
  capped per run, and returns the census `report`.
- **Report on demand:** `GET /api/admin/companies/enrichment-status` (admin)
  returns `report` (total / upToDate / pending / failed / notFound /
  outdatedVersion / newlyCreatedNotEnriched / needsWork / orphanRows) plus
  `enrichmentVersion` and `versioningEnabled`.

## Migration

`supabase/migrations/017_enrichment_version.sql` adds `enrichment_version` and
backfills existing `enriched` rows to `1`. The code **degrades gracefully** if
017 hasn't been applied (persists without the stamp; `versioningEnabled: false`),
so code and migration can deploy in either order.
