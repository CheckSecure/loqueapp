'use client';

import { useState } from 'react';
import Link from 'next/link';

/**
 * Dismissible success banner shown on the opportunity detail page after a
 * successful introduction. Hooked up via a shared context-free pattern:
 * IntroducedBannerHost keeps state, ResponderRow fires onIntroduced,
 * the banner renders until the user dismisses.
 */
export function IntroducedBanner({
  conversationId,
  responderName,
  onDismiss,
}: {
  conversationId: string;
  responderName: string;
  onDismiss: () => void;
}) {
  return (
    <div className="mb-6 flex items-center justify-between gap-4 rounded-lg border border-emerald-200 bg-emerald-50 px-5 py-4">
      <div className="flex-1">
        <p className="text-sm font-medium text-emerald-900">
          Introduced — {responderName} now has access.
        </p>
        <p className="mt-0.5 text-xs text-emerald-700">
          A conversation has been started with icebreakers.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Link
          href={`/dashboard/messages/${conversationId}`}
          className="rounded-md bg-[#1B2850] px-4 py-2 text-xs font-medium text-white hover:bg-[#151f3d]"
        >
          Open conversation
        </Link>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-emerald-700 hover:text-emerald-900"
          aria-label="Dismiss"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
