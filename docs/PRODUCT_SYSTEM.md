# Andrel — Product System Document

**Last updated:** April 23, 2026
**Audience:** Engineers, AI assistants (Claude), and operators working on Andrel.
**Purpose:** Single source of truth for how the system is built, why it's built that way, and how to extend it without breaking the product's core philosophy.

This document is designed so that a new AI with no prior context can read it and continue building immediately. It is intentionally detailed and specific — no marketing language.

---

## Table of Contents

1. Core Philosophy & Product Principles
2. System Architecture Overview
3. Core Product Systems
   - 3A. Introductions Engine
   - 3B. Network Layer
   - 3C. Messaging System
   - 3D. Notification System
   - 3E. Credits & Monetization
   - 3F. Admin System
4. Opportunities Engine
5. Data Model (High-Level)
6. User Flows (Step-by-Step)
7. Guardrails
8. UX & Tone Guidelines
9. Operational Details
10. Known Issues / Backlog
11. How to Extend the System

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

**Silent decline.** When a user passes on an introduction, the other party is not notified. This protects the relational tone and avoids the social pain that transparent rejection would create. This principle extends to opportunities: when a creator declines a responder, the responder never sees a rejection signal — the opportunity simply remains in their view as "Waiting" until it closes.

**No feeds.** If it scrolls infinitely, it's a feed. Andrel has no feed. Inboxes, curated introduction batches, direct messages, and the Opportunities surface are the only surfaces.

**Credits tie effort to meaning.** Users pay (via credit deduction or subscription) to act — express interest, accept an intro. This keeps actions deliberate and prevents spam. Exception: Opportunities responses are currently launch-phase-free (V1) and will onboard to a credit model post-launch.

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
- **Hosting:** Vercel (web + serverless routes). Cron jobs managed via vercel.json.
- **Admin primary email:** bizdev91@gmail.com (single admin; no role-based ACL yet).

### Repository Layout

Top-level directories:
- app/ — Next.js App Router (dashboard, onboarding, api, marketing)
- components/ — Shared React components
- lib/ — Shared business logic (admin, db filters, notifications, matching, opportunities, supabase clients, trust signals)
- migrations/ — Dated SQL files for schema changes (applied manually via Supabase SQL editor)
- docs/ — This document
- vercel.json — Cron schedule config

### Supabase Project

- Project ID: cyjyutmtsovfnnbbluxc
- Admin email: bizdev91@gmail.com
- All public-schema tables have RLS enabled.

### How Systems Connect

Browser → Next.js Server Components → createClient() (user-scoped Supabase, respects RLS) → routes to pages.

