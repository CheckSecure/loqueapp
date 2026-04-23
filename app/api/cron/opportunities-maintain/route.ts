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

  // ------------------------------------------------------------
  // Prompt #15 Step 6: Tranche 2 firing
  // ------------------------------------------------------------
  // Any opportunity scheduled for tranche 2 and past its scheduled time,
  // where the creator has NOT yet introduced anyone, gets a fresh matcher
  // run that can deliver up to 2 more candidates.
  let tranche2Fired = 0;
  let tranche2Skipped = 0;

  const { data: tranche2Eligible } = await admin
    .from('opportunities')
    .select('id, creator_id, type, include_recruiters, criteria, tranche_2_scheduled_at')
    .eq('status', 'active')
    .is('archived_at', null)
    .not('tranche_2_scheduled_at', 'is', null)
    .lte('tranche_2_scheduled_at', nowIso);

  if (tranche2Eligible && tranche2Eligible.length > 0) {
    const { deliverOpportunity } = await import('@/lib/opportunities/matching');
    for (const opp of tranche2Eligible) {
      // Check: has creator already introduced anyone from tranche 1?
      const { data: intros } = await admin
        .from('matches')
        .select('id')
        .eq('opportunity_id', opp.id)
        .eq('is_opportunity_initiated', true)
        .limit(1);
      const hasIntro = !!intros && intros.length > 0;

      if (hasIntro) {
        // Clear scheduled flag without firing tranche 2.
        await admin
          .from('opportunities')
          .update({ tranche_2_scheduled_at: null })
          .eq('id', opp.id);
        tranche2Skipped++;
        continue;
      }

      try {
        await deliverOpportunity(opp as any, { tranche: 2 });
        tranche2Fired++;
      } catch (err) {
        console.error('[opportunities-maintain] tranche 2 delivery failed', {
          opportunity_id: opp.id,
          err,
        });
      } finally {
        // Always clear the scheduled flag so we don't retry daily.
        await admin
          .from('opportunities')
          .update({ tranche_2_scheduled_at: null })
          .eq('id', opp.id);
      }
    }
  }

    // ------------------------------------------------------------
  // Prompt #15 Step 8: Soft nudge for silent delivery
  // ------------------------------------------------------------
  // Find users with >= 2 unseen (viewed_at IS NULL) opportunity_candidates rows
  // where the underlying opportunity is still active. Fire opportunity_nudge_receiver,
  // gated by shouldNotify() so the 5-day cooldown applies.
  let softNudgesFired = 0;

  const { data: unseenRows } = await admin
    .from('opportunity_candidates')
    .select('user_id, opportunity_id, opportunities!inner(status, archived_at)')
    .is('viewed_at', null)
    .is('dismissed_at', null)
    .eq('opportunities.status', 'active')
    .is('opportunities.archived_at', null);

  if (unseenRows && unseenRows.length > 0) {
    // Exclude opportunities the user has responded to.
    const userIds = Array.from(new Set(unseenRows.map((r: any) => r.user_id)));
    const { data: responses } = await admin
      .from('opportunity_responses')
      .select('user_id, opportunity_id')
      .in('user_id', userIds);
    const respondedKeys = new Set(
      (responses ?? []).map((r: any) => `${r.user_id}:${r.opportunity_id}`)
    );

    const unseenByUser = new Map<string, number>();
    for (const row of unseenRows) {
      const r = row as any;
      if (respondedKeys.has(`${r.user_id}:${r.opportunity_id}`)) continue;
      unseenByUser.set(r.user_id, (unseenByUser.get(r.user_id) ?? 0) + 1);
    }

    const { shouldNotify } = await import('@/lib/opportunities/notifications');
    const { createNotificationSafe } = await import('@/lib/notifications');

    for (const [uid, count] of unseenByUser.entries()) {
      if (count < 2) continue;
      const allow = await shouldNotify(uid, 'opportunity_nudge_receiver');
      if (!allow) continue;
      await createNotificationSafe({
        userId: uid,
        type: 'opportunity_nudge_receiver',
        data: { unseen_count: count },
      });
      softNudgesFired++;
    }
  }

    // ------------------------------------------------------------
  // Prompt #15 Step 9: Retry logic for zero-delivery opportunities
  // ------------------------------------------------------------
  // Opportunities that delivered 0 candidates on creation get re-matched:
  //   - daily for the first 7 days
  //   - weekly from day 7 to day 28
  //   - paused thereafter (existing expiry handles eventual cleanup)
  // A successful retry delivers as tranche 1 and schedules tranche 2 at +48h.
  let retriesFired = 0;
  let retriesSucceeded = 0;

  const retryWindowStart = new Date(Date.now() - 28 * 86400_000).toISOString();
  const dailyCutoff = new Date(Date.now() - 86400_000).toISOString();
  const weeklyCutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  const { data: retryCandidates } = await admin
    .from('opportunities')
    .select('id, creator_id, type, include_recruiters, criteria, created_at, last_matcher_run_at')
    .eq('status', 'active')
    .is('archived_at', null)
    .gte('created_at', retryWindowStart);

  if (retryCandidates && retryCandidates.length > 0) {
    // Filter to zero-delivery opps (never produced a candidate row).
    const oppIds = retryCandidates.map((o: any) => o.id);
    const { data: anyDelivered } = await admin
      .from('opportunity_candidates')
      .select('opportunity_id')
      .in('opportunity_id', oppIds);
    const deliveredSet = new Set(
      (anyDelivered ?? []).map((r: any) => r.opportunity_id)
    );
    const zeroDelivery = retryCandidates.filter((o: any) => !deliveredSet.has(o.id));

    const { deliverOpportunity } = await import('@/lib/opportunities/matching');
    const { TRANCHE_2_DELAY_HOURS } = await import('@/lib/opportunities/caps');

    for (const opp of zeroDelivery) {
      const createdAt = new Date(opp.created_at).getTime();
      const daysSinceCreation = (Date.now() - createdAt) / 86400_000;
      const lastRunAt = opp.last_matcher_run_at;

      // Determine cadence. Days 0-7: daily; Days 7-28: weekly; >28: skip.
      let dueNow = false;
      if (daysSinceCreation < 7) {
        // Daily cadence — retry if last run > 24h ago (or never)
        dueNow = !lastRunAt || lastRunAt < dailyCutoff;
      } else if (daysSinceCreation < 28) {
        // Weekly cadence — retry if last run > 7 days ago
        dueNow = !lastRunAt || lastRunAt < weeklyCutoff;
      }
      if (!dueNow) continue;

      try {
        const result = await deliverOpportunity(opp as any, { tranche: 1 });
        retriesFired++;
        const delivered = result.candidatesNotified + result.recruitersNotified;

        if (delivered > 0) {
          retriesSucceeded++;
          // Retry hit — schedule tranche 2 48h from now.
          const scheduledAt = new Date(
            Date.now() + TRANCHE_2_DELAY_HOURS * 3600_000
          ).toISOString();
          await admin
            .from('opportunities')
            .update({ tranche_2_scheduled_at: scheduledAt })
            .eq('id', opp.id);
        } else {
          // Still zero. Bump retry_count for observability.
          // Re-fetch retry_count to avoid stale reads on concurrent runs.
          const { data: current } = await admin
            .from('opportunities')
            .select('retry_count')
            .eq('id', opp.id)
            .maybeSingle();
          const nextCount = (current?.retry_count ?? 0) + 1;
          await admin
            .from('opportunities')
            .update({ retry_count: nextCount })
            .eq('id', opp.id);
        }
      } catch (err) {
        console.error('[opportunities-maintain] retry delivery failed', {
          opportunity_id: opp.id,
          err,
        });
      }
    }
  }

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
    tranche_2_fired: tranche2Fired,
    tranche_2_skipped: tranche2Skipped,
    retries_fired: retriesFired,
    retries_succeeded: retriesSucceeded,
    soft_nudges_fired: softNudgesFired,
    nudges_fired: nudgesFired,
    dormant: dormancyCount,
    closure_notices: closureNotices,
    expired: expiredCount,
  };
  console.log('[opportunities-maintain] summary', summary);
  return NextResponse.json(summary);
}
