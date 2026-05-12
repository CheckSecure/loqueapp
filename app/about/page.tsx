import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'About Andrel',
  description: 'Why we built Andrel, and the philosophy behind it.',
}

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <nav className="sticky top-0 z-50 bg-white/80 backdrop-blur border-b border-slate-100">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-bold text-brand-navy tracking-tight">Andrel</Link>
          <div className="flex items-center gap-3">
            <Link href="/about" className="text-sm font-medium text-slate-900 transition-colors px-3 py-1.5">
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
        <article className="max-w-2xl mx-auto px-4 sm:px-6 py-16 lg:py-24">

          {/* Page label */}
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-gold mb-8">
            About Andrel
          </p>

          {/* Opening */}
          <h1 className="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight leading-snug mb-8">
            Modern professional networking has slowly become more transactional.
          </h1>

          <div className="prose-section space-y-5 text-slate-600 leading-relaxed text-[1.0625rem]">
            <p>
              Too often, outreach begins with an immediate ask — a pitch, a product, a request for business,
              or an attempt to sell something before any real relationship exists. Over time, that changes how
              people experience networking itself. Instead of feeling open to meeting new professionals, many
              people become guarded because every new connection starts to feel like the beginning of a sales process.
            </p>
            <p>
              The result is that genuine networking becomes harder, even though people are technically
              "more connected" than ever before.
            </p>
          </div>

          <hr className="my-12 border-slate-100" />

          {/* The problem */}
          <section className="space-y-5 text-slate-600 leading-relaxed text-[1.0625rem]">
            <p>
              At the same time, most people were never really taught how to build a strong professional
              network in the first place. Networking is often treated like a room full of people asking
              each other for favors. In reality, the strongest networks are usually built by people who
              consistently create value for others long before they ever ask for anything themselves.
            </p>
            <p className="font-medium text-slate-800">
              That philosophy sits at the center of Andrel.
            </p>
          </section>

          <hr className="my-12 border-slate-100" />

          {/* What Andrel is built around */}
          <section className="space-y-5 text-slate-600 leading-relaxed text-[1.0625rem]">
            <p>
              Andrel was built around the idea that a smaller number of thoughtful, relevant introductions
              can create significantly more value than thousands of low-context connections. The goal is not
              to maximize connection volume. The goal is to create introductions where both people are
              genuinely interested in meeting, learning from one another, helping one another, or potentially
              creating opportunities together over time.
            </p>
            <p>
              That changes the quality of the interaction from the beginning.
            </p>
            <p>
              A valuable professional introduction should not feel random or forced. It should feel
              intentional. It should feel like it came from someone who understands both individuals and
              believes the connection itself could genuinely matter.
            </p>
          </section>

          <hr className="my-12 border-slate-100" />

          {/* Why curation / invite-only */}
          <section className="space-y-5 text-slate-600 leading-relaxed text-[1.0625rem]">
            <p className="font-medium text-slate-800">
              That is also why Andrel is invite-only.
            </p>
            <p>
              Curation matters. The quality of a professional network is shaped not only by who is included,
              but by the overall behavior and expectations of the people inside it. The platform is
              intentionally designed to reduce transactional behavior and create an environment where
              professionals can build meaningful long-term relationships without feeling like every
              interaction is immediately leading toward a pitch.
            </p>
            <p>
              The objective is not simply to help people "know more people." In many cases, having thousands
              of shallow connections makes it harder to focus on the relationships that actually matter. A
              smaller number of mutually valuable relationships — built thoughtfully and maintained over
              time — often creates far greater long-term value for both careers and businesses.
            </p>
            <p>
              Andrel is designed around that idea.
            </p>
          </section>

          <hr className="my-12 border-slate-100" />

          {/* The vision */}
          <section className="space-y-5 text-slate-600 leading-relaxed text-[1.0625rem]">
            <p>
              The long-term vision is not to create another attention platform or another marketplace for
              outreach. The vision is to create a trusted relationship layer for professionals — one that
              makes networking feel warmer, more intentional, and more valuable again.
            </p>
            <p>
              If successful, members may ultimately know far more meaningful people through a curated
              network of intentional introductions than they would through platforms optimized primarily
              around connection volume.
            </p>
          </section>

        </article>
      </main>

      <footer className="border-t border-slate-100 py-8 text-center text-sm text-slate-400">
        <div className="flex items-center justify-center gap-6 mb-3">
          <Link href="/about" className="hover:text-slate-600 transition-colors">About</Link>
          <Link href="/pricing" className="hover:text-slate-600 transition-colors">Pricing</Link>
          <Link href="/login" className="hover:text-slate-600 transition-colors">Sign in</Link>
        </div>
        © {new Date().getFullYear()} Andrel. All rights reserved.
      </footer>
    </div>
  )
}
