import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Users, MessageSquare, Calendar, UserCircle, ArrowRight, CheckCircle } from 'lucide-react'

export default async function Home() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) redirect('/dashboard/introductions')

  const features = [
    {
      icon: Users,
      title: 'Introductions',
      description: 'Get warm introductions to the people who can move your career forward.',
    },
    {
      icon: MessageSquare,
      title: 'Messages',
      description: 'Meaningful conversations with context, not cold outreach noise.',
    },
    {
      icon: Calendar,
      title: 'Meetings',
      description: 'Schedule time with your network effortlessly — no back-and-forth.',
    },
    {
      icon: UserCircle,
      title: 'Profile',
      description: 'A professional profile that tells your story and opens doors.',
    },
  ]

  const benefits = [
    'Quality introductions over quantity',
    'No spam or unsolicited messages',
    'Built for professionals who value their time',
    'Private by default',
  ]

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <nav className="sticky top-0 z-50 bg-white/80 backdrop-blur border-b border-slate-100">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <span className="text-xl font-bold text-slate-900 tracking-tight">Cadre</span>
          <div className="flex items-center gap-3">
            <Link href="/login" className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors px-3 py-1.5">
              Sign in
            </Link>
            <Link href="/signup" className="text-sm font-semibold bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors">
              Join Cadre
            </Link>
          </div>
        </div>
      </nav>

      <main className="flex-1">
        {/* Hero */}
        <section className="max-w-6xl mx-auto px-6 pt-24 pb-20 text-center">
          <div className="inline-flex items-center gap-2 bg-indigo-50 text-indigo-700 text-xs font-semibold px-3 py-1.5 rounded-full mb-8 tracking-wide uppercase">
            Professional Networking, Reimagined
          </div>
          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-extrabold text-slate-900 leading-[1.05] tracking-tight mb-6">
            Your next opportunity
            <br />
            <span className="text-indigo-600">starts with an introduction.</span>
          </h1>
          <p className="text-xl text-slate-500 max-w-2xl mx-auto leading-relaxed mb-10">
            Cadre is the professional network built on trust. Connect with the right people through warm introductions, not cold outreach.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/signup"
              className="inline-flex items-center justify-center gap-2 bg-indigo-600 text-white text-sm font-semibold px-7 py-3.5 rounded-xl hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200"
            >
              Get started for free <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center justify-center text-sm font-semibold text-slate-700 px-7 py-3.5 rounded-xl border border-slate-200 hover:bg-slate-50 transition-colors"
            >
              Sign in to your account
            </Link>
          </div>
        </section>

        {/* Features */}
        <section className="bg-slate-50 py-20">
          <div className="max-w-6xl mx-auto px-6">
            <h2 className="text-3xl font-bold text-slate-900 text-center mb-3">Everything you need to grow professionally</h2>
            <p className="text-slate-500 text-center mb-12 max-w-xl mx-auto">Four focused tools designed to help you build meaningful professional relationships.</p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {features.map(({ icon: Icon, title, description }) => (
                <div key={title} className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm hover:shadow-md transition-shadow">
                  <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center mb-4">
                    <Icon className="w-5 h-5 text-indigo-600" />
                  </div>
                  <h3 className="font-semibold text-slate-900 mb-2">{title}</h3>
                  <p className="text-sm text-slate-500 leading-relaxed">{description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Benefits */}
        <section className="max-w-6xl mx-auto px-6 py-20">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div>
              <h2 className="text-3xl font-bold text-slate-900 mb-4">Networking the way it should be</h2>
              <p className="text-slate-500 leading-relaxed mb-8">
                Cadre is built for professionals who believe that the best opportunities come from trusted connections — not spam, not cold emails, not follower counts.
              </p>
              <ul className="space-y-3">
                {benefits.map((b) => (
                  <li key={b} className="flex items-center gap-3 text-slate-700">
                    <CheckCircle className="w-5 h-5 text-indigo-600 flex-shrink-0" />
                    <span className="text-sm font-medium">{b}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="bg-gradient-to-br from-indigo-600 to-indigo-800 rounded-3xl p-8 text-white">
              <p className="text-indigo-200 text-sm font-semibold uppercase tracking-wide mb-6">Ready to join?</p>
              <p className="text-2xl font-bold mb-3 leading-snug">Join professionals who value meaningful connections.</p>
              <p className="text-indigo-200 text-sm mb-8 leading-relaxed">Create your free account and start building your Cadre today.</p>
              <Link
                href="/signup"
                className="inline-flex items-center gap-2 bg-white text-indigo-700 text-sm font-bold px-6 py-3 rounded-xl hover:bg-indigo-50 transition-colors"
              >
                Create free account <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-100 py-8 text-center text-sm text-slate-400">
        © {new Date().getFullYear()} Cadre. All rights reserved.
      </footer>
    </div>
  )
}
