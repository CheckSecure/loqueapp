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

  if (!opp || opp.creator_id !== user.id) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const update: Record<string, unknown> = { last_creator_visit_at: new Date().toISOString() };
  if (opp.status === 'dormant') {
    update.status = 'active';
    update.dormant_at = null;
  }

  await admin.from('opportunities').update(update).eq('id', body.opportunity_id);
  return NextResponse.json({ ok: true }, { status: 200 });
}
