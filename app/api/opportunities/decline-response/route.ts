import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { response_id?: string };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }); }

  if (!body.response_id) {
    return NextResponse.json({ error: 'response_id required.' }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: response } = await admin
    .from('opportunity_responses')
    .select('id, status, declined_by_creator_at, opportunities!inner(creator_id)')
    .eq('id', body.response_id)
    .maybeSingle();

  if (!response) {
    return NextResponse.json({ error: 'Response not found.' }, { status: 404 });
  }
  if ((response as any).opportunities.creator_id !== user.id) {
    return NextResponse.json({ error: 'Not your opportunity.' }, { status: 403 });
  }
  if (response.status !== 'interested') {
    return NextResponse.json({ error: 'Only pending responses can be declined.' }, { status: 409 });
  }
  if (response.declined_by_creator_at) {
    return NextResponse.json({ status: 'declined' }, { status: 200 });
  }

  const { error } = await admin
    .from('opportunity_responses')
    .update({ declined_by_creator_at: new Date().toISOString() })
    .eq('id', body.response_id);

  if (error) {
    console.error('[opportunities/decline-response] failed', { by: user.email, err: error });
    return NextResponse.json({ error: 'Could not decline.' }, { status: 500 });
  }

  return NextResponse.json({ status: 'declined' }, { status: 200 });
}
