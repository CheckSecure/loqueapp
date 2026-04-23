import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { RESPONSE_CAP, RECRUITER_WEEKLY_CAP } from '@/lib/opportunities/caps';

function isoWeekStart(d = new Date()): string {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  if (day !== 1) copy.setUTCDate(copy.getUTCDate() - (day - 1));
  return copy.toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { opportunity_id?: string };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }); }

  const opportunityId = body.opportunity_id;
  if (!opportunityId) {
    return NextResponse.json({ error: 'opportunity_id required.' }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: opp } = await admin
    .from('opportunities')
    .select('id, creator_id, type, status, expires_at, include_recruiters')
    .eq('id', opportunityId)
    .maybeSingle();

  if (!opp) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  if (opp.status !== 'active') {
    return NextResponse.json({ error: 'This opportunity is no longer open.' }, { status: 410 });
  }
  if (new Date(opp.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: 'This opportunity has expired.' }, { status: 410 });
  }
  if (opp.creator_id === user.id) {
    return NextResponse.json({ error: 'Cannot respond to your own opportunity.' }, { status: 400 });
  }

  const { data: candidate } = await admin
    .from('opportunity_candidates')
    .select('id, dismissed_at, role')
    .eq('opportunity_id', opportunityId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!candidate) {
    return NextResponse.json({ error: 'Not eligible.' }, { status: 403 });
  }
  if (candidate.dismissed_at) {
    return NextResponse.json({ error: 'You already dismissed this.' }, { status: 400 });
  }

  const role = candidate.role as 'candidate' | 'provider' | 'recruiter';
  const cap =
    role === 'recruiter'
      ? RESPONSE_CAP.recruiter
      : role === 'candidate'
      ? RESPONSE_CAP.hiring
      : RESPONSE_CAP.business;

  const { count: existingCount } = await admin
    .from('opportunity_responses')
    .select('id', { count: 'exact', head: true })
    .eq('opportunity_id', opportunityId)
    .eq('role', role)
    .in('status', ['interested', 'introduced']);

  if ((existingCount ?? 0) >= cap) {
    return NextResponse.json({ error: 'Responses closed.' }, { status: 409 });
  }

  if (role === 'recruiter') {
    const week = isoWeekStart();
    const { data: activity } = await admin
      .from('recruiter_activity')
      .select('responses_sent')
      .eq('user_id', user.id)
      .eq('week_starting', week)
      .maybeSingle();
    if ((activity?.responses_sent ?? 0) >= RECRUITER_WEEKLY_CAP) {
      return NextResponse.json(
        { error: 'You have reached your weekly recruiter response limit.' },
        { status: 429 }
      );
    }
  }

  const { data: existing } = await admin
    .from('opportunity_responses')
    .select('id, status')
    .eq('opportunity_id', opportunityId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ status: existing.status, id: existing.id }, { status: 200 });
  }

  await admin.from('credit_transactions').insert({
    user_id: user.id,
    amount: 0,
    type: 'opportunity_interested_comped',
    reference_id: opportunityId,
    note: 'launch_phase',
  });
  const comped = true;

  const { data: inserted, error: respErr } = await admin
    .from('opportunity_responses')
    .insert({
      opportunity_id: opportunityId,
      user_id: user.id,
      role,
      status: 'interested',
      credit_comped: comped,
    })
    .select('id')
    .single();

  if (respErr || !inserted) {
    console.error('[opportunities/respond] insert failed', { by: user.email, err: respErr });
    return NextResponse.json({ error: 'Could not record response.' }, { status: 500 });
  }

  if (role === 'recruiter') {
    const week = isoWeekStart();
    const { data: existingRow } = await admin
      .from('recruiter_activity')
      .select('responses_sent')
      .eq('user_id', user.id)
      .eq('week_starting', week)
      .maybeSingle();
    if (existingRow) {
      await admin
        .from('recruiter_activity')
        .update({ responses_sent: existingRow.responses_sent + 1 })
        .eq('user_id', user.id)
        .eq('week_starting', week);
    } else {
      await admin
        .from('recruiter_activity')
        .insert({ user_id: user.id, week_starting: week, responses_sent: 1 });
    }
  }

  const { createNotificationSafe } = await import('@/lib/notifications');
  await createNotificationSafe({
    userId: opp.creator_id,
    type: 'opportunity_response',
    data: { opportunity_id: opportunityId, responder_id: user.id },
  });

  // Observability
  const { logEvent } = await import('@/lib/opportunities/events');
  await logEvent({
    eventType: 'response_clicked',
    opportunityId: opportunityId,
    userId: user.id,
    metadata: { role },
  });

  return NextResponse.json({ status: 'interested', id: inserted.id, comped }, { status: 201 });
}