Browser → Fetch /api/* endpoints → createClient() for auth check → createAdminClient() for privileged writes (bypasses RLS) → Supabase PostgreSQL.

External events: Stripe → /api/webhooks/stripe → subscription + credit updates. Vercel cron → /api/cron/* → batch generation, refresh, refill, opportunities maintenance.

### Two Supabase Clients

This is load-bearing and easy to get wrong.

- **createClient() from @/lib/supabase/server** — authenticated as the signed-in user. All queries go through RLS. Use in API routes that act on behalf of the user.
- **createAdminClient() from @/lib/supabase/admin** — authenticated with the service role key. Bypasses all RLS. Use ONLY for system-level writes: backend scoring, notification creation, admin tools, cron jobs, system-level inserts into foreign-owned rows (e.g., delivering opportunity candidates).

**Rule:** If a table has RLS enabled AND your insert/update is coming from a backend context, use the admin client. Using the user client for backend writes causes silent failures — we've hit this in trust_signals, notifications, and opportunity_candidates historically.

---

## 3. Core Product Systems

### 3A. Introductions Engine

The heart of Andrel. Four distinct paths create introductions:

1. **Monthly batch** — algorithmic, mutual-interest flow
2. **Admin proposal** — curated by human admin, mutual-consent flow
3. **Mutual-interest auto-match** — when two users independently express interest in each other
4. **Opportunity introduction** — creator-driven (hiring / business need). See Section 4 for full detail.

All four end in the same terminal state: matches row with status active + conversations row + icebreakers + system intro message. Opportunity-initiated matches additionally carry `matches.opportunity_id` and `matches.is_opportunity_initiated = true`, which drives downstream UI affordances (the gold "Opportunity" chip in messages and mutual_match notification routing directly to the conversation instead of `/dashboard/opportunities`).

#### Monthly Batch Generation

**Cron:** /api/cron/monthly-batch runs at 0 9 1 * * (9 AM UTC, 1st of each month).

Despite the filename history (it was called weekly-batch until April 2026), the cadence is monthly. The sibling cron weekly-refresh (Mondays 9 AM) handles notifications + refresh of existing batches.

**Per user, the generator runs generateOnboardingRecommendations(userId) which:**

1. Loads user profile + checks for targeted_requests (premium feature: user-specified preferences for this batch)
2. Determines tier via getEffectiveTier(profile) → recommendation count: Free 3, Professional 5, Executive 8, Founding 5
3. Fetches all candidates: account_status active AND profile_complete true, excluding self and admin.
4. **Applies exclusions:** already matched (bidirectional, unless removed past 180-day cooldown), blocked, hidden permanently, passed within 75 days, any existing intro in statuses suggested/pending/accepted/admin_pending/approved
5. **Scores each candidate:** Final Score = Alignment (55%) + Network Value (30%) + Responsiveness (15%) + bonuses. Alignment = goal/preference overlap (30), seniority fit (20), expertise overlap (max 15), location (5–15). Priority bonus +5, boost bonus boost_score * 0.5. Tier adjustment varies by tier. Mentorship adjustment -15 if senior with mentorship off sees junior. Targeted request boost up to +15.
6. **Filters:** minimum finalScore >= 10. Applies mentorship filter.
7. **Ranks** using applyTierRankingAdjustment — tier-specific randomness and rank-boost logic.
8. **Throttles business solutions** (consultants, law firms, legal tech): max 30% default, scaled down by tier, halved if user not open to solutions.
9. **Junior distribution control:** For senior users with mentorship on, caps juniors at 20%. Interleaves to prevent clustering.
10. **Generates match_reason** — humanized via generateIntroReason().
11. **Inserts** N intro_requests rows with status suggested.

**Key file:** lib/generate-recommendations.ts (999 lines)

#### Approval Gate

Generated batches are NOT immediately visible to users. They sit in introduction_batches with pending status. An admin must click Approve in /dashboard/admin/batches which:

- Sets new batch status active
- Sets previous batch status completed
- Flips every batch_suggestions row from generated → shown with shown_at timestamp
- Notifications to users are fired by the subsequent weekly-refresh cron

This gate is the single most important recurring admin action.

#### Express Interest Flow

User clicks Express interest on a suggested intro card.

1. Client calls submitIntroRequest(targetId), creates intro_requests row with status pending
2. Client POSTs to /api/intro-requests/express-interest
3. Server: validates 1 free credit, deducts 1 free credit, marks row approved, sends interest_received notification, checks for reverse request
4. If mutual interest detected: creates matches row, conversation, icebreakers, system intro message, mutual_match notifications

**Credit semantic:** 1 free credit per Express Interest.


#### Admin Proposal Flow

Admin opens /dashboard/admin/match-inspector, enters two users, clicks **Propose Introduction**.

POST /api/admin/admin-create-match does NOT create a match immediately:

1. Safety: checks block status, existing active match, existing open admin intro.
2. Inserts **two** intro_requests rows (one per direction) with status admin_pending, is_admin_initiated true, admin_notes manual_create.
3. Sends admin_intro notification to both users.
4. Returns { mode: 'intro_proposed' }.

Both users see an **Introduced by Andrel** card at the top of their /dashboard/introductions page.

**First accept:**
- Calls /api/intro-requests/express-interest with the intro id that targets THEM
- Server logic recognizes is_admin_initiated and uses **direction-aware reverse-request check**: for admin intros, reverse row is (requester=expresser, target=other), must have status approved
- Current user's row transitions admin_pending → approved; other still admin_pending
- Match is NOT created. Card updates to "Waiting on [Name]."
- admin_intro_nudge notification fires to the other user

**Second accept:**
- Reverse row now approved, triggers mutual-match creation
- Match created with admin_facilitated true, admin_notes manual_create, status active
- Conversation, icebreakers, system intro message created
- mutual_match notifications fired to both users
- User who just accepted redirects to /dashboard/network

**Decline (either side):**
- Calls /api/intro-requests/decline-admin-intro
- Server updates BOTH intro_requests rows to status declined in a single transaction
- No notification to the other user — silent per spec
- Other user sees no admin intro card on next visit

#### Statuses — Canonical List

intro_requests.status is a **free-text column** (no CHECK constraint):

- suggested — Batch recommendation, user hasn't acted yet
- pending — User-initiated intro (legacy)
- approved — User has accepted / expressed interest
- accepted — Used historically; new code uses approved
- admin_pending — Admin-proposed intro awaiting user accept
- declined — User declined an admin intro (silent)
- passed — User passed on a suggested intro (75-day cooldown)
- hidden — User hid suggestion permanently
- archived — Cleaned up by cron

matches.status: active, accepted, removed. Removed has 180-day cooldown before the pair can be suggested again.

### 3B. Network Layer

A connection exists when a matches row has status active or accepted AND removed_at is NULL.

#### Remove vs Block

**Remove (soft):**
- Sets matches.status = removed, removed_at = now, removed_by = user.id
- Bidirectional: both stop seeing each other in Network
- 180-day cooldown before batch generator re-suggests them
- Does NOT prevent future user-initiated or admin-initiated intros
- Admin can restore via /api/admin/restore-match

**Block (hard):**
- Inserts row into blocked_users
- Marks match removed
- Bidirectional exclusion — neither user can see the other anywhere
- Admin can unblock via /api/admin/unblock

#### Visibility Rules

A user sees another's profile only when: a connection exists, the other is the target of a currently-visible intro, or the other is in a shared conversation. No other surface exposes a profile.

### 3C. Messaging System

**Conversation lifecycle:**
1. Created by match creation (batch, admin, user-initiated, or opportunity)
2. Rows in conversations (match_id, suggested_prompts jsonb)
3. Icebreakers generated by generateIcebreakers() and written to suggested_prompts
4. System intro message inserted into messages with sender_id NULL, is_system true
5. Participants message via /api/messages/send

**System vs user messages:**
- System: sender_id NULL, is_system true. Rendered as distinct "Andrel" voice
- User: sender_id = user.id, is_system false

**System-message voice for opportunities:** Uses generateSystemIntroMessage({ userA, userB, reason: 'Shared opportunity' }) — same helper as every other intro path, different `reason` value. This ensures voice consistency across batch, admin, user-initiated, and opportunity flows.

**Icebreakers:** jsonb array of 3–5 short prompt strings. Rendered as clickable chips. Generated identically for opportunity-initiated matches.

**First message:** No enforced delay, no contact fee. Credit was already paid at express-interest time (or comped, for opportunities).

**Admin bypass:** /api/messages/list allows the admin to read any conversation, even when not a participant. Used by Match Inspector's "Open Conversation" link.

**Opportunity context in conversation list + detail header:** Conversations where `matches.is_opportunity_initiated = true` render a gold "Opportunity" chip + the opportunity title in both the list view (/dashboard/messages) and the conversation detail header (/dashboard/messages/[conversationId]). Non-opportunity conversations render identically to before. The data is surfaced by extending the existing conversations list + single-conversation APIs to join through `matches` to `opportunities` and include `isOpportunityInitiated` + `opportunityTitle` on the payload.

### 3D. Notification System

Powered by notifications table (user_id, type text, title, body, link, data jsonb, read_at nullable timestamp).

**No CHECK constraint on type.** Free text. Schema debt was removed during Prompt #14.

**Canonical types (from lib/notifications/index.ts):**

Introductions + messaging:
- new_batch — Monthly batch approval → weekly-refresh cron
- interest_received — User-initiated Express Interest received
- mutual_match — Both users have accepted (any path). For opportunity-initiated matches, link routes directly to the conversation; for all others, link defaults via LINK_BY_TYPE.
- message_received — Someone sent you a message
- admin_intro — Admin proposed an intro involving you
- admin_intro_nudge — Other user accepted an admin intro; your turn
- low_credits — free_credits dropped to 1
- no_credits — free_credits hit 0
- nudge_interest — Cron: unviewed intros exist
- nudge_reply — Cron: message has sat without reply
- new_connection, intro_accepted — legacy
- meeting_request, meeting_accepted, meeting_declined — Meeting flow

Opportunities:
- opportunity_received — Candidate delivered a new For You opportunity
- recruiter_request — In-network recruiter was delivered a hiring opportunity
- opportunity_response — Creator's signal got an interested responder
- opportunity_nudge_creator — Cron: creator has unreviewed responses after 5+ days
- opportunity_closed — Cron: creator's signal transitioned to dormant; interested responders are notified

**Creation:**

Always via createNotificationSafe({ userId, type, data?, link? }) from @/lib/notifications. Never direct Supabase inserts. Handles 24-hour deduplication per (user, type), copy lookup from NOTIFICATION_COPY, link derivation from LINK_BY_TYPE.

**Link override:** As of April 23, 2026, createNotificationSafe accepts an optional `link` parameter. When provided, it overrides the default LINK_BY_TYPE lookup. The fallback chain is `(link ?? LINK_BY_TYPE[type]) || null`. This was introduced so opportunity-initiated mutual_match notifications can route to the new conversation directly rather than to the opportunities page. No other call sites currently use the override, but it is available for any future per-instance routing need.

**Opportunity notification suppression:** A global 7-day rolling suppression window exists on the opportunities matcher (OPPORTUNITY_NOTIF_SUPPRESSION_DAYS in lib/opportunities/matching.ts). Users who received an opportunity_received or recruiter_request in the last 7 days are excluded from candidate delivery for new opportunities. This is intentionally aggressive: we protect attention. The trade-off is that during rapid test cycles, the same tester can stop matching new opportunities — mitigated by the admin override (see Section 4).

**Read/unread:** Stored as read_at timestamp, NOT a boolean read column. Any endpoint querying .eq('read', false) is broken — use .is('read_at', null).

**Bell UI:** components/NotificationBell.tsx wired into Sidebar.tsx and MobileNav.tsx. Gold badge for unread. Click opens dropdown with up to 10 most recent, click routes via link column and marks read.

**Sidebar section badges:** Distinct from the bell badge, individual sidebar nav items (Messages, Network, Meetings, Opportunities) render red pill badges reflecting pending state. These counts are computed server-side in app/dashboard/layout.tsx at each render and passed into the Sidebar + MobileNav components. The Opportunities badge uses getOpportunityBadgeCount() — see Section 4.

**Polling:** 30-second polling of /api/notifications/unread-count. No realtime subscription yet.

### 3E. Credits & Monetization

#### Credit Types

Two-pool system on meeting_credits (user_id, free_credits, premium_credits, balance):
- **Free credits:** Refill monthly per tier. Used first.
- **Premium credits:** Purchased one-time. Used after free exhausted. Unlock some premium-only actions.

Deduction logic in lib/credits.ts: deductCredits(free, premium, amount) uses free first then premium. Returns { free_used, premium_used, total_used, remaining_free, remaining_premium }.

#### When Credits Deduct

- Express Interest on a suggestion: 1 free credit
- Accept admin-curated intro (first or second acceptor): 1 free credit
- Decline admin intro: 0
- Propose admin intro (admin side): 0
- Send message in existing conversation: 0
- Receive an intro / be proposed: 0
- Schedule a meeting: varies by feature state
- **Opportunities response (V1 launch phase):** 0 — logged as opportunity_interested_comped in credit_transactions with note 'launch_phase'. Intended to transition to a metered cost in a later phase.

**Insufficient credit handling:** API returns 403 with error message. Client displays "Get credits" + "Upgrade" links.

#### Tiers

- free: 3 recs/month, discovery-weighted ranking
- professional: 5, slight top-candidate preference
- executive: 8, strong top-candidate preference
- founding: 5 (same as professional; limited-time for early members)

Stripe subscription controls tier via profiles.subscription_tier + subscription_status. Changes flow through the webhook handler.

**Tier opportunity caps** (distinct from monthly recs): Free 0, Professional 1, Executive 2, Founding 1. See Section 4.

#### Stripe Integration

**Checkout:** /api/billing/check-credit-purchase and /api/stripe/checkout (confirm which is live) redirect to hosted Stripe Checkout.

**Portal:** /api/stripe/portal opens customer portal.

**Webhooks:** Two parallel webhook routes exist — /api/webhooks/stripe (178 lines, handles customer.subscription.* + checkout.session.completed) and /api/stripe/webhook (114 lines, handles customer.subscription.* + invoice.payment_failed). Only ONE is configured as the Stripe destination; the other is legacy. **Verification needed.** See backlog.

**Live vs test mode:** Stripe keys are live-mode. Historical customer IDs from test mode rotation were cleared from profiles for demo accounts on April 20.

### 3F. Admin System

**Single admin:** bizdev91@gmail.com. Guarded via email check in server components and requireAdmin() helper in API routes.

#### Admin Dashboard — /dashboard/admin

Cards:
- **Members** — user management, boost priority, manual match (legacy)
- **Batches** — view all batches, approve/generate/delete. The Approve action is the core recurring monthly task.
- **Match Inspector** — pair inspection + 4 override actions
- **Waitlist** — review waitlist signups, send invites
- **Operations** — secondary page for support/debug tools

#### Match Inspector — /dashboard/admin/match-inspector

Admin enters two users (email or UUID). System returns:

- **Identity cards** — name, title, company, tier, onboarded state, UUID
- **Relationship state** — match id + status, conversation id (with "Open Conversation" link for admin), block status, intro request count
- **Eligibility checklist** — 6 checks: block, removal cooldown (180d), already matched, same user, profile completeness, pending intro requests
- **Primary failure reason summary** — top blocker, shown in green Eligible or red Not eligible card
- **Recommended action** — computed server-side, highlighted with gold ring: unblock, restore, createconv, or create (Propose Introduction)
- **Match insights** — human-readable reasons via generateMatchInsights()

Four override endpoints:
- /api/admin/unblock — removes block in both directions
- /api/admin/restore-match — clears removed state
- /api/admin/admin-create-match — proposes intro (creates 2 admin_pending intro_requests)
- /api/admin/create-conversation-for-match — backfills missing conversation on active match

Email resolution falls back via auth.admin.listUsers() when profiles.email doesn't match input — handles drift cases.

#### Batches Page — /dashboard/admin/batches

Lists all introduction_batches. Buttons:
- **Generate new batch** → /api/admin/generate-batch
- **Approve batch** → /api/admin/approve-batch (CRITICAL)
- **Delete batch** — rarely used
- **Review suggestions** — drill into individual pairs

#### Admin Override for Opportunities

ADMIN_OVERRIDE_EMAILS in lib/opportunities/caps.ts exempts listed emails from tier caps, account-age gates, and trust-score thresholds when creating opportunities. Currently contains only bizdev91@gmail.com. Intended for seeding and testing; not for operational admin proxying.

Note: The override bypasses eligibility checks but does NOT bypass the 7-day notification suppression window. If bizdev91 needs to exercise the full delivery flow for the same responder within 7 days, their notification row must be manually cleared (see Appendix C).

#### Other Admin Endpoints

- /api/admin/simulate-matches — pre-flight test
- /api/admin/force-generate-recommendations — force-regenerate for one user
- /api/admin/set-priority — toggle is_priority
- /api/admin/waitlist/* — approve/decline/invite flows
- /api/admin/send-invite — direct invite specific email
- /api/admin/compute-scores — recompute Network Value and Responsiveness scores

All guarded by email check.

---

## 4. Opportunities Engine

**Status:** Shipped April 22–23, 2026 (commits 090d16a, d6ca7b2, bf11554, 3f51d11, ad7c4bc, 82a790f). V1 launch-phase is active: all responses are credit-free.

### Product Intent

A creator-driven introduction flow for two use cases:
1. **Hiring** — member signals a role they're hiring for → system delivers to candidates with open_to_roles = true (and optionally in-network recruiters)
2. **Business need** — member describes a service/vendor need → system delivers to providers with open_to_business_solutions = true under a strict expertise + role_type relevance filter

Opportunities is **not a marketplace**, **not a job board**, **not a feed**. It is a curated, rare, opt-in delivery channel. The core philosophy from Section 1 holds: curation over discovery, mutual consent, silent decline.

### Architectural Model

- **Opportunities table** stores the signal (title, type, description, urgency, criteria jsonb, status).
- **opportunity_candidates** is a delivery ledger — each row represents one delivery of one opportunity to one user. It is NOT a feed; a candidate has a single row per opportunity per delivery.
- **opportunity_responses** records actual responder behavior (clicked "Open to this" / "I can help" / "I can take this"). Row exists only if the user responded.
- **recruiter_activity** tracks weekly recruiter cap usage.
- **matches.opportunity_id + matches.is_opportunity_initiated** link an opportunity-introduced connection back to the originating signal.

### Delivery Pipeline

On opportunity creation (POST /api/opportunities/create):

1. **Eligibility gate** (lib/opportunities/eligibility.ts): profile complete, account active, tier cap not exceeded, account age >= CREATOR_MIN_ACCOUNT_AGE_DAYS, trust_score >= CREATOR_MIN_TRUST_SCORE. ADMIN_OVERRIDE_EMAILS bypass all of the above.
2. **Create the opportunities row** with status 'active'.
3. **stripContactInfo()** sanitizes the description server-side before insert — emails, phones, URLs become [redacted]. This is the only content moderation layer.
4. **Run the matcher** (lib/opportunities/matching.ts). Per opportunity type:
   - Hiring → hiring candidates (role-type + seniority filter + open_to_roles). Optionally recruiters (in-network only, under weekly cap).
   - Business → providers by role_type in NEED_TO_ROLE_TYPES plus strict expertise overlap >= 1 tag.
5. **Apply exclusions:** self, admin, users in 7-day notification suppression window (OPPORTUNITY_NOTIF_SUPPRESSION_DAYS), users already delivered this opportunity.
6. **Score** (scoreHiring / scoreBusiness in matching.ts) — combines trust_score, responsivenessScore, and expertise overlap. Top N by DELIVERY_CEILING delivered.
7. **Insert opportunity_candidates rows** via admin client (RLS-exempt write) with relevance_score populated. Fire opportunity_received / recruiter_request notifications for each delivered user (unless suppression window active).

**Known behavior:** The matcher masks internal errors as a 201 + warning in the create-route response. The UI does not surface this warning. See backlog.

### Response & Introduction

**Response (POST /api/opportunities/respond):** Candidate clicks Open to this / I can help / I can take this. Writes an opportunity_responses row with status 'interested'. Fires opportunity_response notification to the creator. V1: response is credit-free, logged to credit_transactions as opportunity_interested_comped with note 'launch_phase'.

**Introduce (POST /api/opportunities/introduce):** Creator selects a responder and clicks Introduce → Confirm. The endpoint calls `connectOpportunityPair()` in lib/opportunities/connect.ts, which:
- Creates a matches row with status active, admin_notes = 'opportunity_<id>', opportunity_id = opp.id, is_opportunity_initiated = true.
- Creates the conversations row.
- Loads both creator and responder profiles, calls generateIcebreakers({userA, userB, reason: 'Shared opportunity'}) to populate suggested_prompts.
- Calls generateSystemIntroMessage with the same context and inserts the system message into `messages` (sender_id NULL, is_system true).
- Fires mutual_match notifications to both users with `link` override pointing to /dashboard/messages/<conversation-id> so the notification routes directly to the live conversation.
- Transitions opportunity_responses.status from 'interested' to 'introduced'.

### Creator-Side Workflow (Asymmetric)

Once a response is 'interested', the creator has three actions on the opportunity detail page:
1. **Introduce** → creates the match + conversation (above).
2. **Not a fit** → declines silently (below).
3. **Close the opportunity entirely** (CloseButton component) → opportunity.status → 'closed', all remaining interested responders receive an opportunity_closed notification.

**Decline ("Not a fit") — asymmetric visibility:**

- Endpoint: POST /api/opportunities/decline-response (creator-only, guards against declining already-introduced responses, idempotent).
- Sets opportunity_responses.declined_by_creator_at = now(). Status remains 'interested'.
- Creator's detail page query filters out rows where declined_by_creator_at IS NOT NULL, so the declined responder disappears from "People ready to connect."
- Candidate's view is unchanged: the opportunity still appears in /dashboard/opportunities/responses with status "Waiting." No notification fires. The candidate never observes the decline.
- When the opportunity eventually transitions to closed / expired / dormant / archived (creator action or cron), the candidate's /responded/[id] detail page renders "No longer active" — consistent with how it renders for any other closure cause. The decline itself never signals to the candidate.

The asymmetric-visibility pattern is intentional and central to the Silent Decline principle (Section 1). Do not add a decline notification, decline audit surface for responders, or any signal that would let a responder infer decline.

### Creator-Side "NEW" Indicator

opportunity_responses.seen_by_creator_at tracks when a creator last viewed a given response. The detail page, on load:

1. Captures the set of response IDs where status='interested' AND seen_by_creator_at IS NULL.
2. Batch-updates those rows' seen_by_creator_at to now().
3. Renders each of the captured IDs with a gold left-border accent + a "NEW" chip — indicating they were unseen before this page load.

**State-clear semantics:** NEW clears on view, not on action. A creator can visit the detail page, NOT act, leave, return 10 minutes later, and the NEW indicator is gone. This matches inbox-read mental model. Responses that arrive AFTER the last view will show as NEW on the next visit.

### Candidate-Side Surfaces

**/dashboard/opportunities** (hybrid page) — primary surface is "Opportunities for you" with all active, non-dismissed, non-responded opportunities. Secondary is "Your activity" with two destination cards ("Your signals" and "Your responses"). Empty state reads "No opportunities right now — We'll notify you when something highly relevant comes up. Opportunities are curated and infrequent." This copy reinforces scarcity, which is core to the product feel.

