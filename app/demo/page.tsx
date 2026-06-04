import type { Metadata } from 'next'
import DemoGate from '@/components/DemoGate'

export const metadata: Metadata = {
  title: 'Andrel Demo',
  robots: { index: false, follow: false },
}

export default function DemoPage() {
  const videoUrl = process.env.NEXT_PUBLIC_ANDREL_DEMO_VIDEO_URL || null

  return (
    <div className="min-h-screen bg-brand-cream flex flex-col">
      <main className="flex-1 flex items-center justify-center px-4 sm:px-6 py-14 lg:py-24">
        <DemoGate videoUrl={videoUrl} />
      </main>
      <footer className="border-t border-slate-100 py-8 text-center text-sm text-slate-400">
        © {new Date().getFullYear()} Andrel. Invite-only professional networking.
      </footer>
    </div>
  )
}
