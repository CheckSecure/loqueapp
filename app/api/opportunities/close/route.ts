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
  const { data: opp } = await admin
    .from('opportunities')
    .select('id, creator_id, status')
    .eq('id', body.opportunity_id)
    .maybeSingle();

  if (!opp) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  if (opp.creator_id !== user.id) {
    return NextResponse.json({ error: 'Not your opportunity.' }, { status: 403 });
  }
  if (opp.status === 'closed' || opp.status === 'expired') {
    return NextResponse.json({ status: opp.status }, { status: 200 });
  }

  const { error } = await admin
    .from('opportunities')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('id', body.opportunity_id);

  if (error) {
    console.error('[opportunities/close] failed', { by: user.email, err: error });
    return NextResponse.json({ error: 'Could not close.' }, { status: 500 });
  }

  return NextResponse.json({ status: 'closed' }, { status: 200 });
}
