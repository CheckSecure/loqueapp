'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ArchiveAction({ opportunityId }: { opportunityId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function archive() {
    setBusy(true);
    try {
      await fetch('/api/opportunities/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunity_id: opportunityId }),
      });
      router.refresh();
    } catch {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={archive}
          disabled={busy}
          className="text-xs font-medium text-red-600 hover:underline disabled:opacity-60"
        >
          {busy ? 'Removing…' : 'Remove'}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-xs text-slate-500 hover:text-slate-700"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirming(true); }}
      className="text-xs text-slate-500 hover:text-slate-700"
    >
      Remove
    </button>
  );
}
