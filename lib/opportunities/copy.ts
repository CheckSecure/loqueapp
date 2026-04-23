/**
 * lib/opportunities/copy.ts
 *
 * Notification copy for opportunity-related types. Merge into
 * NOTIFICATION_COPY and LINK_BY_TYPE in lib/notifications/index.ts.
 */

export const OPPORTUNITY_NOTIFICATION_COPY = {
  opportunity_received: {
    title: 'You were selected for an opportunity',
    body: 'Someone on Andrel thought of you.',
  },
  opportunity_response: {
    title: 'Someone is open to your opportunity',
    body: 'Review who responded.',
  },
  recruiter_request: {
    title: 'A company in your network is hiring',
    body: 'They opted into recruiter support.',
  },
  opportunity_nudge_creator: {
    title: 'People are waiting on you',
    body: 'Review and introduce when ready.',
  },
  opportunity_closed: {
    title: 'Update on this opportunity',
    body: 'This opportunity is no longer active.',
  },
};

export const OPPORTUNITY_LINKS: Record<string, string> = {
  opportunity_received: '/dashboard/opportunities',
  opportunity_response: '/dashboard/opportunities',
  recruiter_request: '/dashboard/opportunities',
  opportunity_nudge_creator: '/dashboard/opportunities',
  opportunity_closed: '/dashboard/opportunities',
};
