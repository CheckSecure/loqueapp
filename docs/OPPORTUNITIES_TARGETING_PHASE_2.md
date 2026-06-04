# Opportunities Audience Targeting — Phase 2 Backlog

Phase 1 (this commit) closed the directional bug for legal-service business
opportunities: `lib/opportunities/relevance.ts` `NEED_TO_ROLE_TYPES` no longer
returns `'In-house Counsel'` as an acceptable provider for `privacy`,
`privacy counsel`, `employment counsel`, `compliance`, or `regulatory` needs.

The deeper structural gaps remain. Bundle these into Phase 2 once Wave 1
launch state is stable.

## Items

### 1. Business-opportunity creator UI: explicit `role_types` picker
- Current state: `app/dashboard/opportunities/new/business/page.tsx` collects free-text `need`, `industry`, `expertise` only. The provider audience is **inferred** from the `need` string via `acceptedRoleTypesForNeed` (`lib/opportunities/relevance.ts:29-37`). Creator has zero control over audience targeting.
- Compare: hiring form (`app/dashboard/opportunities/new/hiring/page.tsx:112-120`) exposes a `role_types` multi-select with these options: `['In-house Counsel', 'Law firm attorney', 'Consultant', 'Compliance', 'Legal Operations']`.
- Phase 2: add the same multi-select to the business form. Pre-fill with the inferred audience from `acceptedRoleTypesForNeed(need)` as a suggested default; let the creator edit.

### 2. `selectProviders` honors explicit `criteria.role_types`
- Current state: `lib/opportunities/matching.ts:473` hardcodes `acceptedRoles = acceptedRoleTypesForNeed(opportunity.criteria.need)` — ignores any creator-supplied `role_types` even though `criteria.role_types?: string[]` is already in the type signature (`:68`).
- Phase 2: prefer `opportunity.criteria.role_types` when present; fall back to `acceptedRoleTypesForNeed(need)` only when the creator didn't supply one. Pairs naturally with item #1.

### 3. Hiring `role_type` filter strength decision
- Current state: hiring uses `role_type` as a soft scoring boost only — `+15` if candidate's `role_type` is in the creator's requested list, `0` otherwise (`matching.ts:287-289`). Explicit comment at `:433-434`: *"Option C: role_type is a scoring boost for hiring, not a hard filter."*
- Symptom: a creator hiring for `role_types=['Law firm attorney']` can receive `Consultant` candidates as long as their expertise overlap pushes them past the 40-point threshold. The +15 boost is small relative to the threshold.
- Phase 2 decision: keep current Option C (preserves serendipity, allows cross-role suggestions for niche skill matches), OR promote to hard filter (matches creator intent more tightly), OR raise the boost weight (e.g., +40) to give role_type real gating force.
- Trade-off: stricter filter = fewer cross-role suggestions for highly relevant non-traditional matches; looser filter = creator confusion when "wrong" candidates show up.

### 4. Substring fuzzy-matching in `acceptedRoleTypesForNeed`
- Current state: `relevance.ts:33-35` uses `key.includes(k) || k.includes(key)` for fallback. A `need` like `"Privacy and AI compliance program review"` matches the `'privacy'` key first and returns its mapping.
- Phase 2 consideration: explicit creator-supplied `role_types` (item #1) makes this fuzzy match the secondary path. Once item #1 ships, the substring matching matters less. Could still be refined to prefer longer matches (`'compliance'` before `'privacy'`) but probably not worth it post-#1.

### 5. Profile `role_type` ↔ `title` consistency audit
- Pattern observed: Alexandra Chen had `title='VP & General Counsel'`, bio describing in-house work, but `role_type='Consultant'`. Not a code bug — interacts with the matching logic.
- Phase 2: build a one-off admin query or migration script to surface profiles where `title` and `role_type` semantically disagree (e.g., title contains "General Counsel" / "In-house" but `role_type != 'In-house Counsel'`). Operator-curate or prompt user.

### 6. Founding-member expiry inconsistency across tier paths
- Current state: `lib/opportunities/eligibility.ts:87` treats `is_founding_member` as a plain boolean — `if (profile.is_founding_member) return { ok: true };` — and never reads `founding_member_expires_at`.
- Compare path: `lib/tier-override.ts` `getEffectiveTier()` honors expiry — if `founding_member_expires_at < now`, it falls through to the user's Stripe `subscription_tier` instead of returning `'founding'`.
- Symptom: An **expired** founding member (`is_founding_member = true`, `founding_member_expires_at < now`) would be granted opportunity creation by the API and by the new server-side redirect in `app/dashboard/opportunities/new/{hiring,business}/page.tsx`, but would be treated as their Stripe `subscription_tier` by the introductions matching engine. The two paths disagree about the same user. No impact for current Wave 1 founders (none have expired yet).
- Phase 2 fix: prefer routing `eligibility.ts` through `getEffectiveTier()` so both paths share one expiry-aware helper; duplicating the expiry check at line 87 is a fallback if the shared-helper refactor is too broad. The shared-helper approach means future changes flow through one location.

## Dependency order for Phase 2
1. Item #1 + #2 together — UI surfacing + matcher prefers explicit input. Shippable as one PR.
2. Item #3 — separate decision; lower priority once #1+#2 land (creators have real control).
3. Item #5 — independent data-hygiene task, can run anytime.
4. Item #6 — independent tier-semantics cleanup, run before any founding-member cohort starts expiring.
5. Item #4 — likely no-op after #1+#2; revisit if needed.
