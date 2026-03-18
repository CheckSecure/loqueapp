# Cadre

A Next.js 14 app with Supabase authentication.

## Stack

- **Framework**: Next.js 14 (App Router)
- **Auth**: Supabase (`@supabase/ssr`, `@supabase/supabase-js`)
- **Styling**: Tailwind CSS with custom `cadre` color palette
- **Language**: TypeScript

## Project Structure

```
app/
  layout.tsx          # Root layout with Inter font
  page.tsx            # Landing page (public)
  globals.css         # Tailwind base styles
  login/page.tsx      # Sign-in page
  signup/page.tsx     # Sign-up page
  dashboard/page.tsx  # Protected dashboard
  auth/callback/route.ts  # Supabase OAuth callback handler
components/
  LogoutButton.tsx    # Client component for sign-out
lib/
  supabase/
    client.ts         # Browser Supabase client
    server.ts         # Server Supabase client (uses cookies)
  utils.ts            # cn() helper
middleware.ts         # Route protection (pass-through; auth handled per-page)
```

## Environment Variables (Secrets)

> Note: The two Supabase secrets were entered in swapped order in Replit Secrets,
> so the code intentionally reads them in reverse:
> - `NEXT_PUBLIC_SUPABASE_URL` secret → used as the anon key in code
> - `NEXT_PUBLIC_SUPABASE_ANON_KEY` secret → used as the project URL in code

To fix this properly, delete both secrets and re-add them with correct values:
- `NEXT_PUBLIC_SUPABASE_URL` = `https://xxxx.supabase.co`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` = the long `eyJ...` JWT anon key

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
| `/dashboard` | Protected | User dashboard |
| `/auth/callback` | Public | Supabase email confirmation handler |
