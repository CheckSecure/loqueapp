import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { connectOpportunityResponder } from '@/lib/opportunities/connect';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { opportunity_id?: string; user_id?: string };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }); }

  const { opportunity_id, user_id } = body;
  if (!opportunity_id || !user_id) {
    return NextResponse.json({ error: 'opportunity_id and user_id required.' }, { status: 400 });
  }

  const result = await connectOpportunityResponder({
    opportunityId: opportunity_id,
    creatorId: user.id,
    responderId: user_id,
  });

  if (!result.ok) {
    console.log('[opportunities/introduce] rejected', {
      by: user.email,
      opportunity_id,
      user_id,
      code: result.code,
    });

    const guardCodes = new Set(['already_connected', 'intro_pending', 'cooldown', 'blocked']);
    const publicMessage = guardCodes.has(result.code)
      ? 'Connection already exists or is in progress.'
      : result.message;

    const status =
      result.code === 'not_creator' ? 403
      : result.code === 'opportunity_not_found' ? 404
      : result.code === 'internal' ? 500
      : 409;
    return NextResponse.json({ error: publicMessage, code: result.code }, { status });
  }

  console.log('[opportunities/introduce] success', {
    by: user.email,
    opportunity_id,
    user_id,
    match_id: result.match_id,
  });

  // Observability
  const { logEvent } = await import('@/lib/opportunities/events');
  await logEvent({
    eventType: 'connection_made',
    opportunityId: opportunity_id,
    userId: user_id,
    metadata: { creator_id: user.id, match_id: result.match_id },
  });

  return NextResponse.json(
    { match_id: result.match_id, conversation_id: result.conversation_id },
    { status: 201 }
  );
}
