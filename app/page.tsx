import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export default async function Home() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (user) {
    redirect('/dashboard')
  }

  return (
    <main className="min-h-screen flex flex-col">
      <nav className="flex items-center justify-between px-8 py-5 border-b border-gray-100">
        <span className="text-xl font-bold text-cadre-600 tracking-tight">Cadre</span>
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="text-sm font-medium bg-cadre-600 text-white px-4 py-2 rounded-lg hover:bg-cadre-700 transition-colors"
          >
            Get started
          </Link>
        </div>
      </nav>

      <section className="flex-1 flex flex-col items-center justify-center px-4 text-center py-24">
        <div className="inline-flex items-center gap-2 bg-cadre-50 text-cadre-700 text-sm font-medium px-3 py-1 rounded-full mb-8">
          <span className="w-1.5 h-1.5 bg-cadre-500 rounded-full"></span>
          Now in beta
        </div>
        <h1 className="text-5xl sm:text-6xl font-bold text-gray-900 leading-tight max-w-3xl mb-6">
          Your team,{' '}
          <span className="text-cadre-600">in formation.</span>
        </h1>
        <p className="text-xl text-gray-500 max-w-xl mb-10 leading-relaxed">
          Cadre brings your team together with the tools you need to
          plan, build, and ship — all in one place.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/signup"
            className="bg-cadre-600 text-white text-sm font-semibold px-6 py-3 rounded-xl hover:bg-cadre-700 transition-colors shadow-sm"
          >
            Start for free
          </Link>
          <Link
            href="/login"
            className="text-sm font-semibold text-gray-700 px-6 py-3 rounded-xl border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors"
          >
            Sign in to your workspace
          </Link>
        </div>
      </section>

      <footer className="py-8 text-center text-sm text-gray-400 border-t border-gray-100">
        © {new Date().getFullYear()} Cadre. All rights reserved.
      </footer>
    </main>
  )
}
