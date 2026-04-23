'use client';

import { useEffect } from 'react';

export function TouchOnMount({ opportunityId }: { opportunityId: string }) {
  useEffect(() => {
    fetch('/api/opportunities/touch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opportunity_id: opportunityId }),
      keepalive: true,
    }).catch(() => {});
  }, [opportunityId]);

  return null;
}
