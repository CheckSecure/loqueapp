import Link from 'next/link'

export const metadata = { title: 'Terms of Service | Andrel' }

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#F5F6FB] px-4 py-16">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-12">
          <Link href="/" className="text-xl font-bold text-[#1B2850] tracking-tight block mb-8">Andrel</Link>
          <h1 className="text-3xl font-bold text-slate-900 mb-3">Terms of Service</h1>
          <p className="text-slate-500 text-sm">Effective date: March 24, 2026</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8 space-y-8 text-sm text-slate-600 leading-relaxed">

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">1. Acceptance of Terms</h2>
            <p>By accessing or using Andrel ("the platform"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, you may not use the platform. These Terms are governed by the laws of the State of Delaware, USA.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">2. Eligibility</h2>
            <p>Andrel is an invitation-only platform. Access is granted solely at our discretion. You must be at least 18 years old to use Andrel. By using the platform, you represent that you meet this requirement and that all information you provide is accurate and truthful.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">3. Your Account</h2>
            <p>You are responsible for maintaining the confidentiality of your account credentials and for all activity that occurs under your account. You agree to notify us immediately at support@andrel.app if you suspect unauthorized access to your account. We reserve the right to suspend or terminate accounts that violate these Terms.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">4. Acceptable Use</h2>
            <p className="mb-3">You agree not to:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Use Andrel for any unlawful purpose or in violation of any applicable laws</li>
              <li>Misrepresent your identity, credentials, or professional background</li>
              <li>Harass, threaten, or harm other members</li>
              <li>Use the platform to send unsolicited commercial messages or spam</li>
              <li>Attempt to circumvent or manipulate the introduction or matching system</li>
              <li>Scrape, copy, or redistribute content from the platform without permission</li>
              <li>Interfere with the security or integrity of the platform</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">5. Introductions and Credits</h2>
            <p>Andrel facilitates introductions between members based on mutual alignment and membership tier. Credits are consumed when an introduction is successfully facilitated. Credits are non-transferable and have no cash value. We do not guarantee that any specific introduction will be made. Andrel reserves the right to decline or remove any introduction at its discretion.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">6. Membership and Billing</h2>
            <p>Paid memberships are billed on a monthly or annual basis through Stripe. You may cancel your membership at any time. Upon cancellation, you will retain access to your current tier until the end of the billing period, after which your account will revert to the Free tier. All payments are non-refundable unless required by applicable law.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">7. Intellectual Property</h2>
            <p>All content, design, and technology on the Andrel platform is owned by or licensed to Andrel. You may not reproduce, distribute, or create derivative works from any part of the platform without our express written consent. You retain ownership of content you submit, but grant Andrel a license to use it to operate and improve the platform.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">8. Disclaimer of Warranties</h2>
            <p>Andrel is provided "as is" without warranties of any kind, express or implied. We do not warrant that the platform will be uninterrupted, error-free, or free of harmful components. We make no guarantees regarding the quality, suitability, or outcomes of any introduction facilitated through the platform.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">9. Limitation of Liability</h2>
            <p>To the maximum extent permitted by law, Andrel shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of the platform, including but not limited to loss of profits, data, or business opportunities. Our total liability shall not exceed the amount you paid to Andrel in the 12 months preceding the claim.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">10. Termination</h2>
            <p>We reserve the right to suspend or terminate your access to Andrel at any time, with or without notice, for conduct that we believe violates these Terms or is harmful to the platform, other members, or third parties. You may delete your account at any time through Settings.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">11. Changes to Terms</h2>
            <p>We may update these Terms from time to time. We will notify you of material changes by email or by posting a notice on the platform. Continued use of Andrel after changes constitutes acceptance of the updated Terms.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">12. Contact</h2>
            <p>For questions about these Terms, contact us at <a href="mailto:support@andrel.app" className="text-[#1B2850] underline">support@andrel.app</a>.</p>
          </section>

        </div>

        <div className="mt-8 text-center">
          <Link href="/privacy" className="text-sm text-slate-500 hover:text-[#1B2850] transition-colors">Privacy Policy →</Link>
        </div>
      </div>
    </div>
  )
}
