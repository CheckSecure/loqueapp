'use client';

import { useState } from 'react';
import { IntroducedBanner } from './IntroducedBanner';
import { ResponderRow } from './ResponderRow';

type Responder = {
  id: string;
  user_id: string;
  status: 'interested' | 'introduced' | 'withdrawn';
  conversation_id?: string | null;
  profiles: any;
};

/**
 * Wraps the waiting-list section of the detail page. Holds the last-introduced
 * conversation reference so we can render the success banner after the server
 * refresh. Once dismissed, the banner is gone for the rest of the session.
 */
export function IntroducedBannerHost({
  opportunityId,
  waiting,
  canIntroduce,
}: {
  opportunityId: string;
  waiting: Responder[];
  canIntroduce: boolean;
}) {
  const [banner, setBanner] = useState<{ conversationId: string; responderName: string } | null>(null);

  return (
    <>
      {banner && (
        <IntroducedBanner
          conversationId={banner.conversationId}
          responderName={banner.responderName}
          onDismiss={() => setBanner(null)}
        />
      )}
      {waiting.length > 0 && (
        <div className="mt-4 space-y-3">
          {waiting.map((r) => (
            <ResponderRow
              key={r.id}
              opportunityId={opportunityId}
              responder={r}
              canIntroduce={canIntroduce}
              onIntroduced={(args) => setBanner(args)}
            />
          ))}
        </div>
      )}
    </>
  );
}
