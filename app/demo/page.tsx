import type { Metadata } from 'next'
import DemoGate from '@/components/DemoGate'

export const metadata: Metadata = {
  title: 'Andrel Demo',
  robots: { index: false, follow: false },
}

function sanitizeRefCode(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
  return cleaned.length > 0 ? cleaned : null
}

export default function DemoPage({
  searchParams,
}: {
  searchParams: { ref?: string | string[] }
}) {
  const videoUrl = process.env.NEXT_PUBLIC_ANDREL_DEMO_VIDEO_URL || null
  const refCode = sanitizeRefCode(searchParams.ref)

  return (
    <div className="min-h-screen bg-brand-cream flex flex-col">
      <main className="flex-1 flex items-center justify-center px-4 sm:px-6 py-14 lg:py-24">
        <DemoGate videoUrl={videoUrl} refCode={refCode} />
      </main>
      <footer className="border-t border-slate-100 py-8 text-center text-sm text-slate-400">
        © {new Date().getFullYear()} Andrel. Invite-only professional networking.
      </footer>
    </div>
  )
}