**/dashboard/opportunities/new/hiring** and **/new/business** — create forms. Description field shows hint text about contact-info stripping.

**/dashboard/opportunities/signals** — creator's list of their own active signals. Rows link to the creator detail page. Closed / expired signals get a "Remove" archive affordance (see Archiving below).

**/dashboard/opportunities/responses** — the responder's index of opportunities they've responded to. Each row links to /dashboard/opportunities/responded/[id].

**/dashboard/opportunities/responded/[id]** — read-only opportunity detail for responders. Access-gated: notFound() unless the viewer has an opportunity_responses row for this opportunity. Shows:
- Type badge + urgency (if business)
- Title (H1)
- Creator byline (name · company)
- Status line — one of: "Open to this on [date]", "Introduced on [matched_at date]", "Withdrawn on [date]", or "No longer active"
- Description (redacted at creation time)
- Primary "Open conversation" button only when status = introduced, conversation exists, and opportunity is still active
- Tertiary "View conversation →" link when status = introduced AND opportunity is no longer active (preserves history)

**/dashboard/opportunities/[id]** — creator's detail view. Lists responders split into "People ready to connect" (waiting) and "Introduced." Wraps the waiting list in IntroducedBannerHost which shows a success banner after Introduce clicks.

### Tier Caps + Admin Override

