import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Users, MessageSquare, Calendar, UserCircle, CheckCircle, ShieldCheck, Briefcase, Lightbulb } from 'lucide-react'
import WaitlistForm from '@/components/WaitlistForm'

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
          <span className="text-xl font-bold text-brand-navy tracking-tight">Andrel</span>
          <div className="flex items-center gap-3">
            <Link href="/pricing" className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors px-3 py-1.5">
              Pricing
            </Link>
            <Link href="/login" className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors px-3 py-1.5">
              Sign in
            </Link>
          </div>
        </div>
      </nav>

      <main className="flex-1">
        {/* Hero + Waitlist Form */}
        <section className="bg-gradient-to-br from-brand-navy to-brand-navy-light py-20 lg:py-28">
          <div className="max-w-6xl mx-auto px-6">
            <div className="grid lg:grid-cols-2 gap-14 items-center">
              {/* Left: copy */}
              <div>
                <div className="inline-flex items-center gap-2 bg-white/10 text-white/80 text-xs font-semibold px-3 py-1.5 rounded-full mb-6 tracking-wide uppercase border border-white/20">
                  <ShieldCheck className="w-3.5 h-3.5 text-brand-gold" />
                  Andrel is currently invite-only
                </div>
                <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-white leading-[1.05] tracking-tight mb-5">
                  Your next opportunity
                  <br />
                  <span className="text-brand-gold">starts with an introduction.</span>
                </h1>
                <p className="text-lg text-white/60 leading-relaxed mb-6">
                  Andrel is the professional network built on trust. Join the waitlist to request access.
                </p>
                <ul className="space-y-2.5">
                  {benefits.map(b => (
                    <li key={b} className="flex items-center gap-2.5 text-white/70 text-sm">
                      <CheckCircle className="w-4 h-4 text-brand-gold flex-shrink-0" />
                      {b}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Right: waitlist form */}
              <div>
                <WaitlistForm />
              </div>
            </div>
          </div>
        </section>

        {/* Opportunities */}
        <section className="bg-brand-cream py-20">
          <div className="max-w-6xl mx-auto px-6">
            <div className="text-center mb-14">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-gold mb-3">More than introductions</p>
              <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mb-4 tracking-tight">
                Private signals, to the right people.
              </h2>
              <p className="text-slate-500 max-w-2xl mx-auto leading-relaxed">
                Andrel handles two kinds of signals that matter to professionals: who you should meet, and what opportunities are worth your time.
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl p-8 border border-slate-100 shadow-sm hover:shadow-md transition-shadow">
                <div className="w-11 h-11 bg-brand-gold-soft rounded-xl flex items-center justify-center mb-5">
                  <Briefcase className="w-5 h-5 text-brand-gold" />
                </div>
                <h3 className="text-xl font-semibold text-slate-900 mb-3">Hiring, privately</h3>
                <p className="text-sm text-slate-600 leading-relaxed mb-4">
                  When you're hiring, signal it to your network — not LinkedIn. Qualified candidates you already trust, or one degree away, see the opportunity. No public job post. No cold outreach. No noise.
                </p>
                <p className="text-xs text-slate-400">For hiring managers, in-house counsel, and partners.</p>
              </div>

              <div className="bg-white rounded-2xl p-8 border border-slate-100 shadow-sm hover:shadow-md transition-shadow">
                <div className="w-11 h-11 bg-brand-gold-soft rounded-xl flex items-center justify-center mb-5">
                  <Lightbulb className="w-5 h-5 text-brand-gold" />
                </div>
                <h3 className="text-xl font-semibold text-slate-900 mb-3">Business needs, quietly</h3>
                <p className="text-sm text-slate-600 leading-relaxed mb-4">
                  Looking for a specialist, an advisor, or a partner on a specific problem? Andrel routes your need to the right members in your network. You get introduced to people who can actually help — not cold emails from vendors.
                </p>
                <p className="text-xs text-slate-400">For founders, executives, and service providers.</p>
              </div>
            </div>

            <p className="text-center text-sm text-slate-400 mt-12 max-w-xl mx-auto">
              Behind the scenes, curated introductions, private messaging, and direct scheduling keep every relationship moving.
            </p>
          </div>
        </section>

        {/* Why invite-only */}
        <section className="max-w-6xl mx-auto px-6 py-20">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div>
              <h2 className="text-3xl font-bold text-slate-900 mb-4">Networking the way it should be</h2>
              <p className="text-slate-500 leading-relaxed mb-6">
                Andrel is built for professionals who believe that the best opportunities come from trusted connections — not spam, not cold emails, not follower counts.
              </p>
              <p className="text-slate-500 leading-relaxed">
                We personally review every application to maintain the quality of our network. When your spot is ready, we'll reach out.
              </p>
            </div>
            <div className="bg-gradient-to-br from-brand-navy to-brand-navy-light rounded-3xl p-8 text-white">
              <div className="flex items-center gap-2 mb-5">
                <ShieldCheck className="w-5 h-5 text-brand-gold" />
                <span className="text-brand-gold text-sm font-semibold uppercase tracking-wide">Invite-only access</span>
              </div>
              <p className="text-2xl font-bold mb-3 leading-snug">Join a network built on trust and warm introductions.</p>
              <p className="text-white/60 text-sm leading-relaxed">
                Every member is vetted. Every introduction is meaningful. Apply above and we'll be in touch when your spot opens.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-100 py-8 text-center text-sm text-slate-400">
        © {new Date().getFullYear()} Andrel. All rights reserved.
      </footer>
    </div>
  )
}
