# Cadre — Professional Networking App

A Next.js 14 professional networking app with Supabase authentication and Replit PostgreSQL for application data.

## Stack

- **Framework**: Next.js 14 (App Router)
- **Authentication**: Supabase (`@supabase/ssr`, `@supabase/supabase-js`)
- **Database**: Replit built-in PostgreSQL (`pg` package, `DATABASE_URL` env)
- **Styling**: Tailwind CSS
- **Language**: TypeScript

## Architecture

- **Supabase** handles authentication only (login, signup, JWT session management)
- **Replit PostgreSQL** stores all application data: profiles, introductions, conversations, messages, meetings
- Server components query the database directly via the `pg` pool in `lib/db.ts`
- Client components call server actions in `app/actions.ts` for mutations

## Important Note on Supabase Credentials

The Supabase secrets were entered in swapped order in Replit Secrets:
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` secret → contains the project URL
- `NEXT_PUBLIC_SUPABASE_URL` secret → contains the anon key (JWT)

All Supabase client files in `lib/supabase/` read the env vars in reverse order to compensate.

## Database Schema

Tables in Replit PostgreSQL:
- `profiles` — user profiles (id = Supabase user UUID)
- `introductions` — intro requests between users (pending/accepted/declined)
- `conversations` — message threads
- `conversation_participants` — many-to-many: users ↔ conversations
- `messages` — individual messages within conversations
- `meetings` — scheduled calls and in-person meetings

Run migrations: `node scripts/migrate.js`

## Project Structure

```
app/
  layout.tsx                        # Root layout with Inter font
  page.tsx                          # Public landing page
  globals.css                       # Tailwind base styles
  login/page.tsx                    # Sign-in page
  signup/page.tsx                   # Sign-up page
  auth/callback/route.ts            # Supabase OAuth callback
  actions.ts                        # All server actions (mutations via pg)
  dashboard/
    layout.tsx                      # Protected layout — upserts profile, passes sidebar data
    page.tsx                        # Redirects to /dashboard/introductions
    introductions/page.tsx          # Real data from PostgreSQL
    messages/page.tsx               # Real data from PostgreSQL
    meetings/page.tsx               # Real data from PostgreSQL
    profile/page.tsx                # Real data from PostgreSQL
components/
  Sidebar.tsx                       # Responsive sidebar with nav + sign-out
  IntroductionActions.tsx           # Accept/Decline buttons (client)
  RequestIntroButton.tsx            # Request intro button (client)
  MessagesClient.tsx                # Full messaging UI (client)
  MeetingsClient.tsx                # Meetings list + calendar toggle (client)
  ScheduleMeetingModal.tsx          # Schedule meeting form (client)
  ProfileForm.tsx                   # Profile edit form (client)
lib/
  db.ts                             # pg Pool using DATABASE_URL
  supabase/
    client.ts                       # Browser Supabase client (keys swapped)
    server.ts                       # Server Supabase client (keys swapped)
  utils.ts                          # cn() helper
middleware.ts                       # Pass-through (auth handled per-page)
scripts/
  migrate.js                        # Database migration script
```

## Running

```bash
npm run dev   # starts on port 5000
node scripts/migrate.js  # run DB migrations
```

## Pages

| Route | Access | Description |
|-------|--------|-------------|
| `/` | Public | Landing page |
| `/login` | Public | Sign in |
| `/signup` | Public | Create account |
| `/dashboard/introductions` | Protected | Browse & request warm introductions |
| `/dashboard/messages` | Protected | Conversations with connections |
| `/dashboard/meetings` | Protected | Scheduled calls and meetings |
| `/dashboard/profile` | Protected | Edit your professional profile |
| `/auth/callback` | Public | Supabase email confirmation handler |
