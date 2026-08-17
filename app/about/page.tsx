import Link from 'next/link'
import type { Metadata } from 'next'
import { ClipboardList, Sparkles, Handshake, ArrowRight, ArrowDown } from 'lucide-react'

export const metadata: Metadata = {
  title: 'About Andrel',
  description:
    'A private network of curated, mutual introductions for senior legal professionals. Andrel selects each potential introduction; interest stays private, and a connection opens only when both people choose to meet.',
}

// Shared CTA pair — "Request an invitation" (the home-page waitlist form) + "Member sign in" (/login).
// Verified routes: the invitation request is the waitlist form on the landing page ('/'); sign-in is
// '/login'. No dedicated /waitlist route exists.
function CtaPair({ align = 'start' }: { align?: 'start' | 'center' }) {
  return (
    <div
      className={`flex flex-col sm:flex-row gap-3 sm:gap-4 ${
        align === 'center' ? 'sm:justify-center' : ''
      }`}
    >
      <Link
        href="/"
        className="inline-flex items-center justify-center rounded-full border border-transparent bg-brand-navy px-6 py-3 text-sm font-semibold text-white transition-colors motion-reduce:transition-none hover:bg-brand-navy-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold focus-visible:ring-offset-2"
      >
        Request an invitation
      </Link>
      <Link
        href="/login"
        className="inline-flex items-center justify-center rounded-full border border-slate-300 px-6 py-3 text-sm font-semibold text-slate-700 transition-colors motion-reduce:transition-none hover:border-slate-400 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold focus-visible:ring-offset-2"
      >
        Member sign in
      </Link>
    </div>
  )
}

// The single custom visual: the three-step introduction pathway. Semantic ordered list; connectors are
// decorative (aria-hidden). Horizontal on desktop, vertical stack on mobile — reading order matches the
// labelled steps below it. The cards carry no "Step N" label: the numbers live on the written steps
// directly below, and repeating them here read as two numbered sequences stacked on top of each other.
// Cards stretch to a shared height (no items-center) so a label that wraps at narrow widths cannot
// leave the row ragged.
const PATHWAY = [
  { label: 'Your priorities', Icon: ClipboardList },
  { label: 'Andrel curates', Icon: Sparkles },
  { label: 'Mutual introduction', Icon: Handshake },
]

function IntroductionPathway() {
  return (
    <ol
      aria-label="How an Andrel introduction is made, in three stages"
      className="flex flex-col items-stretch gap-4 sm:flex-row sm:justify-center sm:gap-2"
    >
      {PATHWAY.map(({ label, Icon }, i) => (
        <li key={label} className="contents">
          <div className="flex flex-1 flex-col items-center justify-start gap-3.5 rounded-2xl border border-slate-200/70 bg-white px-5 py-7 text-center shadow-sm">
            <span
              aria-hidden="true"
              className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-brand-gold-soft text-brand-gold"
            >
              <Icon className="h-6 w-6" />
            </span>
            <span className="text-[15px] font-semibold text-brand-navy text-balance">{label}</span>
          </div>
          {i < PATHWAY.length - 1 && (
            <span
              aria-hidden="true"
              className="flex items-center justify-center text-slate-400 sm:px-1"
            >
              <ArrowDown className="h-5 w-5 sm:hidden" />
              <ArrowRight className="hidden h-5 w-5 sm:block" />
            </span>
          )}
        </li>
      ))}
    </ol>
  )
}

const STEPS = [
  {
    heading: 'Tell Andrel what matters to you',
    body: [
      'Members share their experience, interests, current priorities, and the kinds of professionals they would value knowing.',
    ],
  },
  {
    heading: 'Receive a curated introduction',
    body: [
      'Andrel identifies a potentially valuable connection and privately presents the introduction to both people.',
      'Introduction batches are prepared each Thursday. A member may not receive an introduction in every batch; Andrel would rather wait than recommend someone without a strong reason.',
    ],
  },
  {
    heading: 'Connect when interest is mutual',
    body: [
      'Neither person sees the other’s response. When both choose to connect, Andrel opens the introduction and gives them a private place to begin the conversation.',
    ],
  },
]