| Tier | Opportunity cap |
|---|---|
| Free | 0 (shown "Upgrade to Professional" copy in place of the Signal a need button) |
| Professional | 1 active signal |
| Executive | 2 active signals |
| Founding | 1 active signal |
| ADMIN_OVERRIDE_EMAILS | Unlimited (bypass cap + account-age + trust-score) |

Cap enforcement is in lib/opportunities/eligibility.ts. Caps are per-user active signal count — closed and archived signals don't count.

### Sidebar Badge (Live Counts)

The Opportunities sidebar link shows a red pill badge that reflects live actionable state. No synthetic read/seen state is used; the badge is computed fresh on every render of the dashboard layout.

Computed by lib/opportunities/unreadCount.ts → getOpportunityBadgeCount(userId) which returns:

- **receiverCount** — active, non-responded, non-dismissed opportunity_candidates rows where the underlying opportunity is active and not archived.
- **creatorCount** — opportunity_responses with status = 'interested' AND declined_by_creator_at IS NULL, where the underlying opportunity is active and not archived.
- **total** — sum of the two.

Badge decays organically as state changes: respond (drops receiver count), introduce (drops creator count), decline (drops creator count), close (drops both counts for the closed opp), archive (drops both), expire via cron (drops both).

Wired into app/dashboard/layout.tsx alongside networkNotifCount / meetingNotifCount / unreadCount, passed as opportunityBadgeCount to both Sidebar.tsx and MobileNav.tsx (where it renders on the More-menu Opportunities row).

### Archiving (Soft-Delete)

opportunities.archived_at is a nullable timestamptz. POST /api/opportunities/archive (creator-only, only for closed / expired status) sets it. All queries that drive the Opportunities surfaces filter `.is('archived_at', null)`. Archived signals are invisible to the creator's Signals list and don't count toward tier caps, but the underlying matches, conversations, and responder history remain intact and navigable.

### Maintenance Cron

**/api/cron/opportunities-maintain** runs daily at 0 10 * * * (10 AM UTC — one hour after weekly-refresh, two hours before daily-refill). Per active non-archived opportunity:

- If creator has unreviewed responses after 5+ days → fire opportunity_nudge_creator.
- If creator hasn't visited the detail page in 10 days → transition opportunity.status 'active' → 'dormant'. Silent — no notification.
- If opportunity.expires_at has passed → transition status → 'expired'. Fire opportunity_closed to all still-interested responders.
- On creator return (visit detected via TouchOnMount → POST /api/opportunities/touch) → dormant status silently reverts to 'active'.

Expiry windows (set at create time): Hiring 21 days. Business: urgent 7 / medium 14 / low 30.

### Opt-In Preferences

Three fields on profiles gate eligibility as a candidate:
- open_to_roles (new) — must be true to receive hiring opportunities
- open_to_business_solutions (existing) — must be true to receive business-need opportunities
- recruiter (new) — opts into recruiter_request deliveries

A /dashboard/settings-embeddable component (components/opportunities/OpportunityPreferences.tsx) exists but has NOT been wired into the settings page yet — see backlog. Today, these flags are toggled only via SQL or admin-path tooling.

### Key Files

- lib/opportunities/caps.ts — tier caps, ADMIN_OVERRIDE_EMAILS
- lib/opportunities/eligibility.ts — creator eligibility gate
- lib/opportunities/matching.ts — delivery pipeline, scoring, suppression
- lib/opportunities/relevance.ts — NEED_TO_ROLE_TYPES mapping for business needs
- lib/opportunities/connect.ts — match + conversation + icebreaker + system-message creation on Introduce
- lib/opportunities/copy.ts — UI strings
- lib/opportunities/unreadCount.ts — sidebar badge count helper

API:
- /api/opportunities/create, /respond, /introduce, /close, /dismiss, /touch, /archive, /decline-response
- /api/cron/opportunities-maintain

UI:
- /dashboard/opportunities (page.tsx — hybrid surface)
- /dashboard/opportunities/new (chooser) → /new/hiring, /new/business
- /dashboard/opportunities/[id] — creator detail
- /dashboard/opportunities/signals — creator's signals list
- /dashboard/opportunities/responses — responder's index
- /dashboard/opportunities/responded/[id] — responder's read-only detail

Components: ReceiverCard, ResponderRow, YoursRow, YourActivityRow, CloseButton, TouchOnMount, OpportunityPreferences, ArchiveAction, IntroducedBanner, IntroducedBannerHost.

Schema:
- opportunities (new table)
- opportunity_responses (new table) — with declined_by_creator_at, seen_by_creator_at
- opportunity_candidates (new table) — delivery ledger
- recruiter_activity (new table)
- profiles.open_to_roles, profiles.recruiter (column additions)
- matches.opportunity_id, matches.is_opportunity_initiated (column additions)

