# Cadre — Professional Networking App

A Next.js 14 professional networking app backed entirely by Supabase.

## Stack

- **Framework**: Next.js 14 (App Router)
- **Authentication**: Supabase (`@supabase/ssr`)
- **Database**: Supabase PostgreSQL (all tables)
- **Styling**: Tailwind CSS
- **Language**: TypeScript

## Important: Supabase Credential Swap

The Supabase secrets were entered in swapped order in Replit Secrets:
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` secret → actually holds the **project URL**
- `NEXT_PUBLIC_SUPABASE_URL` secret → actually holds the **anon key** (JWT)

All Supabase client files (`lib/supabase/client.ts`, `lib/supabase/server.ts`) intentionally read the env vars in reverse order to compensate. **Do not "fix" this or authentication will break.**

## Database Schema (in Supabase)

- `profiles` — user profiles (id = Supabase auth user UUID). Columns: `full_name, title, company, location, bio, expertise, intro_preferences, open_to_intros, seniority, role_type, mentorship_role`. **No `avatar_color` column** — avatar colors are computed from the user ID via `pickColor()` in each component.
- `introductions` — intro requests between users (status: pending/accepted/declined)
- `conversations` — message threads
- `conversation_participants` — many-to-many: users ↔ conversations
- `messages` — individual messages in conversations
- `meetings` — scheduled calls and in-person meetings

## Architecture

- Server components call Supabase directly via `lib/supabase/server.ts`
- Client components call server actions in `app/actions.ts` for mutations
- Auth session is handled via cookie-based Supabase SSR client
- RLS policies on all tables enforce user-level data isolation

## Project Structure

```
app/
  layout.tsx                        # Root layout
  page.tsx                          # Public landing page
  login/page.tsx                    # Sign-in page
  signup/page.tsx                   # Sign-up page
  auth/callback/route.ts            # Supabase email confirmation handler
  actions.ts                        # All server actions (Supabase mutations)
  dashboard/
    layout.tsx                      # Protected — checks auth, upserts profile, renders sidebar
    page.tsx                        # Redirects to /dashboard/introductions
    introductions/page.tsx          # Pending requests + profile suggestions
    messages/page.tsx               # Conversations list + message thread
    meetings/page.tsx               # Upcoming + past meetings (clickable cards → detail modal)
    profile/page.tsx                # Editable user profile
    profile/[id]/page.tsx           # Read-only member profile view
components/
  Sidebar.tsx                       # Responsive nav sidebar with sign-out
  MobileNav.tsx                     # Mobile top header + bottom tab nav
  IntroductionActions.tsx           # Accept/Decline buttons (client component)
  RequestIntroButton.tsx            # Request intro button (client component)
  MessagesClient.tsx                # Full messaging UI (client component)
  MeetingsClient.tsx                # Meetings list + schedule modal + detail modal
  MeetingDetailModal.tsx            # Slide-up/side-panel meeting detail view
  ScheduleMeetingModal.tsx          # Schedule meeting form modal
  ProfileForm.tsx                   # Profile edit form (client component)
lib/
  supabase/
    client.ts                       # Browser Supabase client (env vars swapped intentionally)
    server.ts                       # Server Supabase client (env vars swapped intentionally)
  utils.ts                          # cn() Tailwind helper
middleware.ts                       # Pass-through middleware (auth handled per-page)
```

## Running

```bash
npm run dev   # starts on port 5000
```
