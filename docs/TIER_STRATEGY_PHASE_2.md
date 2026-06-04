# Tier Strategy — Phase 2 Backlog

Captures deferred tier-economics decisions and the rationale behind them, so
future work doesn't re-propose ideas the audit already rejected for a known
reason.

## Founding Member → Executive upgrade path (deferred)

A proposed billing-page feature would add an "Upgrade to Executive" CTA targeted
at Founding Members. The audit (this session) concluded **do not build**, for
the reasons captured below. Revisit only when one of the listed triggers fires.

### 1. Current state

- **Population**: 1 active Founding Member exists in production — the operator
  (`bizdev91@gmail.com`). `founding_member_expires_at = null`. No second member,
  no past or upcoming expiries.
- **Credits**:
  - Founding: 30 monthly, 60 cap (`lib/tier-override.ts:32, :43`).
  - Executive: 20 monthly, 40 cap. Both 33% lower than Founding.
- **Opportunities cap** (`lib/opportunities/caps.ts:13-18`):
  - Founding: 1 active.
  - Executive: 2 active.
- **Intros per weekly batch** (`app/dashboard/introductions/page.tsx:86-89`):
  - Founding: 3.
  - Executive: 8.
  - **Largest single differential** in Executive's favor (2.67×).
- **Two explicit server-side blocks** prevent Founding → Executive upgrade
  today:
  - `app/dashboard/billing/page.tsx:212-214` hides the "Upgrade Membership"
    section for founders with the comment *"Tier selector — hidden for founding
    members, who already have premium-equivalent benefits via the founding
    override."*
  - `app/api/stripe/checkout/route.ts:23-26` hard-rejects subscription checkout
    for founders with HTTP 400 and the message *"Founding members already have
    equivalent benefits."* under the same rationale.

### 2. Why the upsell doesn't work today

- **Credit math is a net downgrade.** Upgrading from Founding to Executive
  trades 10 monthly credits and 20 cap for more intros and one extra
  opportunity. No copy can honestly call that "more" without an asterisk on
  credits, which undermines the pitch.
- **Audience of one.** The entire targeted cohort is the operator. Building UI
  and removing two server-side blocks for a single user is poor leverage.
- **Past architectural decisions intentionally positioned Founding as
  premium-equivalent.** Both blocks above were added with comments stating
  this explicitly. Quietly reversing that stance creates inconsistency between
  the codebase's documented intent and behavior.

### 3. What would need to change first

Any future revisit should sequence these in order; do not start step 4 before
steps 1–3 land:

1. **Re-tune credit allocations** so Executive ≥ Founding on every dial. Two
   shapes worth considering:
   - Executive 30/60 (match Founding) — neutralizes the credit objection.
   - Executive 40/80 (exceed Founding) — makes Executive the clear top tier.
   - Either choice requires deliberation on Pro/Exec/Founding economic balance;
     don't slip it in as a side-effect of the upgrade UI work.
2. **OR reframe Founding benefits** so credits are positioned as the standalone
   founder perk and Executive is positioned on a different axis (intro and
   opportunity volume). This is a marketing reframing, not a code change, but
   should land before any upgrade CTA.
3. **Remove both server-side blocks** (`billing/page.tsx:212-214` and
   `stripe/checkout/route.ts:23-26`) and update the inline comments at each
   location — both currently encode the "premium-equivalent" position.
4. **Write upgrade copy** that's defensible against whatever credit trade-off
   remains after step 1/2.

### 4. When to revisit

Trigger conditions, any one of which warrants reopening this:

- More than one or two Founding Members exist and demonstrable interest signal
  emerges (e.g., real founders asking about Executive — not operator
  speculation).
- Credit allocations get re-tuned for any other reason; piggyback this
  re-evaluation onto that change.
- After Wave 1 onboarding completes and per-tier behavior data is available.

### 5. Audit findings worth preserving (likely bugs)

The audit surfaced two places where `'founding'` is missing from a tier
switch and falls through to less favorable behavior. Both are most likely
oversights from when Founding was added as a tier, not deliberate design.
Either way, both currently penalize founders slightly:

- **`lib/generate-recommendations.ts:461-543`** —
  `applyTierRankingAdjustment` has explicit `if (userTier === 'free' |
  'professional' | 'executive')` branches with a fall-through at line 542
  that just returns `rankingScore = finalScore`. A founding user gets **no
  tier-ranking adjustment at all** — not even the free user's discovery
  noise. Executive's "top 20% +15, bottom 40% −8, ±1 noise" treatment never
  applies to founders.
- **`lib/matching/scoring.ts:69-72`** — `getTierScore` map includes
  `'executive': 20, 'professional': 15, 'free': 10` but no `'founding'`
  entry, so founders default to free's 10 in the network-value calculation.

Fixing either of these (likely as `'founding': 20` and adding a founding
branch in the ranking function) would *shrink* any future Exec-over-Founding
upgrade pitch, since founders would be receiving more of Executive's
treatment by default. Worth fixing on their own merits; just note that they
affect the math of any future tier-strategy decision.