Migrations (all applied to production Supabase):
- migrations/2026-04-22_opportunities.sql (tables + base columns)
- migrations/2026-04-23_opportunities_archived_at.sql
- migrations/2026-04-23_opportunity_responses_declined.sql
- migrations/2026-04-23_opportunity_responses_seen.sql

---

## 5. Data Model (High-Level)

This section explains table roles and relationships, not full SQL.

### profiles

One row per user (FK to auth.users via id). Core fields:
- Identity: full_name, email, avatar_url, title, company, bio, linkedin_url
- Role / context: role_type, seniority, expertise (stored as TEXT Postgres array literal — see Appendix A), purposes (text[]), intro_preferences (text[]), interests (text[]), city, state, location
- Preferences: open_to_mentorship, open_to_business_solutions, open_to_roles, recruiter, meeting_format_preference, geographic_scope
- Lifecycle: onboarding_step, onboarding_complete, profile_complete, password_reset_required, welcome_sent_at
- Scoring: networkValueScore, responsivenessScore, trust_score, boost_score, is_priority
- Admin/status: admin_priority, is_admin, is_active, is_approved, is_founding_member, founding_member_expires_at, account_status, verification_status
- Billing: stripe_customer_id, stripe_subscription_id, subscription_status, subscription_tier, current_period_end

**Note:** Column is onboarding_complete (NOT onboarding_completed). References elsewhere in the codebase have gotten this wrong and produced silent-failure bugs.

**Note:** expertise is a TEXT column storing a Postgres array literal like `{privacy,"data protection",regulatory}` as a string. Application code MUST parse it. See lib/opportunities/matching.ts for the canonical parser; Appendix A for the trap.

### matches

One row per active or historical connection. Bidirectional — user_a_id and user_b_id are interchangeable. Key fields:
- user_a_id, user_b_id (both FK to profiles.id)
- status: active | accepted | removed
- matched_at, accepted_at, removed_at, removed_by, expires_at, created_at
- admin_facilitated (boolean): true if created via admin intro flow
- admin_notes (text): manual_create, manual_create_from_removed, manual_restore, opportunity_<id>, or null
- suggestion_id (FK): links to originating batch_suggestion if batch-created
- opportunity_id (FK, nullable): set when created via opportunity introduction
- is_opportunity_initiated (boolean, default false): drives gold "Opportunity" chip in messages and mutual_match link routing

### intro_requests

The unified table for all intros — batch suggestions, user-initiated, admin-proposed. **Opportunity introductions do NOT use intro_requests** — they go directly to matches. Key fields:
- requester_id, target_user_id
- status: free text (suggested, pending, approved, accepted, admin_pending, declined, passed, hidden, archived)
- match_reason: humanized explanation from the generator
- note: user-provided note (rare)
- is_admin_initiated (boolean): true for admin-proposed
- admin_notes (text): manual_create for admin intros
- batch_id: FK to introduction_batches if batch-originated
- credit_charged, credit_hold: flags for billing state
- match_score, reviewed_by, reviewed_at: scoring/admin metadata
- created_at, updated_at

**Admin intros have two reciprocal rows** (one per direction). User-initiated Express Interest creates one row; a reverse row is the other user's separate express-interest.

### conversations

One row per match once a conversation exists. Fields: match_id (FK), suggested_prompts (jsonb — icebreaker strings), first_message_sent_at, last_message_at, message_count, timestamps.

### messages

Key fields: conversation_id (FK), sender_id (FK to profiles, NULL for system messages), is_system (boolean), content (text), read_at (timestamp, NULL = unread), created_at.

### notifications

Key fields: user_id (FK), type (text, free text — no CHECK constraint), title, body (required), link (text, optional — route to open on click), data (jsonb, optional), read_at (timestamp, NULL = unread).

### blocked_users

Fields: user_id, blocked_user_id (both FK to profiles). UNIQUE constraint on pair, CHECK user_id != blocked_user_id.

### introduction_batches

One row per monthly batch. Fields: status, batch_number, created_at. Status flows: generated → active → completed.

### batch_suggestions

One row per (user, suggested_person, batch). Status: generated (hidden), shown (approved), passed, hidden_permanent.

### meeting_credits

Fields: user_id (FK), free_credits, premium_credits, balance (derived total).

### opportunities

One row per signal created by a member. Fields:
- id, creator_id (FK profiles.id)
- type: 'hiring' | 'business' (free text — no CHECK)
- title (text), description (text, nullable — sanitized at creation time via stripContactInfo)
- urgency: 'low' | 'medium' | 'urgent' | null (business-need only)
- criteria (jsonb) — holds expertise tags, role_type filters, etc.
- status: 'active' | 'dormant' | 'closed' | 'expired' (free text)
- include_recruiters (boolean)
- created_at, expires_at, last_viewed_at (used by maintain cron for dormancy check)
- archived_at (timestamptz, nullable — soft-delete marker; filters from all creator views)

### opportunity_candidates

Delivery ledger — one row per (opportunity, user) pair delivered. NOT a feed, NOT a response indicator. Unique constraint on (opportunity_id, user_id).

Fields:
- id, opportunity_id (FK), user_id (FK profiles.id)
- role: 'candidate' | 'provider' | 'recruiter' (the lens under which this user was matched)
- relevance_score (int) — scored at delivery time
- shown_at (timestamptz)
- dismissed_at (timestamptz, nullable — user dismissed the card; filters from For You)

### opportunity_responses

One row per actual response. Created only when the user clicks Open to this / I can help / I can take this.

Fields:
- id, opportunity_id (FK), user_id (FK profiles.id)
- role: same semantics as opportunity_candidates.role
- status: 'interested' | 'introduced' | 'withdrawn' (free text)
- credit_comped (boolean, defaults true in V1 launch phase)
- declined_by_creator_at (timestamptz, nullable) — creator clicked "Not a fit." Filters the row from the creator's view; responder's view unchanged. Asymmetric visibility — see Section 4.
- seen_by_creator_at (timestamptz, nullable) — last time the creator's detail page read this row. Drives the NEW indicator.
- created_at, introduced_at

### recruiter_activity

Tracks weekly cap usage for in-network recruiters. Fields: recruiter_id (FK profiles.id), week_start (date), deliveries_count.

### Other Tables (brief)

- meetings: scheduled meeting records
- credit_transactions: audit trail of credit changes (includes 'opportunity_interested_comped' type with note 'launch_phase')
- trust_signals: scoring events (profile_complete, message_sent, meeting_completed, etc.)
- user_scores: computed scoring metadata
- user_preferences: any preference storage
- waitlist: pre-approved signup queue
- targeted_requests: premium feature — user-specified requests for next batch
- admin_flags: admin toggles
- suggestion_responses: tracking user responses
- intro_candidates: candidate staging (legacy?)

---

## 6. User Flows (Step-by-Step)

### New User Onboarding

1. User signs up (email/password via Supabase Auth) OR invited via admin email.
2. Lands on /onboarding which redirects to /dashboard/onboarding (the real flow).
3. **Step 1: Build Your Profile** — fields: full name, title, company, bio, seniority (Junior/Mid-Level/Senior/Executive/C-Suite), role type (In-house, Law Firm, Consultant, etc.), expertise (comma-separated), LinkedIn URL.
4. Submission sets onboarding_step = 2.
5. **Step 2: Set Your Preferences** — fields: purposes (multi-select), personal interests (multi-select), intro preferences (role types they want to meet).
6. Submission sets profile_complete = true and onboarding_complete = true.
7. First batch is generated via /api/onboarding/generate-recommendations.
8. User is redirected to /dashboard/introductions.

### Receiving a Batch

1. On the 1st of the month, monthly-batch cron generates batches for all active users.
2. Batches sit in introduction_batches with pending status.
3. **Admin must click Approve** in /dashboard/admin/batches — flips status to active.
4. Next run of weekly-refresh cron (Monday 9 AM) sends new_batch notifications.
5. User opens /dashboard/introductions and sees their 3–8 curated intros.

### Expressing Interest

