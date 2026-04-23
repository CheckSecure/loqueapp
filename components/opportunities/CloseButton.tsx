'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function CloseButton({ opportunityId }: { opportunityId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function close() {
    setBusy(true);
    try {
      await fetch('/api/opportunities/close', {
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
      <div className="flex items-center gap-3 rounded-md bg-amber-50 px-3 py-2">
        <span className="text-xs text-amber-900">Close this opportunity?</span>
        <button type="button" onClick={close} disabled={busy} className="text-xs font-medium text-red-600 hover:underline disabled:opacity-60">
          {busy ? 'Closing…' : 'Yes, close'}
        </button>
        <button type="button" onClick={() => setConfirming(false)} className="text-xs text-slate-500 hover:text-slate-700">
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button type="button" onClick={() => setConfirming(true)} className="text-xs text-slate-500 hover:text-slate-700">
      Close opportunity
    </button>
  );
}
