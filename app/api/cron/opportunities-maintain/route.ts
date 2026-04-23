import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  INACTIVITY_NUDGE_DAYS,
  DORMANCY_DAYS,
  NUDGE_REPEAT_BLACKOUT_DAYS,
} from '@/lib/opportunities/caps';

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const admin = createAdminClient();
  const now = Date.now();
  const nudgeCutoff = new Date(now - INACTIVITY_NUDGE_DAYS * 86400_000).toISOString();
  const dormancyCutoff = new Date(now - DORMANCY_DAYS * 86400_000).toISOString();
  const nudgeBlackoutCutoff = new Date(now - NUDGE_REPEAT_BLACKOUT_DAYS * 86400_000).toISOString();
  const nowIso = new Date(now).toISOString();

  const { data: nudgeCandidates } = await admin
    .from('opportunities')
    .select('id, creator_id, last_creator_visit_at')
    .eq('status', 'active')
    .lt('last_creator_visit_at', nudgeCutoff)
    .gt('last_creator_visit_at', dormancyCutoff);

  let nudgesFired = 0;
  if (nudgeCandidates && nudgeCandidates.length > 0) {
    const { createNotificationSafe } = await import('@/lib/notifications');
    for (const opp of nudgeCandidates) {
      const { count: waitingCount } = await admin
        .from('opportunity_responses')
        .select('id', { count: 'exact', head: true })
        .eq('opportunity_id', opp.id)
        .eq('status', 'interested');
      if ((waitingCount ?? 0) === 0) continue;

      const { data: recentNudges } = await admin
        .from('notifications')
        .select('id, data')
        .eq('user_id', opp.creator_id)
        .eq('type', 'opportunity_nudge_creator')
        .gte('created_at', nudgeBlackoutCutoff);

      const alreadyNudged = (recentNudges ?? []).some(
        (n) => (n.data as any)?.opportunity_id === opp.id
      );
      if (alreadyNudged) continue;

      await createNotificationSafe({
        userId: opp.creator_id,
        type: 'opportunity_nudge_creator',
        data: { opportunity_id: opp.id, waiting_count: waitingCount },
      });
      nudgesFired++;
    }
  }

  const { data: dormancyResults, error: dormantErr } = await admin
    .from('opportunities')
    .update({ status: 'dormant', dormant_at: nowIso })
    .eq('status', 'active')
    .lt('last_creator_visit_at', dormancyCutoff)
    .select('id');
  if (dormantErr) console.error('[opportunities-maintain] dormancy update failed', dormantErr);
  const dormancyCount = dormancyResults?.length ?? 0;

  let closureNotices = 0;
  if (dormancyResults && dormancyResults.length > 0) {
    const { createNotificationSafe } = await import('@/lib/notifications');
    for (const opp of dormancyResults) {
      const { data: waitingResponders } = await admin
        .from('opportunity_responses')
        .select('user_id')
        .eq('opportunity_id', opp.id)
        .eq('status', 'interested');
      if (!waitingResponders?.length) continue;
      await Promise.all(
        waitingResponders.map((r) =>
          createNotificationSafe({
            userId: r.user_id,
            type: 'opportunity_closed',
            data: { opportunity_id: opp.id, reason: 'dormant' },
          })
        )
      );
      closureNotices += waitingResponders.length;
    }
  }

  const { data: expiryResults, error: expiryErr } = await admin
    .from('opportunities')
    .update({ status: 'expired' })
    .in('status', ['active', 'dormant'])
    .lt('expires_at', nowIso)
    .select('id');
  if (expiryErr) console.error('[opportunities-maintain] expiry update failed', expiryErr);
  const expiredCount = expiryResults?.length ?? 0;

  const summary = {
    nudges_fired: nudgesFired,
    dormant: dormancyCount,
    closure_notices: closureNotices,
    expired: expiredCount,
  };
  console.log('[opportunities-maintain] summary', summary);
  return NextResponse.json(summary);
}
