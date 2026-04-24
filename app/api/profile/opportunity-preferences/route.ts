import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * PATCH /api/profile/opportunity-preferences
 *
 * Accepts a partial JSON body with any subset of:
 *   - open_to_roles: boolean
 *   - open_to_business_solutions: boolean
 *   - recruiter: boolean
 *
 * Updates only the provided fields on the authenticated user's profile.
 * Silently ignores any other keys for safety.
 *
 * The OpportunityPreferences component auto-saves on toggle, one field per
 * request. We accept either POST (what the component uses today) or PATCH
 * for future callers.
 */

const ALLOWED_FIELDS = [
  'open_to_roles',
  'open_to_business_solutions',
  'recruiter',
] as const;

type AllowedField = (typeof ALLOWED_FIELDS)[number];

async function updatePreferences(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const updates: Partial<Record<AllowedField, boolean>> = {};
  for (const key of ALLOWED_FIELDS) {
    if (key in body) {
      const value = body[key];
      if (typeof value !== 'boolean') {
        return NextResponse.json(
          { error: `${key} must be boolean` },
          { status: 400 }
        );
      }
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: 'No valid fields to update' },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from('profiles')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', user.id)
    .select('open_to_roles, open_to_business_solutions, recruiter')
    .single();

  if (error) {
    console.error('[profile/opportunity-preferences] update failed', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, profile: data });
}

export async function POST(req: Request) {
  return updatePreferences(req);
}

export async function PATCH(req: Request) {
  return updatePreferences(req);
}
