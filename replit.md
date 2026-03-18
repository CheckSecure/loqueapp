# Cadre — Professional Networking App

A Next.js 14 professional networking app with Supabase authentication.

## Stack

- **Framework**: Next.js 14 (App Router)
- **Auth**: Supabase (`@supabase/ssr`, `@supabase/supabase-js`)
- **Styling**: Tailwind CSS
- **Language**: TypeScript

## Project Structure

```
app/
  layout.tsx                        # Root layout with Inter font
  page.tsx                          # Public landing page
  globals.css                       # Tailwind base styles
  login/page.tsx                    # Sign-in page
  signup/page.tsx                   # Sign-up page with email confirmation
  auth/callback/route.ts            # Supabase OAuth callback handler
  dashboard/
    layout.tsx                      # Protected layout — redirects to /login if unauthed
    page.tsx                        # Redirects to /dashboard/introductions
    introductions/page.tsx          # Introductions feed + suggestions
    messages/page.tsx               # Messaging UI (client component)
    meetings/page.tsx               # Meetings list + calendar view
    profile/page.tsx                # User profile editor
components/
  Sidebar.tsx                       # Responsive sidebar with nav + sign-out
lib/
  supabase/
    client.ts                       # Browser Supabase client
    server.ts                       # Server Supabase client (uses cookies)
  utils.ts                          # cn() helper
middleware.ts                       # Pass-through (auth handled per-page)
```

## Environment Variables (Secrets)

> Note: The Supabase secrets were entered in swapped order in Replit Secrets,
> so the code reads them in reverse intentionally:
> - `NEXT_PUBLIC_SUPABASE_ANON_KEY` secret → used as the project URL in code
> - `NEXT_PUBLIC_SUPABASE_URL` secret → used as the anon key in code

## Running

```bash
npm run dev   # starts on port 5000
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