1. User clicks Express interest on a suggested intro card.
2. 1 free credit is deducted.
3. intro_request.status goes suggested → approved.
4. If other user ALSO already expressed interest: match created, conversation created, both get mutual_match notification.
5. If not: other user receives interest_received notification.

### Admin Proposal (Propose Introduction)

1. Admin opens /dashboard/admin/match-inspector.
2. Enters two user emails. Checks eligibility.
3. Clicks **Propose Introduction**. Confirms.
4. Two intro_requests rows created (admin_pending, reciprocal, is_admin_initiated = true).
5. Both users receive admin_intro notification.
6. Users see "Introduced by Andrel" card with Accept + Pass buttons.

### Accepting an Admin Intro

1. User A clicks Accept. 1 free credit deducted. Row: admin_pending → approved.
2. Card updates to "Waiting on [UserB]." State persists on reload (driven by DB).
3. User B receives admin_intro_nudge notification.
4. User B clicks Accept. 1 free credit deducted. Row: admin_pending → approved.
5. Mutual-match fires: matches row (active, admin_facilitated), conversation, icebreakers, system message, mutual_match notifications to both.
6. User B (second acceptor) redirects to /dashboard/network.

### Declining an Admin Intro

1. Either user clicks Pass.
2. Both intro_requests rows for the pair updated to declined.
3. No notification to the other user — silent.
4. Neither user sees the admin intro card anymore.

### Messaging

1. User opens /dashboard/messages.
2. Sees list of conversations (Network-connected pairs). Opportunity-initiated conversations carry a gold "Opportunity" chip + the opportunity title.
3. Opens a conversation — icebreakers render if no user messages exist yet. Header shows the same "Opportunity" chip when applicable.
4. Clicks icebreaker OR types → /api/messages/send inserts message.
5. Other user receives message_received notification.

### Creating an Opportunity (Hiring)

1. Creator clicks **Signal a need** from /dashboard/opportunities. Choose "Hiring."
2. Fills form: title, seniority, role_type multi-select, expertise tags, optional description, optional include-recruiters flag.
3. Submits → POST /api/opportunities/create.
4. Server runs eligibility gate (tier cap, profile complete, etc.). ADMIN_OVERRIDE_EMAILS bypass.
5. Server sanitizes description (stripContactInfo), inserts opportunities row.
6. Matcher runs, delivers opportunity_candidates rows to qualifying users. Fires opportunity_received notifications (subject to 7-day suppression).
7. Creator is redirected to the signal detail page at /dashboard/opportunities/[id].

### Creating an Opportunity (Business Need)

Same as above with a different form: describe the need, choose urgency (low/medium/urgent), pick required expertise tags. Matcher uses NEED_TO_ROLE_TYPES to translate the business category into candidate role_type filters. Delivered under the "provider" role.

### Receiving / Responding to an Opportunity

1. User visits /dashboard/opportunities. Primary "Opportunities for you" surface shows active cards.
2. Clicks the opportunity card → reveals action button: "Open to this" (candidate) / "I can help" (provider) / "I can take this" (recruiter).
3. Click → POST /api/opportunities/respond → opportunity_responses row with status interested. Credit is comped in V1.
4. Creator receives opportunity_response notification.

### Reviewing Responders (Creator)

1. Creator opens /dashboard/opportunities/[id].
2. On load, the page marks all interested responses' seen_by_creator_at. Previously unseen rows render with a gold left-border + "NEW" chip for this render only.
3. Creator sees "People ready to connect" section with responder cards. Each has two actions: **Introduce** and **Not a fit**.
4. Clicking Introduce → Confirm → POST /api/opportunities/introduce → match + conversation created. Responder and creator both get mutual_match notification (linked directly to the conversation). Success banner appears on the page.
5. Clicking Not a fit → "Remove this response from your active list?" confirm → POST /api/opportunities/decline-response → declined_by_creator_at set. Responder disappears from the list. No notification fires.

### Responder's View of an Introduction

1. Responder visits /dashboard/opportunities/responses.
2. Sees the introduction on the list with status "Introduced."
3. Clicks the row → lands on /dashboard/opportunities/responded/[id].
4. Sees read-only opportunity detail with "Introduced on [date]" and a primary "Open conversation" button.
5. Clicks Open conversation → /dashboard/messages/<convId> with system intro message, icebreakers, and gold "Opportunity" chip in the header.

### Closing / Archiving a Signal (Creator)

1. Creator visits /dashboard/opportunities/[id], clicks "Close this signal" → status → 'closed'. Interested responders (not yet introduced) receive opportunity_closed notification.
2. On the /signals list, closed or expired signals show a "Remove" affordance → POST /api/opportunities/archive → archived_at set. Signal disappears from Creator views but matches, conversations, and responder history remain intact.

### Dormancy & Reactivation

1. Creator creates a signal but doesn't visit the detail page for 10 days.
2. Opportunities-maintain cron flips status 'active' → 'dormant'. Silent.
3. Creator eventually returns to the detail page. TouchOnMount fires POST /api/opportunities/touch → status silently reverts to 'active'.

---

## 7. Guardrails

**These must NEVER be built.** If a future prompt or AI suggests any of them, push back.

- **No feeds.** No infinite scroll of posts, activity, or users. Closest to a feed allowed: the 3–8 monthly intros and the curated Opportunities for you surface (capped in practice by scarcity).
- **No public browsing of members.** No search box over profiles. No "discover people" page.
- **No open messaging.** A user cannot message someone they aren't connected to. No cold DMs.
- **No spam loops.** No "invite your friends to get rewards." No bulk email to user's contacts.
- **No marketplaces.** No "hire a consultant" listing page. No open bidding on intros. Opportunities is NOT a marketplace — it is curated creator-driven delivery.
- **No public presence indicators.** No "online now" dots, no "last seen."
- **No like / endorsement features.** Network graph bloats without corresponding signal.
- **No content posting.** No blogs, no "thoughts," no status updates.
- **No public leaderboards.** No "top connectors this month" rankings.
- **No decline transparency.** Never surface "X declined your response" or anything equivalent to the responder. The asymmetric visibility in Opportunities decline is intentional — breaking it would violate the Silent Decline principle.

These guardrails exist because every one of them, however small, pulls Andrel toward LinkedIn or a social app. Andrel's differentiation is that it isn't. Breaking guardrails to hit short-term engagement metrics is a product-killing trade.

---

## 8. UX & Tone Guidelines

### Voice

- **Short.** If it fits in 6 words, use 6 words. "We think you should meet." not "We'd like to introduce you..."
- **Confident.** No hedging. "You're connected." not "You have successfully completed..."
- **Neutral.** No hype language, no excessive emoji, no casual chat tone.
- **Premium.** Typography does heavy lifting. Copy is spare on purpose.
- **Not transactional.** Never remind users how many credits they used.

### Color System

- **Primary navy** #1B2850 — core buttons, headlines, primary identity
- **Accent gold** #C4922A — "curated by Andrel" signals, premium treatment, notification bell badge, Opportunities "Selected for you" + "NEW" + "Opportunity" chips, ReceiverCard left-border accent
- **Gold-tint background** — soft tinted background for curated sections
- **Warm cream** — match insights panels, thoughtful context
- **Red** — reserved for "waiting on you" urgency: unread messages, pending meeting requests, sidebar nav section badges (Messages, Network, Meetings, Opportunities). Do NOT use red for notification bell badge; use gold.
- **Slate grays** — body text, borders, subdued UI

### Component Principles

- Cards feel heavy when they matter (Admin intros: gold border, larger padding. Opportunity ReceiverCards: left-border gold accent on white).
- Accept buttons dominate; Pass/Decline stays available but secondary. This holds for Opportunities Introduce vs Not a fit — Introduce is the bordered primary button; Not a fit is a smaller tertiary gray text link.
- Skeleton states for load, never long spinners.
- Confirmation panels are inline (amber-tint), not modal. Decline uses neutral confirm copy: "Remove this response from your active list?"
- 2-line bio clamp in cards.
- Badge counts cap at "9+".

### Interaction Principles

