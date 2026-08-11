# Reciprocal Recommendation Integrity — Design & Production Reconciliation

Status: **implemented for review; migration NOT applied; NO production data mutated.** The forward
fix is wired; the production reconciliation below is a **separate, operator-approved** step.

## Root cause (confirmed)
- **Concentration:** onboarding ranked the whole pool and took the global top‑N. 45% of the score
  collapsed to a constant 50 (camelCase↔snake_case field‑name bug); the only load‑balancer (exposure
  balancing) is flag‑gated off → the same top member for every fresh account.
- **One‑sided:** onboarding wrote a single directional `intro_requests` row; the reciprocal engine
  was wired only into the admin batch route.
- **No DB guard:** no canonical pair uniqueness → reversed/duplicate/racy pair creation.

## Forward fix (implemented, unapplied)
- Migration `050_member_pairs.sql`: canonical `member_pairs` (CHECK `user_a<user_b` + UNIQUE) +
  `intro_requests.pair_id` + transactional `create_reciprocal_suggestion` RPC (SECURITY DEFINER,
  `search_path=''`, schema‑qualified, REVOKE/GRANT service_role, in‑transaction eligibility recheck
  under `FOR UPDATE`, cooldown, both standard `suggested` cards labeled "Introduced by Andrel").
- `lib/matching/reciprocalPair.ts` (`selectFairCounterpart(s)` — bounded exposure tie‑breaker),
  `lib/matching/createReciprocalSuggestion.ts` (single path), `lib/matching/profileScoring.ts`
  (typed snake_case mapping).
- `generateReciprocalBatchForMember` is the ONE path; onboarding + weekly route through it; the
  legacy one‑sided enqueue is no longer called by automatic generators.

**Pair lifecycle:** a pair row is permanent (audit); it is **re‑recommendable after a cooldown**
(`p_cooldown_days`, default 30) via `last_recommended_at`, never re‑inserted or deleted.

**Rollout ordering (critical):** apply migration 050 **before** deploying this code — otherwise the
RPC is missing and automatic generation produces **zero** recommendations (surfaced by the 050
migration‑health entry).

## Production reconciliation (read‑only first; mutation is a separate operator‑approved step)

### Step 1 — read‑only audit with counts + MASKED previews
```sql
-- Concentration by target (the "everyone gets X").
SELECT target_user_id, count(*) inbound
FROM intro_requests WHERE status='suggested'
GROUP BY target_user_id ORDER BY inbound DESC LIMIT 20;

-- Masked preview of a suggestion (never expose PII in the audit).
SELECT id, left(requester_id::text,8) requester, left(target_user_id::text,8) target,
       status, is_admin_initiated, pair_id, created_at
FROM intro_requests WHERE status='suggested' ORDER BY created_at DESC LIMIT 50;
```

### Step 2 — categorize existing rows (do NOT mutate)
- **A. Untouched active one‑sided suggestions** — `status='suggested'`, no reverse row, and the
  requester has taken no action. → candidates to *supersede + replace* (Step 3), except (E).
- **B. Rows with member activity** (interest/pass/view or any non‑`suggested` state in either
  direction) — **never auto‑overwrite or delete.** Leave as‑is.
- **C. Already reciprocal / admin pairs** (`is_admin_initiated` or a matching reverse row / `pair_id`
  set) — already correct; skip.
- **D. Ineligible / stale rows** (target now ineligible, blocked, connected, or expired) — expire via
  the normal lifecycle only; do not reciprocate.
- **E. Concentrated targets** — the small set of members holding an outsized inbound count. **Do NOT
  reverse concentrated untouched recommendations** (that would amplify the concentration by giving
  those members even more inbound). Instead, only supersede the *requester*’s side and let Step 3
  generate a fair replacement for the requester.

```sql
-- Category A candidates (untouched active one-sided, target not over-concentrated).
WITH conc AS (SELECT target_user_id FROM intro_requests WHERE status='suggested'
              GROUP BY target_user_id HAVING count(*) > 5)   -- tune threshold
SELECT a.id
FROM intro_requests a
WHERE a.status='suggested' AND a.is_admin_initiated IS NOT TRUE AND a.pair_id IS NULL
  AND a.target_user_id NOT IN (SELECT target_user_id FROM conc)      -- exclude (E)
  AND NOT EXISTS (SELECT 1 FROM intro_requests b                     -- one-sided only
        WHERE b.requester_id=a.target_user_id AND b.target_user_id=a.requester_id)
  AND NOT EXISTS (SELECT 1 FROM intro_requests c                     -- exclude (B): any activity
        WHERE ((c.requester_id=a.requester_id AND c.target_user_id=a.target_user_id)
            OR (c.requester_id=a.target_user_id AND c.target_user_id=a.requester_id))
          AND c.status <> 'suggested');
```

### Step 3 — idempotent supersede + fair replacement (operator‑approved, not executed here)
For each **Category A** row (only): mark it `expired`/`archived` (supersede, do not delete → history
preserved), then run `generateReciprocalBatchForMember(requester_id, 'backfill')` which fair‑selects
a counterpart (skipping over‑concentrated members via live exposure) and creates a canonical
reciprocal pair. Idempotent: re‑running skips already‑paired members (`exists_active`) and cooled‑down
pairs. Provide dry‑run counts + a masked sample of the first N supersede/replace actions for sign‑off
**before** any write. Never touch B/C/E untouched‑concentrated rows.

## Product decisions applied
1. Scoring bug fixed, shipped only with this rollout. 2. Standard suggestion cards (`suggested`,
`is_admin_initiated=false`), both labeled "Introduced by Andrel", independent interest/pass, mutual
interest → existing match. 3. No blind reversal of concentrated one‑sided recs. 4. Onboarding + weekly
share one reciprocal path. 5. Fix forward; reconciliation is separate + operator‑approved.