const EXPECTATIONS = [
  'Approach introductions with curiosity rather than an immediate pitch.',
  'Respond to an introduction, even when the answer is no.',
  'Respect that another member’s interest remains private.',
  'Treat conversations and member information with discretion.',
  'Look for opportunities to be useful before asking for something.',
]

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <nav className="sticky top-0 z-50 bg-white/80 backdrop-blur border-b border-slate-100">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-bold text-brand-navy tracking-tight">Andrel</Link>
          <div className="flex items-center gap-3">
            <Link href="/about" aria-current="page" className="text-sm font-medium text-slate-900 transition-colors px-3 py-1.5">
              About
            </Link>
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
        {/* ── Hero ─────────────────────────────────────────────────────────────────────── */}
        <section className="px-4 sm:px-6 py-16 lg:py-24" aria-labelledby="about-hero-heading">
          <div className="max-w-2xl mx-auto">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-gold mb-6">
              About Andrel
            </p>
            {/*
              lg:leading-[1.1] is required: sm:text-4xl also sets line-height:2.5rem, and that value
              survives into the lg breakpoint (lg:text-[2.75rem] sets font-size only), which left 44px
              type sitting on 40px leading.
            */}
            <h1
              id="about-hero-heading"
              className="text-3xl sm:text-4xl lg:text-[2.75rem] font-bold text-brand-navy tracking-tight leading-[1.12] lg:leading-[1.1] text-balance mb-8"
            >
              A private network built around mutual, curated introductions
            </h1>
            <div className="space-y-5 text-slate-600 leading-relaxed text-[1.0625rem] text-pretty">
              <p>
                Andrel introduces senior legal professionals it believes could benefit from knowing one another.
              </p>
              <p>
                Members do not browse a directory or send cold connection requests. Andrel selects each potential
                introduction based on professional experience, interests, and the possibility of mutual value.
                Interest remains private, and a connection is made only when both people want to meet.
              </p>
              <p>
                The goal is simple: create a better starting point for professional relationships.
              </p>
            </div>
            <div className="mt-10">
              <CtaPair />
            </div>
          </div>
        </section>

        {/* ── Why Andrel exists ────────────────────────────────────────────────────────── */}
        <section className="bg-brand-cream/50 border-y border-slate-100" aria-labelledby="why-heading">
          <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 lg:py-24">
            <h2 id="why-heading" className="text-2xl sm:text-3xl font-bold text-brand-navy tracking-tight text-balance mb-6">
              Why Andrel exists
            </h2>
            <div className="space-y-5 text-slate-600 leading-relaxed text-[1.0625rem] text-pretty">
              <p>
                Professional networking has become increasingly transactional. Too many new connections begin with
                an immediate pitch, request, or attempt to sell before any real relationship exists.
              </p>
              <p>That makes people more guarded—even when an introduction may be relevant.</p>
              <p>
                Andrel was created around a different idea: a small number of thoughtful introductions can create
                more lasting value than thousands of low-context connections. A well-chosen introduction may become
                a trusted peer relationship, a source of perspective, an exchange of expertise, or a collaboration
                that develops naturally over time.
              </p>
              <p className="font-medium text-slate-800">
                Andrel’s role is to create the introduction. What grows from it belongs to the people involved.
              </p>
            </div>
          </div>
        </section>

        {/* ── How it works (the one custom visual + three steps) ───────────────────────── */}
        <section className="px-4 sm:px-6 py-16 lg:py-24" aria-labelledby="how-heading">
          <div className="max-w-2xl mx-auto">
            <h2 id="how-heading" className="text-2xl sm:text-3xl font-bold text-brand-navy tracking-tight text-balance mb-10">
              How it works
            </h2>

            <IntroductionPathway />

            <ol className="mt-12 space-y-10">
              {STEPS.map((step, i) => (
                <li key={step.heading} className="flex gap-4 sm:gap-5">
                  <span
                    aria-hidden="true"
                    className="flex-shrink-0 mt-0.5 inline-flex h-9 w-9 items-center justify-center rounded-full border border-brand-gold/30 bg-brand-gold-soft text-sm font-bold text-brand-gold"
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-lg font-semibold text-brand-navy text-balance mb-2">{step.heading}</h3>
                    <div className="space-y-3 text-slate-600 leading-relaxed text-[1.0625rem] text-pretty">
                      {step.body.map((p) => (
                        <p key={p}>{p}</p>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ── Who is in the network ────────────────────────────────────────────────────── */}
        {/*
          Untinted on purpose. The tinted band marks the two sections that explain Andrel's reasoning
          ("Why Andrel exists" and "Why I built Andrel"); tinting every other section instead turned
          seven sections into an even white/cream stripe pattern.
        */}
        <section className="px-4 sm:px-6 py-16 lg:py-24" aria-labelledby="network-heading">
          <div className="max-w-2xl mx-auto">
            <h2 id="network-heading" className="text-2xl sm:text-3xl font-bold text-brand-navy tracking-tight text-balance mb-6">
              Who is in the network
            </h2>
            <div className="space-y-5 text-slate-600 leading-relaxed text-[1.0625rem] text-pretty">
              <p>Andrel’s network is currently centered on senior in-house counsel and law-firm partners.</p>
              <p>
                Members bring experience across companies, firms, industries, and areas of legal practice. What
                connects them is not a particular title or employer, but the potential to contribute perspective,
                judgment, and value to the people they meet.
              </p>
              <p>Membership is invite-only, and admission remains selective as the network grows.</p>
              <p>
                There is no cost to join Andrel. Optional paid memberships provide additional introductions and
                services, but members can participate without purchasing a subscription.
              </p>
            </div>
          </div>
        </section>

        {/* ── What members are expected to do ──────────────────────────────────────────── */}
        <section className="px-4 sm:px-6 py-16 lg:py-24" aria-labelledby="expectations-heading">
          <div className="max-w-2xl mx-auto">
            <h2 id="expectations-heading" className="text-2xl sm:text-3xl font-bold text-brand-navy tracking-tight text-balance mb-6">
              What members are expected to do
            </h2>
            <p className="text-slate-600 leading-relaxed text-[1.0625rem] text-pretty mb-6">
              The quality of Andrel depends on how members participate.
            </p>
            <ul className="space-y-3.5">
              {EXPECTATIONS.map((item) => (
                <li key={item} className="flex gap-3 text-slate-600 leading-relaxed text-[1.0625rem] text-pretty">
                  <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-brand-gold" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-slate-600 leading-relaxed text-[1.0625rem] text-pretty">
              Andrel is designed for people who genuinely intend to participate. Repeatedly leaving introductions
              unanswered may limit a member’s ability to receive additional introductions.
            </p>
          </div>
        </section>

        {/* ── Why I built Andrel (founder) ─────────────────────────────────────────────── */}
        <section className="bg-brand-cream/50 border-y border-slate-100" aria-labelledby="founder-heading">
          <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 lg:py-24">
            <h2 id="founder-heading" className="text-2xl sm:text-3xl font-bold text-brand-navy tracking-tight text-balance mb-6">
              Why I built Andrel
            </h2>
            <div className="space-y-5 text-slate-600 leading-relaxed text-[1.0625rem] text-pretty">
              <p>
                I built Andrel after seeing the same pattern repeatedly: accomplished professionals wanted to expand
                their networks, but they had little interest in more cold outreach, superficial connection requests,
                or conversations that began with a sales agenda.
              </p>
              <p>
                The problem was not a lack of people to contact. It was a lack of context, trust, and a meaningful
                reason to meet.
              </p>
              <p>
                I also saw how valuable one well-considered introduction could become when it was made by someone who
                understood both people and had a genuine reason for connecting them.
              </p>
              <p>
                Andrel is my effort to make those introductions more consistent while preserving the judgment,
                context, and mutual interest that make them worthwhile.
              </p>
            </div>
            <div className="mt-8 border-t border-slate-200/70 pt-6">
              <p className="font-semibold text-brand-navy">Daniel Abramoff</p>
              <p className="text-sm text-slate-500">Founder, Andrel</p>
            </div>
          </div>
        </section>

        {/* ── Closing ──────────────────────────────────────────────────────────────────── */}
        <section className="px-4 sm:px-6 py-16 lg:py-24" aria-labelledby="closing-heading">
          <div className="max-w-2xl mx-auto text-center">
            <h2 id="closing-heading" className="text-2xl sm:text-3xl font-bold text-brand-navy tracking-tight text-balance mb-5">
              Build relationships worth maintaining
            </h2>
            <p className="text-slate-600 leading-relaxed text-[1.0625rem] text-pretty mb-9 max-w-xl mx-auto">
              Andrel is not designed around followers, public attention, or connection volume. It is designed to help
              the right professionals meet with context and mutual intent.
            </p>
            <CtaPair align="center" />
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-100 py-8 text-center text-sm text-slate-400">
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mb-3">
          <Link href="/about" className="hover:text-slate-600 transition-colors">About</Link>
          <Link href="/pricing" className="hover:text-slate-600 transition-colors">Pricing</Link>
          <Link href="/login" className="hover:text-slate-600 transition-colors">Sign in</Link>
          <Link href="/terms" className="hover:text-slate-600 transition-colors">Terms</Link>
          <Link href="/privacy" className="hover:text-slate-600 transition-colors">Privacy</Link>
        </div>
        © {new Date().getFullYear()} Andrel. All rights reserved.
      </footer>
    </div>
  )
}