- Every destructive action requires confirmation, shown inline.
- Undo is rare — lean on "are you sure?" instead.
- Click-through on notifications marks read immediately.
- Waiting states persist via DB, not React state. User reloads and the state is still there.
- **NEW indicators clear on view, not on action.** Opportunities responders marked as seen when the creator views the detail page, regardless of whether they act.


---

## 9. Operational Details

### Environments

- **Development (local):** npm run dev starts Next.js on port 3000 (legacy was 5000; changed April 22 because macOS Control Center hogs 5000). Local Supabase points at the production Supabase project directly (no staging DB). Stripe keys are live — be careful.
- **Production:** Vercel auto-deploys from the main branch. URL: andrel.app.

### Deployment

- Git push to main → Vercel builds and deploys.
- vercel.json configures cron schedules.
- Supabase migrations are applied manually via the Supabase dashboard SQL editor — there is no migration CLI in use. All schema changes should be written to dated files in migrations/ (e.g., migrations/2026-04-23_opportunity_responses_declined.sql) and committed alongside the code that uses them. The Supabase editor's "Run" button executes only the current selection — always Cmd+A (select all) before running a multi-statement script, or only the first statement will execute.

### Environment Variables

Required (placeholders — do not commit real values):
- NEXT_PUBLIC_SUPABASE_URL
- NEXT_PUBLIC_SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY
- STRIPE_PUBLISHABLE_KEY
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- RESEND_API_KEY
- ADMIN_USER_EMAIL (optional override; defaults to bizdev91@gmail.com)

### Cron Jobs (via vercel.json)

- /api/cron/monthly-batch — 0 9 1 * * — Generate new batch for all users on the 1st
- /api/cron/weekly-refresh — 0 9 * * 1 — Send new_batch notifications, refresh
- /api/cron/daily-refill — 0 12 * * * — Refill free credits for subscribed users
- /api/cron/opportunities-maintain — 0 10 * * * — Nudge, dormancy, expiry, close notification sweep for opportunities
- /api/cron/cleanup-expired-requests — Archive stale intro_requests
- /api/cron/nudge-reply — Send nudge_reply notifications

### Admin Workflow (Monthly)

1. On or shortly after the 1st: check /dashboard/admin/batches to see that the new batch generated. If not, run Generate manually.
2. Review the batch: spot-check a handful of suggestions via the Review suggestions UI.
3. Approve the batch: flips it active. Users will receive notifications on the next Monday 9 AM.
4. Throughout the month: use Match Inspector to propose ad-hoc introductions for members who need specific connections. Handle any support issues (block/unblock, restore removed matches).
5. Check Operations periodically: review intro_requests page for any pending support cases.
6. Monitor the Opportunities engine: check for signals with many interested responders sitting without action (opportunity_nudge_creator fires after 5 days, but admin can proactively follow up).

### Test Accounts (Placeholder Format)

Do NOT commit real credentials. Use:

test1@andrel.app / cadre-demo-2026
test2@andrel.app / cadre-demo-2026
admin@andrel.app / (admin-managed)

Current demo accounts live in Supabase auth with password cadre-demo-2026. Do not commit actual passwords to the repository. See Appendix B for live list.

---

## 10. Known Issues / Backlog

### Infrastructure

- **Two parallel Stripe webhook routes exist.** /api/webhooks/stripe (178 lines) and /api/stripe/webhook (114 lines). Only one is configured in the Stripe Dashboard. Identify which, delete the other, document.
- **Two parallel onboarding entry points.** /onboarding (thin shell → OnboardingForm) and /dashboard/onboarding (2-step flow with OnboardingStep1/2). Latter is canonical. Consolidate.
- **OnboardingStep1.tsx.backup** exists alongside the live version. Remove.
- **Cron name vs schedule mismatch (historical).** Renamed weekly-batch → monthly-batch on April 22.
- **Notification check constraint was removed.** notifications_type_check silently rejected every non-whitelisted type. Dropped on April 22. Keep type as free text going forward — schema debt.
- **trust_signals writes silently failed.** Fixed by switching to createAdminClient() and tightening RLS on April 22. Monitor for similar silent-RLS failures in other backend-write tables.

### Product

