# Andrel — Product System Document

**Last updated:** April 28, 2026
**Audience:** Engineers, AI assistants (Claude), and operators working on Andrel.
**Purpose:** Single source of truth for how the system is built, why it's built that way, and how to extend it without breaking the product's core philosophy.

This document is designed so that a new AI with no prior context can read it and continue building immediately. It is intentionally detailed and specific — no marketing language.

---

## Table of Contents

1. [Core Philosophy & Product Principles](#1-core-philosophy--product-principles)
2. [System Architecture Overview](#2-system-architecture-overview)
3. [Core Product Systems](#3-core-product-systems)
   - 3A. Introductions Engine
   - 3B. Network Layer
   - 3C. Messaging System
   - 3D. Notification System
   - 3E. Credits & Monetization
   - 3F. Admin System
   - 3G. Design System
   - 3H. Issue Reports (User Feedback Loop)
4. [Opportunities Engine](#4-opportunities-engine)
5. [Data Model (High-Level)](#5-data-model-high-level)
6. [User Flows (Step-by-Step)](#6-user-flows-step-by-step)
7. [Guardrails](#7-guardrails)
8. [UX & Tone Guidelines](#8-ux--tone-guidelines)
9. [Operational Details](#9-operational-details)
10. [Known Issues / Backlog](#10-known-issues--backlog)
11. [How to Extend the System](#11-how-to-extend-the-system)

Appendices:
- A. Known Traps / Silent-Failure Pitfalls
- B. Test Accounts
- C. Admin Routines

---

## 1. Core Philosophy & Product Principles

### What Andrel is

Andrel is a premium, invite-only professional introductions platform for legal and business professionals. The product curates 1:1 introductions between members. Its primary unit of activity is the introduction — two people meeting each other because the system has a reason to believe they should.

### What Andrel is NOT

- Not a social feed or newsfeed
- Not a public profile search / browse directory
- Not a jobs board
- Not a marketplace where anyone can message anyone
- Not an event platform
- Not LinkedIn

If a feature would move Andrel toward any of those, it violates the product's core philosophy and should not be built.

### Key Principles

**Curation over discovery.** Members do not browse. The system proposes. Every introduction is earned by signal (matching score, admin judgment, or mutual interest), not by user search. This is what makes the product feel premium.

**Private by default.** Members are not visible to each other unless matched. There is no directory. Profiles are revealed only in the context of a proposed or accepted introduction.

**High signal, low volume.** A member might see 3–8 curated introductions per month (tier-dependent), not 300. Volume would erode curation.

**Mutual consent.** Every connection requires both sides to opt in. This holds for user-expressed interest AND admin-curated introductions. Nothing is forced.

**Silent decline.** When a user passes on an introduction, the other party is not notified. This protects the relational tone and avoids the social pain that transparent rejection would create.

**No feeds.** If it scrolls infinitely, it's a feed. Andrel has no feed. Inboxes, curated introduction batches, and direct messages are the only surfaces.

**Credits tie effort to meaning.** Users pay (via credit deduction or subscription) to act — express interest, accept an intro. This keeps actions deliberate and prevents spam.

**Admin curation is a nudge, not a shortcut.** Admin-proposed introductions bypass the matching algorithm but DO NOT bypass user consent. Both users still choose whether to accept.

### Decision Framework

When in doubt, ask:

1. Does this reduce signal per interaction? → Probably not.
2. Does this increase surface area where users can initiate contact? → Needs justification.
3. Does this make Andrel feel more like LinkedIn? → Don't build it.
4. Does this preserve mutual consent? → Must.
5. Does this respect the user's credit cost and tier? → Required.

---

## 2. System Architecture Overview

### Stack

- **Frontend:** Next.js 14 (App Router) with TypeScript, React Server Components + Client Components. Tailwind CSS for styling.
- **Backend:** Supabase (PostgreSQL 15+, with Row-Level Security on all public-schema tables).
- **Auth:** Supabase Auth (email + password; magic link optional).
- **Payments:** Stripe (subscription tiers + credit purchases).
- **Email:** Resend.
- **Hosting:** Vercel (web + serverless routes). Cron jobs managed via `vercel.json`.
- **Admin primary email:** `bizdev91@gmail.com` (single admin; no role-based ACL yet).

### Repository Layout

```
~/loqueapp
├── app/                      # Next.js App Router
│   ├── dashboard/            # Authenticated user pages (Network, Messages, Introductions, Meetings, Profile, Billing, Settings, Admin, Opportunities)
│   ├── onboarding/           # Signup → profile completion
│   ├── api/                  # Backend routes
│   │   ├── admin/            # Admin-only endpoints (inspect-pair, admin-create-match, unblock, etc.)
│   │   ├── intro-requests/   # Accept / Decline / Express Interest endpoints
│   │   ├── messages/         # Conversation-level CRUD, including /read for marking inbound messages read
│   │   ├── opportunities/    # respond, dismiss, create, list endpoints
│   │   ├── profile/          # profile + opportunity-preferences update endpoints
│   │   ├── notifications/    # List, mark-read, unread-count
│   │   ├── billing/          # Stripe checkout + credit purchase
│   │   ├── webhooks/stripe/  # Stripe webhook handler (one of two parallel — see backlog)
│   │   └── cron/             # monthly-batch, weekly-refresh, daily-refill, cleanup, nudge-reply, (opportunities-maintain TBD)
│   └── (marketing)/          # Public landing pages
├── components/               # Shared React components
│   ├── ui/                   # Design system primitives: Card, Button, Avatar, Pill, EmptyState, Toggle
│   └── opportunities/        # ReceiverCard, OpportunityPreferences
├── lib/                      # Shared business logic
│   ├── admin/                # requireAdmin, inspectPair
│   ├── db/                   # filters.ts (bidirectional PostgREST filter helpers)
│   ├── notifications/        # createNotificationSafe + types
│   ├── matching/             # matchInsights, Andrel Score utilities
│   ├── opportunities/        # caps, connect (mutual interest), matching, rateLimits, unreadCount
│   ├── supabase/             # server + admin + client Supabase factories
│   ├── trust/                # trust_signals tracking (scoring)
│   ├── parseExpertise.ts     # robust profiles.expertise parser (3 storage formats)
│   └── profile-options.ts    # canonical EXPERTISE_OPTIONS (33 tags)
├── docs/                     # This document and others
├── tailwind.config.ts        # Brand tokens + theme config
├── vercel.json               # Cron schedule config
└── package.json
```

### Supabase Project

- Project ID: `cyjyutmtsovfnnbbluxc`
- Admin email for ops: `bizdev91@gmail.com`
- All public-schema tables have RLS enabled.

### How Systems Connect

```
Browser
  └─> Next.js Server Components
        ├─> createClient() — user-scoped Supabase (respects RLS)
        └─> Routes to pages + client components

Browser
  └─> Fetch /api/* endpoints
        ├─> createClient() for auth check
        ├─> createAdminClient() for privileged writes (bypasses RLS)
        └─> Supabase PostgreSQL

External events
  ├─> Stripe → /api/webhooks/stripe → subscription + credit updates
  └─> Vercel cron → /api/cron/* → batch generation, refresh, refill
```

### Two Supabase Clients

This is load-bearing and easy to get wrong.

- **`createClient()` from `@/lib/supabase/server`** — authenticated as the signed-in user. All queries go through RLS. Use in API routes that act on behalf of the user.
- **`createAdminClient()` from `@/lib/supabase/admin`** — authenticated with the service role key. Bypasses all RLS. Use ONLY for system-level writes: backend scoring, notification creation, admin tools, cron jobs, and any insert the user themselves shouldn't be able to do directly.

**Rule:** If a table has RLS enabled AND your insert/update is coming from a backend context (not reflecting a user's direct intent), use the admin client. Using the user client for backend writes causes silent failures when RLS policies don't cover that write pattern — we've hit this in `trust_signals` and `notifications` historically.

---

## 3. Core Product Systems

### 3A. Introductions Engine

The heart of Andrel. Three distinct paths create introductions:

1. **Monthly batch** — algorithmic, mutual-interest flow
2. **Admin proposal** — curated by human admin, mutual-consent flow
3. **Mutual-interest auto-match** — when two users independently express interest in each other

All three end in the same terminal state: `matches` row with `status = 'active'` + `conversations` row + icebreakers + system intro message.

#### Monthly Batch Generation

**Cron:** `/api/cron/monthly-batch` runs at `0 9 1 * *` (9 AM UTC, 1st of each month).

Despite the filename history (it was called `weekly-batch` until April 2026), the cadence is monthly. The sibling cron `weekly-refresh` (Mondays 9 AM) handles notifications + refresh of existing batches.

**Per user, the generator runs `generateOnboardingRecommendations(userId)` which:**

1. Loads user profile + checks for `targeted_requests` (premium feature: user-specified preferences for this batch)
2. Determines tier via `getEffectiveTier(profile)` → recommendation count:
   - Free: 3
   - Professional: 5
   - Executive: 8
   - Founding: 5 (same as professional)
3. Fetches all candidates: `account_status = 'active' AND profile_complete = true`, excluding self and admin.
4. **Applies exclusions:**
   - Already matched (bidirectional), unless removed-and-past-180-day-cooldown
   - Blocked in either direction (`blocked_users` table)
   - Hidden permanently (intro_request status `hidden`) OR passed within last 75 days (status `passed`)
   - Any existing intro request in statuses `suggested`, `pending`, `accepted`, `admin_pending`, `approved`
5. **Scores each candidate:**
   - `Final Score = Alignment (55%) + Network Value (30%) + Responsiveness (15%) + bonuses`
   - Alignment: goal/preference overlap (30), seniority fit (20), expertise overlap (max 15), location (5–15)
   - Network Value Score + Responsiveness Score: stored on each profile, updated by trust signals
   - Priority bonus: +5 if `is_priority` is true
   - Boost bonus: `boost_score * 0.5` (admin can manually boost)
   - Tier adjustment: slight randomness for free tier; top-candidate preference at higher tiers
   - Mentorship adjustment: -15 if senior user has mentorship off but candidate is junior
   - Targeted request boost: up to +15 if the user's premium targeted request matches
6. **Filters:** minimum `finalScore >= 10`. Applies mentorship filter (juniors only see seniors open to mentorship; seniors with mentorship off don't see juniors).
7. **Ranks** using `applyTierRankingAdjustment` — tier-specific randomness and rank-boost logic that gives paying tiers cleaner top-of-list ordering.
8. **Throttles business solutions** (consultants, law firms, legal tech, legal services): max 30% of batch by default, scaled down by tier (executive: 15%) and user preference (halved if not open to solutions). Ensures at least 1 business solution ONLY if user explicitly opted in.
9. **Junior distribution control:** For senior users with mentorship on, caps juniors at 20% of batch (or 0 if mentorship off). Interleaves to prevent clustering.
10. **Generates `match_reason`** — humanized explanation: "She has deep M&A experience at Skadden and could accelerate your growth," etc. Uses `generateIntroReason()` which picks phrasing based on the relationship archetype (shared expertise + mentor, peer + shared expertise, law firm → in-house, etc.).
11. **Inserts** N `intro_requests` rows with `status = 'suggested'`, `match_reason` set, `created_at` now. User will see these on `/dashboard/introductions`.

**Key file:** `lib/generate-recommendations.ts` (999 lines)

#### Approval Gate

Generated batches are NOT immediately visible to users. They sit in `introduction_batches` with `status` that isn't yet `active`. An admin must click "Approve" in `/dashboard/admin/batches` which:

- Sets the new batch's `status = 'active'`
- Sets the previous batch's `status = 'completed'`
- Flips every `batch_suggestions` row in the new batch from `generated` → `shown` with a `shown_at` timestamp (90-day cooldown begins)
- Notifications to users are fired by the subsequent `weekly-refresh` cron, not directly at approval

This gate is the single most important recurring admin action. Without it, users never see their new batch.

#### Express Interest Flow (User-Initiated)

User sees a `suggested` intro on `/dashboard/introductions`. Clicks "Express interest" button (`RequestIntroButton.tsx`).

1. Client calls server action `submitIntroRequest(targetId)` — creates a new `intro_requests` row with status `pending`, `requester_id = user.id`.
2. Client then POSTs to `/api/intro-requests/express-interest` with the new intro request id.
3. Server:
   - Validates 1 free credit available; deducts 1 free credit
   - Loads the intro_request, marks it `approved`
   - Sends `interest_received` notification to the other user
   - Checks for **reverse request** (other user already expressed interest)
     - For user-initiated: looks for `requester_id = other, target_user_id = self, status IN (pending, approved)`
   - If found: **mutual interest detected** → creates `matches` row (active), `conversations` row, icebreakers, system intro message, sends `mutual_match` to both users
   - If not: just records the accept, waits for the other user

**Credit semantic:** 1 free credit per Express Interest click. Mutual match is "free" at second click (both already paid).

#### Admin Proposal Flow

Admin opens `/dashboard/admin/match-inspector`, enters two user emails or UUIDs, clicks **Propose Introduction** (labeled "Create Admin Intro" in older code).

`POST /api/admin/admin-create-match` does the following (it does NOT create a match immediately):

1. Safety: checks block status, existing active match, existing open admin intro.
2. Inserts **two** `intro_requests` rows — one per direction — with:
   - `status = 'admin_pending'`
   - `is_admin_initiated = true`
   - `admin_notes = 'manual_create'`
3. Sends `admin_intro` notification to both users ("A curated introduction — We think you should meet — this is a strong match.").
4. Returns `{ mode: 'intro_proposed' }`.

Both users see an **Introduced by Andrel** card at the top of their `/dashboard/introductions` page with Accept/Pass buttons.

**First accept:**
- Calls `/api/intro-requests/express-interest` with the intro id that targets THEM
- Server logic recognizes `is_admin_initiated = true` and uses **direction-aware reverse-request check**:
  - For admin intros, reverse row is `(requester=expresser, target=other)`, must have `status = 'approved'`
  - Current user's row transitions `admin_pending → approved`; other row still `admin_pending`
- Match is NOT created. Card updates to "Waiting on [Name]."
- `admin_intro_nudge` notification fires to the other user ("Introduction update — Someone is ready to connect with you.")

**Second accept:**
- Same endpoint; reverse row now `approved`, triggers mutual-match creation
- Match created with `admin_facilitated = true`, `admin_notes = 'manual_create'`, `status = 'active'`
- Conversation + icebreakers + system intro message created
- `mutual_match` notifications fired to both users ("Introduction ready — You're now connected.")
- User who just accepted is redirected to `/dashboard/network`

**Decline (either side):**
- Calls `/api/intro-requests/decline-admin-intro`
- Server updates BOTH intro_requests rows in the pair to `status = 'declined'` in a single transaction
- No notification to the other user — silent per spec
- Internal `console.log('[AdminIntro] Declined silently', ...)` for audit
- Other user sees no admin intro card on their introductions page next visit

#### Statuses — Canonical List

`intro_requests.status` is a **free-text column** (no CHECK constraint) so new statuses can be added without migrations. Current values:

| Status | Meaning | Source |
|--------|---------|--------|
| `suggested` | Batch recommendation, user hasn't acted yet | Monthly batch generator |
| `pending` | User-initiated intro (legacy path) | submitIntroRequest |
| `approved` | User has accepted / expressed interest | express-interest endpoint |
| `accepted` | Used historically; new code uses `approved` | Legacy |
| `admin_pending` | Admin-proposed intro awaiting user accept | admin-create-match |
| `declined` | User declined an admin intro (silent) | decline-admin-intro |
| `passed` | User passed on a suggested intro (75-day cooldown) | passOnSuggestion (not-permanent) |
| `hidden` | User hid suggestion permanently | passOnSuggestion (permanent) |
| `archived` | Cleaned up by cron (stale/completed) | cleanup-expired-requests cron |

`matches.status`: `active`, `accepted`, `removed`. Removed has a 180-day cooldown before the pair can be suggested again by the batch generator.

### 3B. Network Layer

A connection exists between two users when a `matches` row exists with:
- `status` in `active` or `accepted`
- `removed_at` is NULL

The Network tab at `/dashboard/network` lists these connections.

#### Remove vs Block

**Remove** (soft):
- Sets `matches.status = 'removed'`, `removed_at = now`, `removed_by = user.id`
- Bidirectional: both users stop seeing each other in Network
- Pair enters 180-day cooldown before the batch generator can re-suggest them
- Does NOT prevent future user-initiated or admin-initiated intros if both users want
- Admin can restore via `/api/admin/restore-match`
- Removed pair still has an archived conversation (hidden from both inboxes)

**Block** (hard):
- Inserts a row into `blocked_users (user_id, blocked_user_id)`
- Marks the match `removed`
- Bidirectional exclusion — neither user can see the other in any surface
- Admin can unblock via `/api/admin/unblock`
- All batch / express-interest / admin-create-match safety checks respect this

#### Visibility Rules

- A user sees another user's profile only when:
  - A connection exists (Network tab)
  - The other user is the target of a currently-visible intro (Introductions tab)
  - The other user is in a shared conversation (Messages tab)
- No other surface exposes a profile.

### 3C. Messaging System

**Conversation lifecycle:**

1. Created by match creation (mutual interest, admin intro accepted, etc.)
2. Rows inserted into `conversations (match_id, suggested_prompts jsonb)` + icebreakers generated by `generateIcebreakers({ userA, userB })` and written to `suggested_prompts`
3. A system intro message is inserted into `messages` with `sender_id = NULL`, `is_system = true`, and content from `generateSystemIntroMessage({ userA, userB, reason })`
4. Participants can freely message via `/api/messages/send` (each message inserts into `messages`)

**System messages vs user messages:**

- System: `sender_id` is NULL, `is_system` is true. Rendered as distinct "Andrel" voice, not attributable to either user. Used for intro context and lifecycle events.
- User: `sender_id` is the user's id, `is_system` is false.

**Icebreakers:** Stored on `conversations.suggested_prompts` (jsonb array of 3–5 short prompt strings). Rendered in the conversation UI as clickable chips for the user to seed their first message.

**First message:** No enforced delay, no "first contact fee." The credit was already paid at the express-interest or admin-intro-accept moment; messaging itself is free.

**Admin bypass:** `/api/messages/list` allows the admin user (bizdev91@gmail.com) to read any conversation's messages, even when not a participant. Used by Match Inspector's "Open Conversation" link. Other message endpoints still enforce participation.

### 3D. Notification System

Powered by the `notifications` table (user_id, type text, title, body, link, data jsonb, read_at nullable timestamp).

**No CHECK constraint on `type`.** It's free text. Schema debt was removed during Prompt #14 — a historical whitelist had been silently rejecting every new type we added.

**Canonical types (from `lib/notifications/index.ts`):**

| Type | Title | When Fired |
|------|-------|-----------|
| `new_batch` | New curated introductions | Monthly batch approval → weekly-refresh cron |
| `interest_received` | New connection interest | User-initiated Express Interest received |
| `mutual_match` | Introduction ready | Both users have accepted (either flow) |
| `message_received` | New message | Someone sent you a message |
| `admin_intro` | A curated introduction | Admin proposed an intro involving you |
| `admin_intro_nudge` | Introduction update | Other user accepted an admin intro; your turn |
| `low_credits` | Credits running low | free_credits dropped to 1 |
| `no_credits` | No credits remaining | free_credits hit 0 |
| `nudge_interest` | Connections waiting | Cron: unviewed intros exist |
| `nudge_reply` | Introduction awaiting response | Cron: message has sat without reply |
| `new_connection` | (legacy) | Used in older flows |
| `intro_accepted` | (legacy) | Used in older flows |
| `meeting_request` | Meeting requested | Meeting flow |
| `meeting_accepted` | Meeting accepted | Meeting flow |
| `meeting_declined` | Meeting declined | Meeting flow |

**Creation:**

Always via `createNotificationSafe({ userId, type, data? })` from `@/lib/notifications`. Never direct Supabase inserts — the helper handles:
- 24-hour deduplication per (user, type)
- Copy lookup from `NOTIFICATION_COPY`
- Link derivation from `LINK_BY_TYPE` (defaults to `/dashboard/introductions` for intro-related, `/dashboard/messages` for mutual_match + message_received, `/dashboard/billing` for credit warnings)
- Silent failure on error (returns null) but now with explicit console.error logging

**Read/unread:** Stored as `read_at` timestamp, NOT a boolean `read` column. Any endpoint querying `.eq('read', false)` is broken — use `.is('read_at', null)`.

**Bell UI:** `components/NotificationBell.tsx` wired into `Sidebar.tsx` and `MobileNav.tsx`. Gold badge for unread count. Click opens dropdown with up to 10 most recent, click a notification routes via the `link` column and marks read.

**Polling:** 30-second polling of `/api/notifications/unread-count` from the bell. No realtime subscription yet.

### 3E. Credits & Monetization

#### Credit Types

Two-pool system managed on `meeting_credits (user_id, free_credits, premium_credits, balance)`:

- **Free credits:** Refill monthly per tier. Used first when an action has a cost.
- **Premium credits:** Purchased one-time. Used after free credits are exhausted. Unlock some premium-only actions (e.g., targeted_requests).

Deduction logic in `lib/credits.ts`:
```ts
deductCredits(free, premium, amount)
  → uses free first, then premium for remainder
  → returns { free_used, premium_used, total_used, remaining_free, remaining_premium }
```

#### When Credits Deduct

| Action | Cost | Pool |
|--------|------|------|
| Express Interest on a suggestion | 1 | free |
| Accept admin-curated intro (first or second acceptor) | 1 | free |
| Decline admin intro | 0 | — |
| Propose admin intro (admin side) | 0 | — |
| Send message in existing conversation | 0 | — |
| Receive an intro / be proposed | 0 | — |
| Schedule a meeting | (varies by feature state) | — |

**Insufficient credit handling:** API returns 403 with `{ error: 'Insufficient free credits', message: '...' }`. Client displays "Get credits" + "Upgrade" links.

#### Tiers

Tier determines batch size, credit refill, and scoring preference:

| Tier | Recs/Month | Notes |
|------|-----------|-------|
| free | 3 | Discovery-weighted ranking |
| professional | 5 | Slight top-candidate preference |
| executive | 8 | Strong top-candidate preference |
| founding | 5 | Same as professional; limited-time for early members |

Stripe subscription controls tier via `profiles.subscription_tier` + `subscription_status`. Changes flow through the webhook handler.

#### Founding Member Status

Founding membership is an **override flag** on the profile, not a paid tier. Two columns drive it:

- `profiles.is_founding_member` (boolean)
- `profiles.founding_member_expires_at` (timestamptz, nullable)

When `is_founding_member = true` and not expired, `lib/tier-override.ts` resolves the user's effective tier to `'founding'` regardless of `subscription_tier`. NULL `founding_member_expires_at` means lifetime (no expiration).

**What founding members get** (via the override + tier-aware code paths already in the system):

- 30 credits/month (vs 3 free / 15 pro)
- Higher daily credit cap (60)
- 5 active intro slots (same as professional)
- Auto-eligible for opportunities (per `lib/opportunities/eligibility.ts`)
- Tier-weighted scoring at 0.7 (similar to pro)
- Opportunity creation cap of 1 (matches pro)

**How status is granted:** SQL only. There is no Stripe price for founding, no signup-flow auto-grant, no admin UI button. Operator runs:

```sql
update profiles
set is_founding_member = true,
    founding_member_expires_at = null  -- lifetime; or set a date for time-limited
where email = 'someone@example.com';
```

**UI surfacing:** `/dashboard/billing` shows a gold "Founding Member" pill (via `components/ui/FoundingMemberBadge.tsx`) instead of the raw `subscription_tier` label, plus 5 benefit bullets and an optional "Founding access through [date]" line if the expiration is set. Non-founding users see no changes.

**Open gaps (intentionally deferred):**
- No notification before expiration — silent downgrade if expiration date passes
- No admin UI to grant/revoke (SQL-only)
- No founding badge on ReceiverCard or other surfaces (would require widening the data fetch upstream)
- Pricing page does not advertise founding tier

#### Stripe Integration

**Checkout:** `/api/billing/check-credit-purchase` and `/api/stripe/checkout` (confirm which is live) redirect to hosted Stripe Checkout.

**Portal:** `/api/stripe/portal` opens the customer portal for subscription management.

**Webhooks:** Two parallel webhook routes exist — `/api/webhooks/stripe` (178 lines, handles `customer.subscription.*` + `checkout.session.completed`) and `/api/stripe/webhook` (114 lines, handles `customer.subscription.*` + `invoice.payment_failed`). Only ONE of these is configured as the Stripe destination; the other is legacy. **Verification needed.** See backlog.

**Live vs test mode:** The Stripe keys are currently live-mode (`sk_live_...`). Historical `cus_*` customer IDs from test mode rotation were cleared from `profiles` for demo accounts on April 20. New checkouts auto-create fresh customers.

### 3F. Admin System

**Single admin:** `bizdev91@gmail.com`. Guarded via `const ADMIN_EMAIL = 'bizdev91@gmail.com'; if (user.email !== ADMIN_EMAIL) redirect('/dashboard')` in server components and via `requireAdmin()` helper in API routes.

#### Admin Dashboard — `/dashboard/admin`

Cards:
- **Members** — user management, boost priority, manual match (legacy)
- **Batches** — view all batches, approve/generate/delete. The Approve action is the core recurring monthly task.
- **Match Inspector** — pair inspection + 4 override actions
- **Waitlist** — review waitlist signups, send invites
- **Operations** — secondary page for support/debug tools (currently: Intro Requests)
- **Issue Reports** — clickable card with `status='new'` count badge, links to `/dashboard/admin/issues`
- **Opportunities** — read-only metrics card showing Created (7d) and Responses (7d). Plain `<div>` (not a `Link`) — no detail page or navigation. Counts via admin client to bypass RLS.

#### Match Inspector — `/dashboard/admin/match-inspector`

Admin enters two users (email or UUID). System returns:

- **Identity cards** — name, title, company, tier, onboarded state, UUID
- **Relationship state** — match id + status, conversation id (with "Open Conversation" link for admin), block status, intro request count
- **Eligibility checklist** — 6 checks: block, removal cooldown (180d), already matched, same user, profile completeness, pending intro requests
- **Primary failure reason summary** — picks the top blocker from priority order, shown in green "Eligible" or red "Not eligible" card
- **Recommended action** — computed server-side, highlighted with gold ring:
  - `unblock` if block exists
  - `restore` if match is removed
  - `createconv` if match exists but no conversation
  - `create` if eligible pair with no match (= "Propose Introduction")
- **Match insights** — human-readable reasons this pair might be a good match (purpose overlap, keyword overlap, seniority alignment, etc.) via `generateMatchInsights()`

Four override endpoints:
- `/api/admin/unblock` — removes block in both directions
- `/api/admin/restore-match` — clears removed state
- `/api/admin/admin-create-match` — proposes intro (current behavior: creates 2 admin_pending intro_requests; does NOT directly create match)
- `/api/admin/create-conversation-for-match` — backfills missing conversation on an active match

Email resolution includes a fallback: if `profiles.email` doesn't match the input, the inspector falls back to `auth.users.email` via `auth.admin.listUsers()`. Handles the case where profile and auth emails have drifted.

#### Batches Page — `/dashboard/admin/batches`

Lists all introduction_batches with suggestion + member counts. Buttons:
- **Generate new batch** → calls `/api/admin/generate-batch` (same endpoint as the cron)
- **Review** → opens `/dashboard/admin/batches/[batchId]/review` (see Batch Review below)
- **Approve & Go Live** → calls `/api/admin/approve-batch`, flips status + cooldowns (CRITICAL — see 3A)
- **Delete** → removes the batch (rarely used)

#### Batch Review — `/dashboard/admin/batches/[batchId]/review`

Per-recipient curate-before-approval flow. Admin sees every recipient's suggestions grouped together with name, role, company, score badge, and reason text. Three actions per row:

- **Drop** → marks `batch_suggestions.status = 'dropped'`, sets `dropped_at = now()`, also drops the reciprocal pair if it exists in the same batch (same pair, swapped recipient/suggested)
- **Restore** → flips `'dropped' → 'generated'`, clears `dropped_at`. Fully undoes a drop with no lingering cooldown (per design, restore is a real undo)
- **Generate replacements** (top-of-page action bar, only visible when at least one suggestion in the batch is dropped) → fills each recipient's gap up to their tier target, never forces a weak match

Replacements stay `status='generated'` until approval. They can be dropped again before going live. The existing `/api/admin/approve-batch` endpoint is unchanged — it still flips `'generated' → 'shown'`. Dropped rows stay `'dropped'` and never appear to users.

Replacement candidate eligibility (cooldowns enforced in `app/api/admin/batch/[batchId]/generate-replacements/route.ts`):

- Already in this batch (any status): excluded
- Shown to recipient in last 90 days: excluded
- Dropped from recipient in last 90 days: excluded (the new admin-drop cooldown)
- User-side `'hidden'` or `'hidden_permanent'`: excluded

Replacement-only `MIN_RELEVANCE_SCORE = 25` (vs main generator's 40). The replacement pool is naturally smaller after exclusions; lowering the threshold keeps slots fillable while still avoiding "weak match" output. Does NOT change the main recommendation threshold.

#### Other Admin Endpoints

- `/api/admin/simulate-matches` — pre-flight testing a single user's recommendations
- `/api/admin/force-generate-recommendations` — force-regenerate for one user
- `/api/admin/generate-recommendations-for-user` — same
- `/api/admin/set-priority` — toggle `is_priority` flag on a profile
- `/api/admin/waitlist/*` — approve / decline / send invite flows
- `/api/admin/send-invite` — direct invite a specific email
- `/api/admin/compute-scores` — recompute Network Value and Responsiveness scores
- `/api/admin/batch-suggestions/drop` — mark a single suggestion as dropped (Batch Review)
- `/api/admin/batch-suggestions/restore` — undo a drop (Batch Review)
- `/api/admin/batch/[batchId]/generate-replacements` — fill dropped slots in a batch (Batch Review)

All guarded by email check.

### 3G. Design System

The design system was built out in April 2026 as a pre-launch visual polish pass. Before this, the app used hardcoded hex values throughout with no shared primitives — every card, button, input, and badge was hand-rolled in Tailwind classes. The system now has tokens and six reusable primitives.

**Brand tokens** in `tailwind.config.ts`:

```
brand.navy        #1B2850
brand.navy-dark   #151f3d
brand.navy-light  #2E4080
brand.gold        #C4922A
brand.gold-soft   #FDF3E3
brand.cream       #F5F6FB
```

Use as `bg-brand-navy`, `text-brand-gold`, `border-brand-navy-dark`, etc. The unused `cadre` palette is still present in the config for backward compat but should not be referenced in new code.

**UI primitives** in `components/ui/`:

| Primitive | Variants | Use case |
|---|---|---|
| `Card.tsx` | default, premium (gold left accent), outlined | Standard containers. `rounded-2xl p-6` |
| `Button.tsx` | primary, secondary, ghost, danger × sm/md/lg | `rounded-xl`, gold focus ring, forwardRef |
| `Avatar.tsx` | sm (32px), md (48px), lg (64px), xl (96px) | Photo or deterministic HSL gradient fallback keyed to user ID. Replaced legacy flat-color initials. |
| `Pill.tsx` | default, gold, navy, success, info | Optional `dot` prop for a small leading indicator |
| `EmptyState.tsx` | single component | Icon + title + description + optional CTA slot |
| `Toggle.tsx` | single component | 44×24 pill switch with sliding thumb. Off = slate, on = navy. `role="switch"` |

**Component rules:**
- Cards are always `rounded-2xl`
- Buttons are always `rounded-xl`
- Page-level headings: `text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight` (mobile-responsive by default)
- Section headings: `text-base font-semibold text-slate-900`
- Typography is Inter only — no serif
- Avatars with no photo MUST use the gradient fallback. Flat color blocks are deprecated.

**Responsive rules:**
- All surfaces tested at 375px mobile, 768px tablet, 1280px desktop
- Cards `p-6` on mobile, larger paddings only via `sm:p-8` or `lg:p-8` opt-in
- Container padding is `px-4 sm:px-6` — 16px on mobile, 24px sm+
- Side-by-side layouts stack on mobile with `flex flex-col sm:flex-row` pattern
- Primary buttons go full-width on mobile via `w-full sm:w-auto`

**Surfaces migrated to the primitives** (as of April 24, 2026):
- Landing page (`/`)
- Login (`/login`)
- Onboarding (`/dashboard/onboarding`)
- Introductions (`/dashboard/introductions`)
- Opportunities + ReceiverCard (`/dashboard/opportunities`)
- Settings + OpportunityPreferences (`/dashboard/settings`)
- Messages list (`/dashboard/messages`)
- Notification bell (`components/NotificationBell.tsx`)

**Surfaces NOT yet migrated:** Admin pages, Billing, Meetings, Network, Messages conversation detail, Profile edit. These still use pre-polish patterns. Safe to migrate incrementally.

### 3H. Issue Reports (User Feedback Loop)

**Status:** Shipped April 25–26, 2026 (commits `5e5d5b0` schema + API + UI, `72f82a3` admin dashboard count card).

**What it does.** Users can submit bug reports or support questions from inside the app. Reports save to the database and appear in the admin dashboard. No email is sent; the entire loop lives in-product.

**Why it exists.** The previous "Email Support" link opened a `mailto:` to `support@andrel.app`, putting the burden on the user to switch contexts and the operator to manually triage email. The in-app version captures the report alongside metadata (page URL, user agent) and surfaces an unread count to the admin so nothing slips.

#### Data flow

1. User clicks "Report an issue" or "Message support" from `/dashboard/settings`
2. Modal opens with a textarea; user types and submits
3. `POST /api/issues/report` validates auth, trims/validates text, and inserts to `issue_reports` via admin client (RLS allows the insert too, but admin client matches existing patterns)
4. Modal shows success state, auto-closes after 2.5s
5. Admin sees the count on `/dashboard/admin` (gold "N new" badge on Issue Reports card)
6. Admin clicks through to `/dashboard/admin/issues` for the full list
7. Admin updates `status` via SQL (`new → in_progress → resolved | wontfix`)

#### Two variants, one component

`components/ReportIssueButton.tsx` accepts a `variant` prop (`'report' | 'support'`). Each variant has its own copy via the internal `COPY` object:

- `'report'`: AlertCircle icon, "Report an issue" trigger, "What happened?" placeholder, "Submit report" button, generic bug-reporting language
- `'support'`: MessageSquare icon, "Message support" trigger, "How can we help?" placeholder, "Send message" button, support/help language

Both submit to the same endpoint and land in the same `issue_reports` table. There is no `kind` column distinguishing them — admin reads the report text to determine intent. If filtering becomes useful later, add a `kind` column.

#### Status workflow

`issue_reports.status` is text with a CHECK constraint allowing 4 values:
- `new` (default — gold pill, counted in admin badge)
- `in_progress` (navy pill — admin actively working)
- `resolved` (success/green pill — issue addressed)
- `wontfix` (default/slate pill — declined, by design, etc.)

V1 has no status mutation UI. Admin runs SQL to change status:

```sql
update issue_reports
set status = 'in_progress'
where id = '<uuid>';
```

The dashboard count badge filters on `status = 'new'`, so changing status to anything else clears it from the badge. Viewing the issues page does NOT auto-mark anything — `new` is a workflow state, not a notification state.

#### page_url is captured but not displayed

The form captures `window.location.href` at submission time and stores it in `issue_reports.page_url`. Admin display intentionally does NOT show it because the entry point is in `/dashboard/settings` — every report's page URL is `/dashboard/settings`, providing zero useful debugging context.

The column is preserved (no schema change) for two reasons:
1. If we later add a global "Report issue" button reachable from any page, the URL becomes meaningful
2. Engineering can query the data directly if needed (`select page_url, user_agent, ... from issue_reports`)

#### Code layout

```
app/api/issues/report/route.ts             # POST endpoint, ~63 lines
app/dashboard/admin/issues/page.tsx        # Admin list view, ~90 lines
components/ReportIssueButton.tsx           # Modal + form, ~140 lines
app/dashboard/settings/page.tsx            # Settings integration (Help & Support card)
app/dashboard/admin/page.tsx               # Issue Reports count card
```

#### RLS policies

- `users_insert_own_report` — INSERT — `with_check = (auth.uid() = user_id)`
- `users_read_own_report` — SELECT — `using = (auth.uid() = user_id)`

Admin reads via `createAdminClient()` which bypasses RLS. There's no admin SELECT policy — by design, admin reading is server-side only via the admin viewer page.

#### Out of scope for V1

- Reply / conversation between admin and reporter (deferred — likely Option D using existing messages infrastructure)
- Status mutation buttons in admin UI (SQL-only for V1)
- File attachments / screenshots
- Threading or comments
- Priorities, labels, or assignment
- Spam / rate limiting (any logged-in user can submit)
- In-app notification to admin bell when new report arrives (relies on dashboard count card)

---

## 4. Opportunities Engine

**Status:** Shipped April 2026 (commit `090d16a`). Currently in launch-phase-free mode — all responses are comped (0 credits), logged with note `'launch_phase'`.

The Opportunities Engine is a second product surface alongside Introductions. Where Introductions are curated person-to-person matches, Opportunities are private signals a member sends to their matched network about hiring or business needs. The system routes these signals to the right candidates/providers based on profile fit, preferences, and rate-limiting rules.

### Core Model

An **opportunity** is a signal created by one user (the "creator") that describes either:

- A **hiring need** — an open role the creator is trying to fill through the network
- A **business need** — a specific problem the creator needs help with (specialist, advisor, service provider)

Opportunities flow to matched users who have opted in via their preferences in `/dashboard/settings` → Opportunities:

- **"Open to new roles"** → eligible to receive hiring opportunities
- **"Open to business opportunities"** → eligible to receive business-need opportunities
- **"I'm a recruiter"** → can receive hiring opportunities to match candidates to

These preferences are NEVER shown to other members. The UI surfaces this explicitly with a lock icon and reassurance copy.

### Mutual-Interest-Only Connection Model

Critical to Andrel's product identity: there are no "pending requests" to accept from the receiving user's perspective. The flow is:

1. User A creates an opportunity → it's routed to eligible candidates in their network
2. User B sees the opportunity in their "For you" section on `/dashboard/opportunities` and clicks "Open to this" / "I can help" / "I can take this" (button label varies by role)
3. User A does NOT see User B's interest yet — it's silent
4. If User A independently expresses interest in User B (e.g., through the signals detail page or via the introductions system), mutual interest is auto-detected
5. System creates a match, charges the initiator one credit, both users see each other in `/dashboard/network` with a gold highlight and "New" badge

No LinkedIn-style pending requests. No incoming-request notifications. The platform feels curated and mystery-preserving.

### Code Layout

```
lib/opportunities/
├── caps.ts              — tier-based opportunity creation caps
├── connect.ts           — mutual-interest detection + match creation
├── matching.ts          — fit scoring (seniority, expertise, location, tier boost)
├── rateLimits.ts        — supply control (Prompt #15)
├── unreadCount.ts       — sidebar badge logic
└── [other helpers]

app/api/opportunities/
├── respond/             — POST when a user expresses interest in an opportunity
├── dismiss/             — POST when a user dismisses an opportunity
├── [id]/                — opportunity detail endpoints
└── [other endpoints]

app/dashboard/opportunities/
├── page.tsx             — "For you" surface + activity destination cards
├── new/                 — creation forms (hiring + business)
├── signals/[id]/        — creator's view of their own opportunity (responders list)
├── responded/[id]/      — responder's detail view of an opportunity
└── responses/           — list of opportunities the user has responded to

components/opportunities/
├── ReceiverCard.tsx     — the curated opportunity card shown in For-you
├── OpportunityPreferences.tsx — Settings toggle row component
└── [other components]
```

### Preferences Wiring

`/api/profile/opportunity-preferences` (POST / PATCH) handles preference updates with a strict allowlist: `open_to_roles`, `open_to_business_solutions`, `recruiter`. Fires when a user flips a toggle in `/dashboard/settings`. Never exposes preferences to other members.

### Scoring & Supply Control

Matching uses `isCompatiblePair()` to block geographic/format-incompatible pairs, then `scoreMatch()` which weights seniority and tier heavily. A `tierBoost(c)` helper adds `SCORING_TIER_BOOST = { free: 0, professional: 5, executive: 10 }` to the score.

`MAX_ACTIVE_IN_FOR_YOU_BY_TIER = { free: 2, professional: 5, executive: 5 }` caps how many active opportunities a user sees in their For-you feed at once. Validated end-to-end: free-tier users deliver 2 opportunities, then are blocked on the 3rd.

Prompt #15 shipped supply control + ranking discipline: thresholds 40/50/55, near-threshold fallback, 5 rate limit gates, tranched delivery (2+2 at 48h intervals), soft nudge, retry logic for API failures.

### Launch Phase

Currently in launch-phase-free mode. Every response is logged with `note = 'launch_phase'` and credits charged = 0. This is a temporary switch to let early users exercise the system without monetization friction. The cron `opportunities-maintain` still needs to be added to `vercel.json` — currently tracked in backlog.

### Admin Dashboard Integration

The admin dashboard has an Opportunities section with three pages:
- **Intro Requests** — existing intro tracking (not opportunity-specific)
- **Waitlist** — waitlist management
- **Batch Management** — monthly batch approval (same as 3A)

Opportunity-specific admin tooling has not yet been built; opportunity state is inspected directly in Supabase.

### Navigation

Sidebar and MobileNav (`Sidebar.tsx`, `MobileNav.tsx`) both include an Opportunities link with a Sparkles icon. On mobile, it appears in the More menu to preserve the primary nav for Introductions/Messages/Network.

### Sensitive Schema Details (Do Not Drift)

- `profiles.expertise` is a TEXT column with THREE coexisting storage formats: real arrays, Postgres array literals (`'{Legal,"M&A"}'`), and JSON-stringified arrays (`'["Legal","M&A"]'`, what new signups via `OnboardingForm` write). Always read via the shared `parseExpertise` helper at `lib/parseExpertise.ts`. Canonical user-selectable values are defined in `lib/profile-options.ts` as `EXPERTISE_OPTIONS` (33 tags).
- `profiles.role_type` is free text with drift — canonical values: `'In-house Counsel'`, `'Law firm attorney'`, `'Consultant'`, `'Compliance'`, `'Legal Operations'`
- PostgREST requires double quotes around camelCase columns — `"networkValueScore"`, `"responsivenessScore"` — in `.select()`
- `trust_score` is a placeholder — every row is 50. Not yet computed from real signals.

---

## 5. Data Model (High-Level)

This section explains table roles and relationships, not full SQL.

### `profiles`

One row per user (FK to `auth.users` via `id`). Core fields:
- Identity: `full_name`, `email`, `avatar_url`, `title`, `company`, `bio`, `linkedin_url`
- Role / context: `role_type`, `seniority`, `expertise` (TEXT — see traps), `purposes` (text[]), `intro_preferences` (text[]), `interests` (text[]), `city`, `state`, `location`
- Preferences: `open_to_mentorship`, `open_to_business_solutions`, `meeting_format_preference`, `geographic_scope`
- Lifecycle: `onboarding_step`, `onboarding_complete`, `profile_complete`, `password_reset_required`, `welcome_sent_at`
- Scoring: `networkValueScore`, `responsivenessScore`, `trust_score`, `boost_score`, `is_priority`
- Admin/status: `admin_priority`, `is_admin`, `is_active`, `is_approved`, `is_founding_member`, `founding_member_expires_at`, `account_status`, `verification_status`
- Billing: `stripe_customer_id`, `stripe_subscription_id`, `subscription_status`, `subscription_tier`, `current_period_end`

**Note:** Column is `onboarding_complete` (NOT `onboarding_completed`). Multiple references elsewhere in the codebase have gotten this wrong and produced silent-failure bugs.

### `matches`

One row per active or historical connection. Bidirectional — `user_a_id` and `user_b_id` are interchangeable (no "sender" meaning). Key fields:
- `user_a_id`, `user_b_id` (both FK to profiles.id)
- `status`: `active` | `accepted` | `removed`
- `matched_at`, `accepted_at`, `removed_at`, `removed_by`, `expires_at`, `created_at`
- `admin_facilitated` (boolean): true if created via admin intro flow
- `admin_notes` (text): `manual_create`, `manual_create_from_removed`, `manual_restore`, or null
- `suggestion_id` (FK): links to originating batch_suggestion if batch-created

### `intro_requests`

The unified table for all intros — batch suggestions, user-initiated, admin-proposed. Key fields:
- `requester_id`, `target_user_id`
- `status`: free text; common values `suggested`, `pending`, `approved`, `accepted`, `admin_pending`, `declined`, `passed`, `hidden`, `archived`
- `match_reason`: humanized explanation from the generator
- `note`: user-provided note (rare)
- `is_admin_initiated` (boolean): true for admin-proposed
- `admin_notes` (text): `manual_create` for admin intros
- `batch_id`: FK to introduction_batches if batch-originated
- `credit_charged`, `credit_hold`: flags for billing state
- `match_score`, `reviewed_by`, `reviewed_at`: scoring/admin metadata
- `created_at`, `updated_at`

**Admin intros have two reciprocal rows** (one per direction, both with `is_admin_initiated = true` and same `admin_notes`). User-initiated Express Interest creates one row; a reverse row is the other user's separate express-interest.

### `conversations`

One row per match once a conversation exists. Key fields:
- `match_id` (FK to matches)
- `suggested_prompts` (jsonb): array of icebreaker strings
- Timestamps

### `messages`

Messages in conversations. Key fields:
- `conversation_id` (FK)
- `sender_id` (FK to profiles, NULL for system messages)
- `is_system` (boolean)
- `content` (text)
- `read_at` (timestamp, NULL = unread)
- `created_at`

### `notifications`

Notification inbox. Key fields:
- `user_id` (FK)
- `type` (text, free text — no CHECK constraint)
- `title`, `body` (both required)
- `link` (text, optional): route to open on click
- `data` (jsonb, optional): extra context
- `read_at` (timestamp, NULL = unread)

### `blocked_users`

- `user_id`, `blocked_user_id` (both FK to profiles)
- UNIQUE constraint on pair, CHECK `user_id != blocked_user_id`

### `introduction_batches`

One row per monthly batch. Fields: `status`, `batch_number`, `created_at`. Status flows: generated → active → completed.

### `batch_suggestions`

One row per (user, suggested_person, batch). Links a person to a batch from a user's perspective. Status: `generated` (hidden), `shown` (approved), `passed`, `hidden_permanent`, `dropped` (admin removed during Batch Review). Includes `dropped_at` (timestamptz, nullable) used to enforce the 90-day admin-drop cooldown when the Batch Review replacement flow searches for new candidates. Partial index `(recipient_id, suggested_id, dropped_at) where status='dropped'` speeds up that lookup. The `status` column has no CHECK constraint so new values can be added freely.

### `meeting_credits`

- `user_id` (FK)
- `free_credits`, `premium_credits`
- `balance` (derived total)

### Other Tables (brief)

- `meetings`: scheduled meeting records
- `credit_transactions`: audit trail of credit changes
- `trust_signals`: scoring events (profile_complete, message_sent, meeting_completed, etc.)
- `user_scores`: computed scoring metadata
- `user_preferences`: any preference storage
- `waitlist`: pre-approved signup queue
- `targeted_requests`: premium feature — user-specified requests for next batch
- `admin_flags`: admin toggles
- `suggestion_responses`: tracking user responses to suggestions
- `intro_candidates`: candidate staging (legacy?)

### Opportunities Tables

**`opportunities`** — one row per created opportunity. Key fields:
- `id`, `creator_id` (FK to profiles), `type` (`hiring` | `business`), `title`, `description`
- `urgency` (`low` | `medium` | `urgent` | null)
- `status` (`active`, `archived`, etc.)
- `expires_at`, `archived_at`, `created_at`

**`opportunity_candidates`** — one row per (user, opportunity) showing which users the system has surfaced an opportunity to. Key fields:
- `user_id`, `opportunity_id`, `role` (`candidate` | `provider` | `recruiter`)
- `shown_at`, `viewed_at`, `dismissed_at`
- Scoring/fit metadata

**`opportunity_responses`** — one row per user expressing interest in an opportunity. Used for mutual-interest detection and "Your responses" listing.
- `user_id`, `opportunity_id`, `responded_at`
- Response log fields (e.g., `note` = `'launch_phase'` during launch-phase-free)

Related helpers: `lib/opportunities/caps.ts` defines `TIER_OPPORTUNITY_LIMIT`, `MAX_ACTIVE_IN_FOR_YOU_BY_TIER`, and `SCORING_TIER_BOOST`.

### `issue_reports`

In-app user feedback. One row per submitted report or support message. Schema:

```sql
create table public.issue_reports (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  user_email  text not null,
  report_text text not null,
  page_url    text,
  user_agent  text,
  status      text not null default 'new'
              check (status in ('new', 'in_progress', 'resolved', 'wontfix')),
  created_at  timestamptz not null default now()
);

create index idx_issue_reports_status_created
  on public.issue_reports (status, created_at desc);
```

RLS:
- `users_insert_own_report` — INSERT — `with_check = (auth.uid() = user_id)`
- `users_read_own_report` — SELECT — `using = (auth.uid() = user_id)`

Admin reads via `createAdminClient()` to bypass RLS. There is no admin policy. `user_id` cascades on auth user deletion.

`page_url` and `user_agent` are captured but not currently displayed in the admin viewer (entry point is always `/dashboard/settings` so the URL is meaningless context). Both columns kept for future use.

`status` workflow: `new` (default) → `in_progress` → `resolved` | `wontfix`. Updated via SQL only in V1; no admin mutation UI yet.

---

## 6. User Flows (Step-by-Step)

### New User Onboarding

1. User signs up (email/password via Supabase Auth) OR is invited via admin-sent email.
2. Lands on `/onboarding` which redirects to `/dashboard/onboarding` (the real flow).
3. **Step 1: Build Your Profile** (`OnboardingStep1.tsx`) — fields:
   - Full name, title, company, bio
   - Seniority (Junior, Mid-Level, Senior, Executive, C-Suite)
   - Role type (In-house, Law Firm, Consultant, etc.)
   - Expertise (comma-separated list)
   - LinkedIn URL (optional)
4. Step 1 submission sets `onboarding_step = 2`.
5. **Step 2: Set Your Preferences** (`OnboardingStep2.tsx`) — fields:
   - Purposes (multi-select: Find customers, Raise capital, Hire talent, Learn & grow, Expand network, Give back / mentor, Explore opportunities)
   - Personal interests (multi-select: Sports, Travel, Food & wine, Arts & culture, Technology, Fitness, Reading, Music, Volunteering)
   - Intro preferences (role types they want to meet)
6. Step 2 submission sets `profile_complete = true` and `onboarding_complete = true`.
7. First batch is generated via `/api/onboarding/generate-recommendations`.
8. User is redirected to `/dashboard/introductions`.

### Receiving a Batch

1. On the 1st of the month, monthly-batch cron generates batches for all active users.
2. Batches sit in `introduction_batches` with status pending.
3. **Admin must click Approve** in `/dashboard/admin/batches` — this flips status to active, sets `batch_suggestions.status = 'shown'`.
4. Next run of `weekly-refresh` cron (Monday 9 AM) sends `new_batch` notifications.
5. User opens `/dashboard/introductions` and sees their 3–8 curated intros.

### Expressing Interest

1. User clicks "Express interest" on a suggested intro card.
2. 1 free credit is deducted.
3. `intro_request.status` goes `suggested → approved`.
4. If the other user has ALSO already expressed interest: match is created, conversation is created, both users get `mutual_match` notification and can message.
5. If not: other user receives `interest_received` notification with routing to their introductions page.

### Admin Proposal (Propose Introduction)

1. Admin opens `/dashboard/admin/match-inspector`.
2. Enters two user emails. Checks eligibility.
3. Clicks **Propose Introduction**. Confirms.
4. Two `intro_requests` rows are created (`admin_pending`, reciprocal, `is_admin_initiated = true`).
5. Both users receive `admin_intro` notification.
6. Users see "Introduced by Andrel" card on their Introductions page with Accept + Pass buttons.

### Accepting an Admin Intro

1. User A clicks **Accept**. 1 free credit deducted. Their row: `admin_pending → approved`.
2. Card updates to "Waiting on [UserB]." State persists on reload (driven by DB).
3. User B receives `admin_intro_nudge` notification.
4. User B clicks **Accept**. 1 free credit deducted. Their row: `admin_pending → approved`.
5. Mutual-match creation fires: `matches` row (active, admin_facilitated), conversation, icebreakers, system message, both users get `mutual_match` notification.
6. User B (the second acceptor) redirects to `/dashboard/network`.

### Declining an Admin Intro

1. Either user clicks **Pass** on the admin intro card.
2. Both `intro_requests` rows for the pair are updated to `declined`.
3. No notification to the other user — silent.
4. Neither user sees the admin intro card anymore.

### Messaging

1. User opens `/dashboard/messages`.
2. Sees list of conversations (Network-connected pairs).
3. Opens a conversation — icebreakers render if no user messages exist yet.
4. Clicks an icebreaker OR types → `/api/messages/send` inserts a message.
5. Other user receives `message_received` notification (polling or on-page-view).

### Creating an Opportunity

1. User on Professional or Executive tier navigates to `/dashboard/opportunities` and clicks "Signal a need".
2. Chooses type: hiring or business.
3. Fills out the form (title, description, urgency, other type-specific fields).
4. Submits → row inserted into `opportunities` with `status = 'active'`.
5. Backend scoring runs, generating `opportunity_candidates` rows for eligible matched users based on preferences + fit.
6. Eligible users begin seeing the opportunity in their "For you" section (subject to `MAX_ACTIVE_IN_FOR_YOU_BY_TIER` cap).

### Responding to an Opportunity

1. User sees opportunity in For-you section of `/dashboard/opportunities`.
2. Clicks role-appropriate button — "Open to this" (candidate), "I can help" (provider), "I can take this" (recruiter).
3. `POST /api/opportunities/respond` with `opportunity_id` → row inserted into `opportunity_responses`.
4. During launch-phase-free: 0 credits charged, logged as `opportunity_interested_comped` with note `'launch_phase'`.
5. The opportunity's creator does NOT get notified yet — silent per the mutual-interest model.
6. If the creator subsequently expresses interest in this responder (through Introductions or another path), mutual-interest is detected and a match is created.

### Dismissing an Opportunity

1. User clicks "Not for me" on an opportunity card.
2. `POST /api/opportunities/dismiss` → row in `opportunity_candidates` is updated with `dismissed_at = now()`.
3. Opportunity is removed from the user's For-you section.
4. Does not send any notification to the creator.

### Managing Opportunity Preferences

1. User navigates to `/dashboard/settings`.
2. Opportunities card contains three toggles — roles, business, recruiter.
3. Flipping a toggle fires `POST /api/profile/opportunity-preferences` with the single key being updated.
4. "Saved" pill appears briefly in the UI.
5. Preferences are NEVER shown to other members. The UI surfaces this explicitly.

### Reporting an Issue / Messaging Support

1. User navigates to `/dashboard/settings` → "Help & Support" card.
2. Card has 3 entries: Message support, FAQ, Report an issue.
3. Either Message support or Report an issue opens the same modal with variant-specific copy.
4. User types into textarea — Submit button activates when text is non-empty.
5. Submit fires `POST /api/issues/report` with `report_text`, `page_url`, `user_agent`.
6. Endpoint validates auth, trims and validates text length, inserts via admin client.
7. Modal switches to success state ("Thanks — we received your message" / "...your report").
8. Modal auto-closes after 2.5s.
9. Report appears in `/dashboard/admin/issues` for admin to review.

### Admin Reviewing Issue Reports

1. Admin (bizdev) lands on `/dashboard/admin` and sees Issue Reports card.
2. Gold "N new" badge appears in the card's top-right when `status = 'new'` reports exist.
3. Admin clicks card → `/dashboard/admin/issues` lists reports newest first.
4. Each report shows email, timestamp, status pill, and report text.
5. Admin updates status via SQL when triaging:

   ```sql
   update issue_reports
   set status = 'in_progress'
   where id = '<uuid>';
   ```

6. Badge clears once all `new` reports have been moved to other statuses.

---

## 7. Guardrails

**These must NEVER be built.** If a future prompt or AI suggests any of them, push back and document the objection.

- **No feeds.** No infinite scroll of posts, activity, or users. The closest thing to a feed allowed is the 3–8 monthly intros (bounded, curated).
- **No public browsing of members.** No search box over profiles. No "discover people" page. Profiles become visible only through curated intros or existing connections.
- **No open messaging.** A user cannot message someone they aren't connected to. No cold DMs.
- **No spam loops.** No "invite your friends to get rewards." No bulk email to user's contacts.
- **No marketplaces.** No "hire a consultant" listing page. No open bidding on intros.
- **No public presence indicators.** No "online now" dots, no "last seen."
- **No like / endorsement features.** Network graph bloats without corresponding signal.
- **No content posting.** No blogs, no "thoughts," no status updates. If a member has something to say, they say it in DM.
- **No public leaderboards.** No "top connectors this month" rankings.

These guardrails exist because every one of them, however small, pulls Andrel toward being LinkedIn or a social app. Andrel's differentiation is that it isn't. Breaking guardrails to hit short-term engagement metrics is a product-killing trade.

---

## 8. UX & Tone Guidelines

### Voice

- **Short.** If it fits in 6 words, use 6 words. "We think you should meet." not "We'd like to introduce you to someone we think you would benefit from knowing."
- **Confident.** No hedging. "You're connected." not "You have successfully completed the introduction process."
- **Neutral.** No hype language ("Amazing!", "Awesome!"), no excessive emoji, no casual chat tone.
- **Premium.** Typography does heavy lifting (see design system). Copy is spare on purpose.
- **Not transactional.** Never remind users how many credits they used. Never show friction unnecessarily.

### Color System

All brand colors are defined as Tailwind tokens in `tailwind.config.ts`. Reference them via token names, not hex:

- **`brand-navy`** (`#1B2850`) — core buttons, headlines, primary identity
- **`brand-navy-dark`** (`#151f3d`) — hover state for navy surfaces
- **`brand-navy-light`** (`#2E4080`) — gradient companion to navy (login left panel, hero sections)
- **`brand-gold`** (`#C4922A`) — curation signals, premium treatment, notification bell badge, "Selected for you" pills
- **`brand-gold-soft`** (`#FDF3E3`) — soft background for curated sections, unread notification rows
- **`brand-cream`** (`#F5F6FB`) — onboarding background, navy-themed pills, match insights panels
- **Red** — reserved for "waiting on you" urgency: unread messages, pending meeting requests. Do NOT use red for notification bell badge; use gold.
- **Slate scale** (Tailwind slate-50 through slate-900) — body text, borders, subdued UI

Do not hardcode `#1B2850`, `#C4922A`, etc. in new code. If you find remaining hardcoded hex in older surfaces, migrate as you touch the file.

### Component Principles

- Cards feel heavy when they matter (Admin intros: gold border, larger padding). Lighter when they don't.
- Accept buttons dominate; Pass/Decline stays available but secondary.
- Use skeleton states for load, never long spinners.
- Confirmation panels are inline (amber-tint), not modal, for admin actions.
- 2-line bio clamp in cards. Over-expansion hurts the scan experience.
- Badge counts cap at "9+". Precise numbers above that become noise.

### Interaction Principles

- Every destructive action requires confirmation, shown inline.
- Undo is rare — lean on "are you sure?" instead of an undo toast.
- Click-through on notifications marks read immediately. Don't force a second tap.
- Waiting states persist via DB, not React state. User reloads and the state is still there.

---

## 9. Operational Details

### Environments

- **Development (local):** `npm run dev` starts Next.js on port 3000 (legacy was 5000; changed April 22 because macOS Control Center hogs 5000). Local Supabase points at the production Supabase project directly (no staging DB). Stripe keys are live — be careful.
- **Production:** Vercel auto-deploys from the main branch. URL: `andrel.app`.

### Deployment

- Git push to main → Vercel builds and deploys.
- `vercel.json` configures cron schedules.
- Supabase migrations are applied manually via the Supabase dashboard SQL editor — there is no migration CLI in use. Any schema changes should be logged in a dated `docs/migrations/` file for future reference (proposed — not yet enforced).

### Environment Variables

Required (placeholders):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `ADMIN_USER_EMAIL` (optional override; defaults to `bizdev91@gmail.com`)

### Cron Jobs (via vercel.json)

| Path | Schedule | Purpose |
|------|----------|---------|
| `/api/cron/monthly-batch` | `0 9 1 * *` | Generate new batch for all users on the 1st |
| `/api/cron/weekly-refresh` | `0 9 * * 1` | Send new_batch notifications, refresh |
| `/api/cron/daily-refill` | `0 12 * * *` | Refill free credits for subscribed users |
| `/api/cron/cleanup-expired-requests` | (check file) | Archive stale intro_requests |
| `/api/cron/nudge-reply` | (check file) | Send nudge_reply notifications |
| `/api/cron/opportunities-maintain` | NOT YET WIRED | Opportunity nudges, retries, archival. Code ready; needs `vercel.json` entry. |

### Admin Workflow (Monthly)

1. **On or shortly after the 1st:** check `/dashboard/admin/batches` to see that the new batch generated. If not, run Generate manually.
2. **Review the batch:** spot-check a handful of suggestions via the "Review suggestions" UI.
3. **Approve the batch:** flips it active. Users will receive their notifications on the next Monday 9 AM.
4. **Throughout the month:** use Match Inspector to propose ad-hoc introductions for members who need specific connections. Handle any support issues (block/unblock, restore removed matches).
5. **Check Operations periodically:** review intro_requests page for any pending support cases.

### Test Accounts (Placeholder Format)

Do NOT commit real credentials. Use:

```
test1@andrel.app / cadre-demo-2026
test2@andrel.app / cadre-demo-2026
admin@andrel.app / (admin-managed)
```

Current demo accounts for local testing (password `cadre-demo-2026`):
- `alexandra@horizoncapital.com`
- `sarah.mitchell@skadden.com`
- `james.okonkwo@apexgroup.com`
- `priya.rajan@google.com`
- `elena.vasquez@meridianhealth.com` (note: `profiles.email` drifts to `daniel@counselhouse.org` for this user)
- `emily.carter@legalleaders.com`
- `sarah.whitman@whitmanlegal.com`

---

## 10. Known Issues / Backlog

### Infrastructure

- **Two parallel Stripe webhook routes exist.** `/api/webhooks/stripe` (178 lines) and `/api/stripe/webhook` (114 lines). Only one is configured in the Stripe Dashboard. Identify which, delete the other, document.
- **Two parallel onboarding entry points.** `/onboarding` (thin shell → OnboardingForm) and `/dashboard/onboarding` (2-step flow with OnboardingStep1/2). The latter is canonical. The former is a redirect remnant. Consolidate.
- **`OnboardingStep1.tsx.backup`** exists alongside the live version. Remove.
- **Cron name vs schedule mismatch (historical).** Renamed `weekly-batch` → `monthly-batch` on April 22. The new name matches the `0 9 1 * *` schedule.
- **`opportunities-maintain` cron not yet in `vercel.json`.** The Opportunities Engine needs a maintenance cron for soft nudges, retries, and archival. Ship before full credit pricing turns on.
- **Notification check constraint was removed.** The `notifications_type_check` constraint was silently rejecting every non-whitelisted type. Dropped on April 22. Keep type as free text going forward — schema debt.
- **`trust_signals` writes silently failed.** Fixed by switching to `createAdminClient()` and tightening RLS on April 22. Monitor for similar silent-RLS failures in other backend-write tables.
- **`next.config.js: typescript.ignoreBuildErrors = true`** is a pragmatic Vercel unblock from April 23 during a rush of TS strict errors (Map.entries() → Array.from(), seen_by_creator_at in select, opp type narrow). Dev mode still type-checks. Pay down the debt and flip back to false before the next major feature.
- **Zombie code in `/api/messages/conversations/route.ts`.** A small loop (~3 lines) iterates `validEnriched` reading `match_id` but doesn't use it. Harmless dead code. Clean up opportunistically.

### Product

- **Profile email can drift from auth email** (Elena's case: auth email is meridianhealth but `profiles.email` is counselhouse). Admin tools have a fallback via `auth.admin.listUsers()`. Proper fix: sync trigger or consolidate source of truth.
- **Admin-created matches don't notify users in real time.** After a match is created (mutual accept), users get `mutual_match` notifications, but there's no push/email. Polling-only. Acceptable short-term.
- **Stale polling on deleted conversations.** Some browser tabs continue polling `/api/messages/list?conversationId=<deleted-id>` every 400ms returning 404. ConversationView should stop polling on 404 instead of retrying forever.
- **Meetings page over-renders.** Logs show the same data query running 4+ times per page load. Worth diagnosing.
- **Admin-intro decline has no audit trail beyond timestamps.** If a dispute arises ("I didn't decline that intro"), there's no `declined_by_user_id` field. Add if needed.
- **"Accepted, waiting" state is indefinite.** If the second user never responds, first user's card sits there forever. Consider auto-decline after N days.
- **No undo for network Remove / Block.** Once a user removes or blocks a match, there's no in-UI undo. Admin can restore manually via Match Inspector. Worth product-side consideration.
- **Admin account test pollution.** The `bizdev91@gmail.com` account collected 30 `status = 'removed'` matches from testing the Remove flow. Restored April 24 via direct SQL update. Future testing should use a dedicated test account, not the admin account, to avoid polluting production-admin data.

### Resolved (April 23–28, 2026)

- **Messages page header said "Introductions".** Hardcoded wrong copy on `/dashboard/messages`. Also used `font-serif` (we don't use serif) and `text-gray-*` scale (everywhere else uses slate). Fixed in commit `85a1c1c`.
- **Notification bell dropdown clipped on mobile.** Panel was positioned `left-0` below the bell, pushing it off the right edge of narrow viewports. Fixed by switching to `right-0` with `w-80 sm:w-96` and a `max-w-[calc(100vw-1rem)]` insurance cap. Commit `39669a5`.
- **Sidebar unread-message badge never decremented after reading.** `ConversationView` never wrote `read_at` anywhere — messages accumulated unread forever. Fixed by adding `POST /api/messages/read` + `router.refresh()` on conversation mount. Commit `6a80780`.
- **Avatar fallback used flat color blocks keyed by ID hash to 8 hardcoded bg classes.** Replaced with deterministic HSL gradient in new `components/ui/Avatar.tsx`. Used across Introductions, Opportunities, and anywhere the old `Avatar` component was called.
- **`hidden_permanent` exclusion not honored by recommendation generator.** UI's "Don't show again" set status to `hidden_permanent`, but `lib/generate-recommendations.ts` filter only checked `['hidden', 'passed']` (lines 857, 862). Permanently dismissed users could resurface in future batches. Fixed in commit `b117f6e` to filter `['hidden', 'hidden_permanent', 'passed']` and recognize both as permanent.
- **`new_batch` notifications never fired on approval.** `/api/admin/approve-batch` flipped `batch_suggestions.status = 'shown'` but a misleading comment claimed notifications were "handled by weekly-refresh cron job" — neither location actually fired them. Users had no signal a new batch was approved. Fixed in `b117f6e` by querying distinct `recipient_id` from approved batch and firing `createNotificationSafe({ type: 'new_batch' })` per user.
- **Notification panel positioned wrong on desktop.** Earlier mobile fix (`right-0`) pushed the panel off the LEFT edge of the desktop sidebar (where the bell sits on the left side). Fixed in commit `919e4c2` with responsive classes `right-0 md:left-0 md:right-auto` so panel opens leftward from a right-side mobile bell and rightward from a left-side desktop bell.
- **Email Support row in Settings opened mailto.** Replaced with `<ReportIssueButton variant="support" />` so general questions also save to `issue_reports` instead of dispatching email. Both Message support and Report an issue flow through the same in-app system as of commit `5e5d5b0`.
- **Issue Reports feature shipped end-to-end.** New `issue_reports` table + RLS policies, `POST /api/issues/report` endpoint, `ReportIssueButton` component with two variants, admin viewer at `/dashboard/admin/issues` with status pills, and dashboard count card on `/dashboard/admin`. Five commits across April 25–26: schema migration (run-once SQL), `5e5d5b0` (API + component + Settings + admin viewer), `a8dd3ea` (cleanup), `72f82a3` (dashboard count card).
- **Batch Review feature shipped (April 27).** Per-recipient grouped review page at `/dashboard/admin/batches/[batchId]/review` with Drop / Restore actions and Generate Replacements. Drops auto-cascade to the reciprocal pair within the same batch. Replacements respect a new 90-day admin-drop cooldown alongside the existing shown-cooldown and user-side hidden filters. Replacement-only `MIN_RELEVANCE_SCORE=25` (vs main generator's 40) so dropped slots can be refilled when the candidate pool is naturally narrower. Two scoring fixes landed alongside: `parseExpertise()` correctly handles Postgres array literal text (`'{privacy,"data protection"}'`) which `Array.isArray()` was silently falsing on, and the replacement threshold change is scoped only to the admin route. Schema additions: `batch_suggestions.dropped_at timestamptz` column + partial index. Commit `3293559`.
- **Founding Member display on billing.** New `FoundingMemberBadge` primitive in `components/ui/`. When `is_founding_member = true`, the billing-page header shows the gold pill instead of the raw `subscription_tier` label, with override tagline, helper text, 5 benefit bullets, and optional expiration display ("Founding access through [date]") if `founding_member_expires_at` is set. NULL means lifetime. Pure UI — no backend logic touched. Granting status remains SQL-only by design. Commit `04f9c90`.
- **Opportunities admin metrics card.** Read-only summary card on `/dashboard/admin` showing Created (7d) and Responses (7d). Plain `<div>` (not a `Link`) — no detail page or filters. Counts via admin client to bypass RLS. Briefcase icon, matches visual chrome of other cards. Hoisting fix: scoped `opportunityWindowStart` const to avoid colliding with the existing `sevenDaysAgo` declaration further down the file. Commit `182984b`.
- **Shared `parseExpertise` helper + canonical 33-tag `EXPERTISE_OPTIONS` list (April 28).** The `profiles.expertise` column is TEXT and has accumulated three storage formats over time: real arrays (`['Legal','M&A']`), Postgres array literals (`'{Legal,"M&A"}'`), and JSON-stringified arrays (`'["Legal","M&A"]'`). The `Array.isArray()` check used in five different read sites silently returned `false` on stringified data, so saved expertise stopped pre-selecting in pickers and stopped scoring in the matching algorithm. Parallel issue: the four expertise pickers across the app each had different option lists (OnboardingForm: 12, ProfileEditForm: 10 with 'Other', ProfileForm: free-text, OnboardingStep1: free-text), so a user could enter expertise via one surface that another surface couldn't display. New `lib/parseExpertise.ts` handles all six input formats (real arrays, JSON-stringified, PG literal text, comma-separated, single value, null/empty). New `lib/profile-options.ts` exports the canonical 33-item `EXPERTISE_OPTIONS` used by all four surfaces. ProfileForm and OnboardingStep1 converted from free-text inputs to toggle pickers matching the visual pattern. Existing user data with non-canonical values is preserved as "Additional expertise" pills with X-removable display below the picker. The 'Other' option was removed. Storage behavior was NOT changed — writes still use whatever path each surface currently uses. Schema not migrated. Commit `3853328`.
- **Defensive cap on expertise overlap scoring (April 28).** Today's expansion of `EXPERTISE_OPTIONS` from 12 (or 10) to 33 raised the ceiling on how many tags users could plausibly select. Without a cap, broad-expertise users could dominate match scoring (e.g., 12 overlapping tags × 8 points = 96 points from expertise alone). Cap counted overlap at 5 in both `app/api/admin/generate-batch/route.ts` (main scoring, inside the existing partial-overlap branch so full-overlap pairs still score 0 by design) and `app/api/admin/batch/[batchId]/generate-replacements/route.ts` (replacement scoring). Max expertise contribution is now 40 points (5 × 8) regardless of total overlap size. Users with 0–4 overlapping tags: zero behavior change. Per-tag weight, `MIN_RELEVANCE_SCORE`, purposes scoring, role-type/geography/format/seniority logic all unchanged. Commit `d6ea30a`.
- **Account cleanup pattern documented.** Cascade deletes from `auth.users` only reach `notifications` and `issue_reports` — NOT `profiles`, `intro_requests`, `batch_suggestions`, or `meeting_credits`. Clean removal requires deleting from each referencing table first, then `profiles`, then `auth.users`. Plus the `waitlist` UNIQUE constraint on `email` separately blocks re-signup until that row is removed. Pattern verified during Daniel's signup recovery (April 27–28).

### Future / Planned

- **Tier-aware slot top-ups for cron-driven refills (Phase 4).** Audit/confirmation needed: cron-driven refills (`weekly-refresh`, `daily-refill`, `monthly-batch`) may add too many suggestions instead of topping up only to the tier cap. Goal: if a user has 1 untouched intro, only add enough to reach the tier cap (not a full new allotment on top). Different files, different risk profile from Batch Review — kept as its own session.
- **Production email-send (Resend) failing on `andrel.app`.** Admin "Send invite" flow on production silently fails to email the temp password while creating the auth user, leaving an orphan account with an unrecoverable random password. Same flow works on localhost. Likely missing or wrong `RESEND_API_KEY` on Vercel, or unverified FROM domain. Diagnose and fix before granting more invites at scale.
- **Auto-clean waitlist row on successful signup.** Currently waitlist rows persist forever after the user signs up — accumulating ghost rows in the admin "Invited" tab. Should auto-delete when the matching auth user completes signup.
- **Admin "Delete waitlist entry" button.** Currently SQL-only. Useful for test rows, duplicate applications, or rows with stale company info.
- **Admin "Retract invite" button.** Flip status back to `pending` for an invited entry that hasn't been claimed. Useful when invites are sent in error.
- **Reply / conversation system on Issue Reports** — Likely Option D using the existing messages infrastructure: clicking "Reply" on a report opens or creates a regular Andrel conversation between admin and the reporter. Zero new schema; reuses messaging UI on both sides. Deferred until V1 issue reports surface real volume.
- **Status mutation UI on admin issues page** — Buttons to flip `new → in_progress → resolved | wontfix` instead of running SQL. Cheap to add; deferred until friction is felt.
- **Admin UI to grant/revoke founding status** — currently SQL-only. ~60 min of work when the volume of grants justifies it.
- **Auto-grant founding for first-N signups** — would require signup-flow logic + a counter and a UX path for telling new users they got it.
- **Email warning before founding expiration** — current behavior is silent downgrade if `founding_member_expires_at` passes.
- **ReceiverCard founding badge inline** — would require widening the opportunity-fetch data path to include `is_founding_member` on the suggested user. Out of scope for the V1 UI-only badge work.
- **`profiles.expertise` storage normalization.** Column is TEXT and has THREE different storage formats coexisting: real arrays, JSON-stringified arrays (new signups via `OnboardingForm` write this), Postgres array literals (older profiles). The shared `parseExpertise` helper now handles all three on read, but writes are still inconsistent. Three options: (A) migrate column to `text[]` proper PG array — cleanest long-term, requires careful data migration; (B) standardize on JSON-stringified text everywhere — avoids migration but keeps the parsing-trap surface; (C) standardize on PG array literal text — same shape as `purposes`. Pick one and migrate writes + existing data in a future session.
- **Legacy expertise data migration.** Existing users with values like "M and A" or "Engineering" (from old 10-item list with 'Other') still exist. They surface as "Additional expertise" pills in the picker. Optional one-time migration to canonical equivalents where possible.
- **Free-text "Other" option with normalization/aliasing.** Currently disallowed (was in old `ProfileEditForm` 10-item list). To re-enable safely would require an admin-curated alias map ("data privacy" → "Privacy", "M and A" → "M&A") that's expensive to maintain. Deferred until there's clear demand and we accept the maintenance burden. Alternative: ship "Other" as decorative text only, not factored into matching scoring.
- **Per-tag weight tuning for expertise scoring.** Cap is in place, but the per-tag weight (8 points) was set when users picked from a 10-12 item list. With 33 options and more specific tags ("Privacy" + "Data Protection" + "GDPR" instead of just "Legal"), typical overlap counts may shift. Re-evaluate after observing real user data.
- **Supply control / ranking refinements** — Prompt #15 shipped the base; ongoing tuning likely as real users arrive.
- **Real-time notifications** via Supabase Realtime or SSE instead of 30s polling.
- **Admin audit log table** (`admin_action_logs`) — currently only server logs.
- **Profile modal for in-page profile peeks** — AdminIntroCard click-anywhere behavior pending this.
- **Behavioral signal computation pipeline** — schema exists but no cron populates scores. Every row has bootstrap 0.5 defaults.
- **Responder self-prioritization** — Pro spends credit, Exec auto-prioritize (Prompt 3b) — deferred.
- **`profiles.role_type` normalization** — 11 legacy values drift to 5 canonical. Normalize.
- **Migrate remaining surfaces to design system primitives** — Admin, Billing, Meetings, Network, Profile edit, conversation detail. Use the pattern established in the April 2026 polish pass.

### Dev Environment Quirks

- **macOS Control Center hogs port 5000.** Dev server runs on port 3000 as of April 22.
- **PostgREST `.or()` silent-miss bug class.** Using `(and(...))` with outer parens causes zero-row silent failures. Always use helpers in `lib/db/filters.ts`.
- **SWC parser strictness.** Avoid `return x\n  .method().chain()` patterns in TSX — ASI can break them.
- **Supabase SQL editor** only runs the statement your cursor is on by default. Use Cmd+A to select all first, or wrap in a single statement.
- **`UPDATE` statements return "No rows returned" in Supabase SQL editor even on success.** To verify an update ran, re-query the table.
- **Large heredoc paste truncation in terminal.** Multi-file multi-patch node scripts longer than ~200 lines sometimes get cut during terminal paste, running only the first part. When running a migration patch, watch for a `git status` that shows fewer files than expected and re-run the missing patches. Prefer multiple smaller scripts over one large one.

---

## 11. How to Extend the System

### Before Building Anything

Ask:
1. Does this feature reduce signal per interaction, or increase it? (Increase is the goal.)
2. Is this pulling Andrel toward a feed / social / marketplace shape? (If yes, don't build.)
3. Does mutual consent remain preserved? (Required.)
4. Does it respect tier + credit semantics? (Required.)
5. Is there a simpler path that achieves the same outcome without new schema or UI surface?

### Adding a New Notification Type

1. Add the type string to the `NotificationType` union in `lib/notifications/index.ts`.
2. Add an entry to `NOTIFICATION_COPY` with short, confident copy.
3. Add an entry to `LINK_BY_TYPE` with the destination route.
4. Fire via `createNotificationSafe({ userId, type, data })`.
5. Test that the bell displays it and the click routes correctly.

No DB migration needed — `notifications.type` is free text.

### Adding a New Intro Status

1. Decide the state transition semantics. Document which existing flows should include/exclude it.
2. Update `generate-recommendations.ts` exclusion logic (line ~882) to include or exclude the new status.
3. Update `inspectPair.ts` eligibility check to include the new status.
4. Update `/dashboard/introductions/page.tsx` if the new status should or shouldn't render for the user.
5. No DB migration needed — `intro_requests.status` is free text.

### Adding a New Admin Action

1. Create the endpoint at `/api/admin/<action-name>/route.ts`.
2. First line of handler: `const { error } = await requireAdmin()` — return early on error.
3. Use `createAdminClient()` for any writes.
4. Log `{ by: user.email, ...inputs, ...outputs }` for traceability.
5. If the action should appear in Match Inspector, extend `MatchInspectorClient.tsx` conditional button rendering.

### Working With Bidirectional Filters

**ALWAYS** use helpers from `lib/db/filters.ts`:
- `buildBidirectionalMatchFilter(userA, userB)` for matches
- `buildBidirectionalBlockFilter(userA, userB)` for blocked_users
- `buildBidirectionalIntroRequestFilter(userA, userB)` for intro_requests

Never hand-write `.or('and(...)')` filter strings. Easy to get silent-fail syntax wrong.

### Modifying the Matching Algorithm

`lib/generate-recommendations.ts` is large (999 lines). Changes should:
1. Have a clear before/after score comparison for at least 3 test users (run `force-generate-recommendations` against staging or a test user).
2. Not break the exclusion logic (matched, blocked, cooldown, hidden, passed, pending intros).
3. Not break the tier differentiation (free users should still feel discovery; executive users should feel curated top-of-list).
4. Not change the business solution throttle (30% cap with tier multipliers) without product review.
5. Respect the expertise overlap cap (5 tags max counted) in both `app/api/admin/generate-batch/route.ts` and `app/api/admin/batch/[batchId]/generate-replacements/route.ts`. Removing the cap would let broad-expertise users dominate scoring. Per-tag weight is currently 8 points; revisit after observing real user data.

### Changing Tier Limits

Change `TIER_RECOMMENDATION_COUNTS` in `lib/generate-recommendations.ts`. Also audit:
- Stripe pricing vs tier
- Any UI that displays tier benefits
- Existing users' subscription_tier values

### Changing Credit Costs

Change the deduction amount in the relevant endpoint (e.g., `/api/intro-requests/express-interest/route.ts`). Audit:
- Error copy for insufficient credits
- Refill rates in cron/daily-refill
- Tier copy

### When to Write to This Document

After every meaningful product change, update the relevant section here. This doc is the first thing a new contributor (human or AI) should read. If it goes out of date, the whole system suffers.

### Building a New Page or Surface

When building anything new-facing (not admin, not internal):

1. Use primitives from `components/ui/` — `Card`, `Button`, `Avatar`, `Pill`, `EmptyState`, `Toggle`. Do not re-implement them.
2. Use brand tokens from `tailwind.config.ts` — `brand-navy`, `brand-gold`, `brand-cream`, etc. Do not hardcode hex.
3. Follow the responsive rules in section 3G — stack on mobile, inline from `sm:`, buttons full-width on mobile.
4. Page headings: `text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight`.
5. Test at 375px mobile width before shipping.
6. Avatars MUST use the gradient fallback when no photo is available — no flat color blocks.
7. Every list view needs a designed empty state via `EmptyState`.
8. Every save action needs a visible confirmation (e.g., gold `Pill variant="gold" dot>Saved</Pill>`).

If you find hardcoded hex, old `rounded-lg` cards, or `text-gray-*` color scale on a surface you're touching, migrate it opportunistically. If you're not touching it, leave it — someone will get to it.

---

## Appendix A — Known Traps / Silent-Failure Pitfalls

These are bugs we've hit and fixed. Each one fails silently — no error surfaces to the user or developer.

1. **PostgREST `.or()` with outer parens.** `'(and(a.eq.X,b.eq.Y))'` returns zero rows with no error. Correct: `'and(a.eq.X,b.eq.Y)'`. Use `lib/db/filters.ts` helpers.
2. **`.eq('read', false)` on `notifications`.** Column is `read_at` (timestamp). Use `.is('read_at', null)`.
3. **`.eq('onboarding_completed', true)` on `profiles`.** Column is `onboarding_complete`. Drop the 'd'.
4. **CHECK constraints on text columns.** If a whitelist exists, new values silently fail the constraint. Prefer free-text + application-layer validation. We removed `notifications_type_check`.
5. **RLS with no INSERT policy.** Writes from `createClient()` (user context) to a table with no matching RLS insert policy silently fail. Use `createAdminClient()` for backend writes OR add explicit policies.
6. **`.limit(1).maybeSingle()` chain.** Sometimes returns inconsistent results. Prefer `.maybeSingle()` alone.
7. **Import-existence checks by substring.** An import-adding Python script that checks `if 'ExternalLink' not in content` will always match once the JSX usage is inserted. Target the `import { ... }` line specifically with regex.
8. **SWC parser ASI quirk.** `return x\n  .methodA()\n  .methodB()` can be mis-parsed because JavaScript ASI may insert a semicolon after `return x`. Inline or store in a variable first.
9. **Stripe customer ID drift.** Live mode key rotations leave stale `cus_*` IDs in profiles. Checkout fails with "No such customer." Clear `stripe_customer_id` to let checkout auto-create.
10. **Dev server caching `lib/*` imports.** Hot-reload sometimes serves stale compiled modules after edits to deeply-imported files. Solution: `rm -rf .next && npm run dev`.
11. **Profile email vs auth email drift.** `profiles.email` can diverge from `auth.users.email`. Admin tools should fallback via `auth.admin.listUsers()`.
12. **Messages `read_at` never set if no endpoint updates it.** Before April 24, `ConversationView` fetched and displayed messages but never wrote `read_at`. Sidebar unread-count badge stuck indefinitely. Any surface that affects read state needs an explicit write path plus a client-side `router.refresh()` for the layout to re-compute counts.
13. **Match `status` test pollution.** Testing the Network → Remove flow on the admin account silently marks matches as `removed`. The `/api/messages/conversations` route correctly filters removed matches out, so the admin appears to have no conversations. Not a bug — but a trap if you're using the admin account for feature testing. Use a dedicated test account instead.
14. **Supabase SQL editor only runs the statement at your cursor.** If you paste multiple SQL statements, only the one under your cursor runs unless you Cmd+A to select all first.
15. **Email reuse for fresh signup requires renaming both `auth.users.email` AND `profiles.email`.** Just deleting the auth row leaves orphaned references; just changing `profiles.email` doesn't free the email for re-signup (auth.users has the unique constraint). Pattern: rename both to `original+archived@domain.com`, set `profiles.account_status = 'deactivated'`. The CHECK constraint on `account_status` allows `'active' | 'deactivated' | 'flagged'` — `'inactive'` will silently fail the constraint and roll back the entire transaction. Verify with `pg_get_constraintdef` before guessing values.
16. **`<a>` element with nested `<ExternalLink>` icon as a child can crash SWC parser in some Next.js 14 builds.** Symptom: "Unexpected token `div`. Expected jsx identifier" at the `return (` line of a server component, with the actual error elsewhere. Cache-clearing (`rm -rf .next`) does not resolve it. Fix: put the icon and link side-by-side instead of nested, or use plain text without the icon. Bisect any SWC parse errors that survive cache clears by stripping the JSX in halves until the failing chunk is isolated.
17. **`intro_requests.batch_id` is null for cron-generated rows.** Batches and intro_requests are loosely coupled — `generate-recommendations.ts` inserts into intro_requests directly without setting batch_id. The approve-batch route only flips `batch_suggestions` rows; it does not create intro_requests. This means a cleanup query like `update intro_requests set status='archived' where batch_id != latest_batch_id` would archive ALL suggested rows for ALL users (since every batch_id is null). Always preview with a SELECT before any cleanup UPDATE on intro_requests.
18. **`reports.map((report: any) => ...)` inside JSX trips SWC.** The `: any` annotation on a destructured arrow function parameter inside a JSX context can trigger "Unexpected token" errors. Drop the `: any` annotation and let TypeScript infer. Same advice for `Record<string, 'literal1' | 'literal2'>` generics — replace with `Record<string, string>` plus a cast at consumer site if you need narrowing.
19. **`Array.isArray(profiles.expertise)` returns false on most stored data.** The column is TEXT and has THREE storage formats coexisting: real arrays (`['Legal','M&A']`), Postgres array literals (`'{Legal,"M&A"}'`), and JSON-stringified arrays (`'["Legal","M&A"]'`, what new signups via `OnboardingForm` write). `Array.isArray()` returns false on both string forms, so any scoring or overlap code that treats it as a real array silently scores zero. Use the canonical `parseExpertise` helper at `lib/parseExpertise.ts` — it handles all three formats plus comma-separated strings, single values, and null/empty. The helper is shared across `ProfileEditForm`, `OnboardingStep1`, `ProfileForm`, public profile page, the main batch generator, and the batch review replacement route. (The inline duplicate parser in `app/api/admin/batch/[batchId]/generate-replacements/route.ts` from yesterday's work was kept rather than refactored — both work identically.)
20. **Hoisting + `const` in server-component data-fetch blocks.** Declaring `const sevenDaysAgo` lower in the function while referencing it earlier produces a runtime "Cannot access before initialization." Symptom looks like a build error at first glance but is actually thrown when the function executes. Either declare counts at the top with their own scoped variable, or compute inline at the use site.
21. **Cascade deletes from `auth.users` only reach some tables.** `ON DELETE CASCADE` is set on the FK from `notifications` and `issue_reports` (and a few others), but NOT on `profiles → auth.users`, `intro_requests`, `batch_suggestions`, or `meeting_credits`. Deleting an auth user leaves orphan rows in those tables. To cleanly remove an account: delete from each referencing table first, then `profiles`, then `auth.users`. Verify with a `select count(*)` per table after each step.
22. **`waitlist.email` UNIQUE constraint blocks re-signup.** Even after an account is fully deleted from `auth.users` and `profiles`, an old waitlist row with the same email blocks fresh signup with PostgreSQL error code 23505 ("This email is already on the waitlist"). The check is on the email column itself, not a status column. To allow re-signup of a previously-waitlisted email: `delete from waitlist where email = '...'` first. Auto-cleanup on successful signup is queued (see Future / Planned).
23. **Admin "Send Invite" creates an unrecoverable account if email fails.** `app/api/admin/send-invite/route.ts` generates a random temp password via `Math.random().toString(36).slice(-12)`, calls `auth.admin.createUser({password: tempPassword, email_confirm: true})`, then sends the password by email via Resend. If the email send fails, the auth user is already created with a password that exists ONLY in the dev server console log (or the email that didn't arrive). Production failure mode: orphan account, locked out user. Always check `[send-invite]` logs after triggering this flow. Workarounds: use Supabase dashboard to reset the password directly, OR delete the orphan auth row and retry.

---

## Appendix B — Test Accounts

Use placeholder format for any new commits:

```
test1@andrel.app / cadre-demo-2026
test2@andrel.app / cadre-demo-2026
```

Current demo accounts live in the Supabase auth user table with password `cadre-demo-2026`. Do not commit actual passwords to the repository. See Section 9 for the live list.

Admin account: `bizdev91@gmail.com` — password managed by the operator.

---

## Appendix C — Admin Routines

### Monthly (required)
- [ ] Verify batch generated on the 1st.
- [ ] Approve the batch (`/dashboard/admin/batches` → Approve).

### Weekly (recommended)
- [ ] Review intro_requests volume and resolution rate.
- [ ] Spot-check notification delivery via bell UI.
- [ ] Check for stuck admin intros (admin_pending older than 14 days).

### As needed
- [ ] Use Match Inspector to propose intros for high-value members.
- [ ] Unblock / restore matches on request (with confirmation).
- [ ] Update scoring thresholds in `generate-recommendations.ts` if distribution feels off.
- [ ] Review waitlist queue; send invites.

### Data hygiene (quarterly)
- [ ] Archive stale `suggested` intros older than 90 days.
- [ ] Review admin_action_logs table (when built).
- [ ] Run an audit of RLS policies via the Supabase Security Advisor.
- [ ] Check for dead CHECK constraints on free-text enum columns.

---

*End of document. Update as the system evolves.*
