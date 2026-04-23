import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { opportunity_id?: string };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }); }

  if (!body.opportunity_id) {
    return NextResponse.json({ error: 'opportunity_id required.' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from('opportunity_candidates')
    .update({ dismissed_at: new Date().toISOString() })
    .eq('opportunity_id', body.opportunity_id)
    .eq('user_id', user.id)
    .is('dismissed_at', null);

  if (error) {
    console.error('[opportunities/dismiss] failed', { by: user.email, err: error });
    return NextResponse.json({ error: 'Could not dismiss.' }, { status: 500 });
  }

  return NextResponse.json({ status: 'dismissed' }, { status: 200 });
}