- **Profile email can drift from auth email** (Elena's case). Admin tools have a fallback via auth.admin.listUsers(). Proper fix: sync trigger or consolidate source of truth.
- **Admin-created matches don't notify users in real time.** After match creation, users get mutual_match notifications but no push/email. Polling-only.
- **Stale polling on deleted conversations.** Browser tabs continue polling /api/messages/list for deleted ids, every 400ms returning 404. ConversationView should stop polling on 404 instead of retrying forever.
- **Meetings page over-renders.** Logs show same query running 4+ times per load.
- **Admin-intro decline has no audit trail beyond timestamps.** No declined_by_user_id field. Add if needed.
- **"Accepted, waiting" state is indefinite.** If second user never responds, first user's card sits there forever. Consider auto-decline after N days.
- **Messages unread count lags behind state.** Server-rendered sidebar count can show stale values — user has opened conversations but the sidebar count doesn't drop until full page reload. Preexisting (not introduced by Opportunities work). Suspect Next.js RSC caching + lack of refresh on client-side navigation.

### Opportunities (open items)

- **OpportunityPreferences component is not wired into /dashboard/settings.** Users' open_to_roles / recruiter flags currently only toggle via SQL or admin path. Gating factor for real users to appear as candidates.
- **Matcher masks delivery errors as 201 + warning.** /api/opportunities/create returns success even when zero candidates were delivered. UI doesn't surface the warning. Either bubble to the creator or fail louder.
- **Suppression suppresses delivery AND notifications.** Currently, users in the 7-day suppression window are excluded from opportunity_candidates entirely — not just from the notification. They can't discover the signal at all for 7 days. Consider splitting into suppressNotificationFor and suppressDeliveryFor (the latter redundant given the delivery ledger already dedupes).
- **profiles.expertise is TEXT storing array literals.** Cost us three silent failures during the Opportunities build (matcher, ResponderRow, and other places). Migrate to text[]. See Appendix A.
- **profiles.role_type vocabulary drift.** 11 distinct values for ~5 canonical roles. Normalize: In-house Counsel, Law firm attorney, Consultant, Compliance, Legal Operations. Also fill the 8 users with NULL role_type.
- **trust_score is a placeholder** — every row is exactly 50. CREATOR_MIN_TRUST_SCORE in caps.ts is effectively a no-op. Update when real scoring ships.
- **Production smoke test on andrel.app** — the full opportunity flow has been verified locally end-to-end. A production-environment smoke test is still pending.
- **Opportunities is hardcoded to legal personas.** ROLE_TYPE_OPTIONS in /new/hiring + NEED_TO_ROLE_TYPES in relevance.ts are legal-specific. Broadening to other professions requires updating both.

### Future / Planned

- **Supply control / ranking** (Prompt #15) — who gets what opportunities, how supply is allocated, how the scorer threshold is tuned. This is the next big opportunities-related engineering work.
- **Real-time notifications** via Supabase Realtime or SSE instead of 30s polling.
- **Admin audit log table** (admin_action_logs) — currently only server logs.
- **Profile modal for in-page profile peeks** — AdminIntroCard click-anywhere behavior pending this.

### Dev Environment Quirks

- **macOS Control Center hogs port 5000.** Dev server runs on port 3000 as of April 22.
- **PostgREST .or() silent-miss bug class.** Using outer parens causes zero-row silent failures. Always use helpers in lib/db/filters.ts.
- **SWC parser strictness.** Avoid return-with-newline-then-chain patterns in TSX.
- **Supabase SQL editor runs only the current selection by default.** Cmd+A before clicking Run on any multi-statement migration.

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

1. Add type string to NotificationType union in lib/notifications/index.ts.
2. Add entry to NOTIFICATION_COPY with short, confident copy.
3. Add entry to LINK_BY_TYPE with destination route.
4. Fire via createNotificationSafe({ userId, type, data, link? }). Use link override only if the destination varies per notification instance.
5. Test that bell displays it and click routes correctly.

No DB migration needed — notifications.type is free text.

### Adding a New Intro Status

1. Decide state transition semantics.
2. Update generate-recommendations.ts exclusion logic (~line 882).
3. Update inspectPair.ts eligibility check.
4. Update /dashboard/introductions/page.tsx if the status should or shouldn't render.
5. No DB migration needed — intro_requests.status is free text.

### Adding a New Admin Action

1. Create endpoint at /api/admin/<action-name>/route.ts.
2. First line: call requireAdmin(), return early on error.
3. Use createAdminClient() for any writes.
4. Log { by: user.email, ...inputs, ...outputs } for traceability.
5. If the action should appear in Match Inspector, extend MatchInspectorClient.tsx conditional button rendering.

### Working With Bidirectional Filters

**ALWAYS** use helpers from lib/db/filters.ts:
- buildBidirectionalMatchFilter(userA, userB) for matches
- buildBidirectionalBlockFilter(userA, userB) for blocked_users
- buildBidirectionalIntroRequestFilter(userA, userB) for intro_requests

Never hand-write filter strings.

### Modifying the Matching Algorithm (Batch)

lib/generate-recommendations.ts is 999 lines. Changes should:
1. Have clear before/after score comparison for at least 3 test users.
2. Not break exclusion logic (matched, blocked, cooldown, hidden, passed, pending intros).
3. Not break tier differentiation.
4. Not change the business solution throttle without product review.

### Modifying the Opportunities Matcher

lib/opportunities/matching.ts — separate from the batch matcher. Changes should:
1. Preserve the strict expertise + role_type filter for business needs.
2. Preserve the 7-day notification suppression window (or split it — see backlog).
3. Preserve recruiter in-network + weekly cap constraints.
4. Not introduce non-deterministic scoring without product review.
5. Not deliver an opportunity to a user who already has an opportunity_candidates row for it (the delivery ledger enforces this; a matcher change should respect it).

### Changing Tier Limits

Change TIER_RECOMMENDATION_COUNTS in lib/generate-recommendations.ts. Audit:
- Stripe pricing vs tier
- Any UI displaying tier benefits
- Existing users' subscription_tier values

For Opportunities tier caps: TIER_OPPORTUNITY_LIMIT in lib/opportunities/caps.ts. Audit the same items.

### Changing Credit Costs

Change deduction amount in the relevant endpoint. Audit:
- Error copy for insufficient credits
- Refill rates in cron/daily-refill
- Tier copy

### When to Write to This Document

After every meaningful product change, update the relevant section here. This doc is the first thing a new contributor (human or AI) should read. If it goes out of date, the whole system suffers.

---

## Appendix A — Known Traps / Silent-Failure Pitfalls

These bugs fail silently — no error surfaces to user or developer.

1. **PostgREST .or() with outer parens.** Wrapping and(...) in outer parens returns zero rows with no error. Use helpers in lib/db/filters.ts.
2. **Filter on read column in notifications.** Column is read_at (timestamp). Use .is('read_at', null).
3. **Filter on onboarding_completed in profiles.** Column is onboarding_complete. Drop the 'd'.
4. **CHECK constraints on text columns.** If a whitelist exists, new values silently fail. Prefer free-text + application-layer validation.
5. **RLS with no INSERT policy.** Writes from createClient() to a table with no matching RLS insert policy silently fail. Use createAdminClient() for backend writes OR add explicit policies.
6. **.limit(1).maybeSingle() chain.** Sometimes returns inconsistent results. Prefer .maybeSingle() alone.
7. **Import-existence checks by substring.** A Python script that checks for a substring in the whole file will always match once JSX usage is inserted. Target the import line specifically with regex.
8. **SWC parser ASI quirk.** return x followed by newline and .method() can be mis-parsed. Inline or store in variable first.
9. **Stripe customer ID drift.** Live mode key rotations leave stale customer IDs in profiles. Checkout fails with "No such customer." Clear stripe_customer_id to let checkout auto-create.
10. **Dev server caching lib/* imports.** Hot-reload sometimes serves stale compiled modules. Solution: rm -rf .next && npm run dev.
11. **Profile email vs auth email drift.** profiles.email can diverge from auth.users.email. Admin tools should fallback via auth.admin.listUsers().
12. **profiles.expertise is TEXT, not TEXT[].** Stores Postgres array literals like `{privacy,"data protection",regulatory}` as strings. Application code MUST parse this at read time. Treating it as an array causes `TypeError: .map is not a function` or `.filter is not a function` — errors that may surface in either the matcher or the UI depending on where the mis-assumption lives. Canonical parser is inlined in lib/opportunities/matching.ts (parseExpertise) and components/opportunities/ResponderRow.tsx. When building anything new that reads expertise, use or import an equivalent parser. Long-term: migrate the column to text[] (see backlog).
13. **PostgREST requires double-quotes around camelCase columns in .select().** profiles has `networkValueScore` and `responsivenessScore` (camelCase). Without quotes, PostgREST lowercases and doesn't find the column, and the query fails silently or returns null for those fields. Always quote: `.select('id, "networkValueScore", "responsivenessScore"')`.
14. **Supabase SQL editor runs only the current selection.** On a multi-statement migration file, pressing Run executes only the first statement or the currently-highlighted selection. Always Cmd+A to select all before Run, or statements will be silently skipped with a "Success. No rows returned" message that looks like success but only covered the first statement.
15. **Mixed `??` and `||` without parens.** JavaScript parser rejects `a ?? b || c` as ambiguous. Use `(a ?? b) || c`. Tripped us during the link-override rollout in lib/notifications/index.ts.
16. **zsh history expansion on `!`.** Bare `!` in pasted JS/regex triggers zsh history expansion before the heredoc body reaches Node. Symptom: "event not found" errors, or entire multi-line commands being silently dropped. Use single-quoted heredoc markers (`'RUNEOF'`) AND prefer `node > /tmp/nothing.txt << 'RUNEOF' ... RUNEOF` over `cat > file << EOF ... EOF` which lets shell pre-processing interfere.
17. **Next.js API route module cache.** After creating a new /api route file, Next.js usually picks it up live. In rare cases (nested dynamic segments, heavy module graph) it requires `rm -rf .next && npm run dev` to rescan.
18. **Orphaned port 3000 after SIGINT.** When the dev server is killed uncleanly, the next `npm run dev` fails with `EADDRINUSE`. Clear with `lsof -ti :3000 | xargs kill -9`.
19. **opportunities.criteria lives in jsonb.** The opportunity's expertise filter is under `criteria.expertise`, not a top-level column. Matcher code reads `o.criteria.expertise` — application code building queries against expertise must go through jsonb operators.

---

## Appendix B — Test Accounts

Use placeholder format for any new commits:

test1@andrel.app / cadre-demo-2026
test2@andrel.app / cadre-demo-2026

Current demo accounts live in the Supabase auth user table with password cadre-demo-2026. Do not commit actual passwords to the repository.

Admin account: bizdev91@gmail.com — password managed by the operator.

---

## Appendix C — Admin Routines

### Monthly (required)
- Verify batch generated on the 1st.
- Approve the batch (/dashboard/admin/batches → Approve).

### Weekly (recommended)
- Review intro_requests volume and resolution rate.
- Spot-check notification delivery via bell UI.
- Check for stuck admin intros (admin_pending older than 14 days).
- Review active opportunities: identify creator signals with interested responders that have sat past 5 days (opportunity_nudge_creator handles this, but admin can proactively escalate high-value ones).

### As needed
- Use Match Inspector to propose intros for high-value members.
- Unblock / restore matches on request (with confirmation).
- Update scoring thresholds in generate-recommendations.ts if distribution feels off.
- Review waitlist queue; send invites.
- Clear 7-day notification suppression for a specific user during testing: `delete from notifications where user_id = <id> and type in ('opportunity_received', 'recruiter_request') and created_at > now() - interval '7 days'`. Then create a new opportunity to trigger re-delivery.

### Data hygiene (quarterly)
- Archive stale suggested intros older than 90 days.
- Review admin_action_logs table (when built).
- Run an audit of RLS policies via Supabase Security Advisor.
- Check for dead CHECK constraints on free-text enum columns.
- Review opportunities with high archived_at counts — if many creators archive without introducing anyone, the matcher's delivery may be misaligned.

---

*End of document. Update as the system evolves.*
