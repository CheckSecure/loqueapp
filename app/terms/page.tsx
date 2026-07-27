import Link from 'next/link'
import { TERMS_VERSION, TERMS_EFFECTIVE_DATE } from '@/lib/legal/terms'

export const metadata = { title: 'Terms of Service | Andrel' }

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#F5F6FB] px-4 py-16">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-12">
          <Link href="/" className="text-xl font-bold text-[#1B2850] tracking-tight block mb-8">Andrel</Link>
          <h1 className="text-3xl font-bold text-slate-900 mb-3">Terms of Service</h1>
          <p className="text-slate-500 text-sm">Effective date: {TERMS_EFFECTIVE_DATE}</p>
          <p className="text-slate-400 text-xs mt-1">Version {TERMS_VERSION}</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8 space-y-8 text-sm text-slate-600 leading-relaxed">

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">1. Acceptance of Terms</h2>
            <p>By accessing or using Andrel ("the platform"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, you may not use the platform. These Terms are governed by the laws of the State of Delaware, USA. The platform and its features may evolve over time at our discretion.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">2. Eligibility</h2>
            <p>Andrel is an invitation-only platform. Access is granted solely at our discretion. We reserve the right to refuse service to any individual at any time, for any reason, without notice. You must be at least 18 years old to use Andrel. By using the platform, you represent that you meet this requirement and that all information you provide is accurate and truthful.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">3. Your Account</h2>
            <p>You are responsible for maintaining the confidentiality of your account credentials and for all activity that occurs under your account. You agree to notify us immediately at support@andrel.app if you suspect unauthorized access to your account. We reserve the right to suspend or terminate accounts that violate these Terms or that we determine, in our sole discretion, are harmful to the platform or its members.</p>
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
            <p className="mb-3">Andrel facilitates introductions between members based on mutual alignment and membership tier. Credits are consumed only when an introduction is successfully facilitated. Credits are non-transferable, have no cash value, and may not be exchanged for currency.</p>
            <p className="mb-3">Andrel does not guarantee that any specific introduction will be made, nor that any introduction will result in a conversation, meeting, business relationship, or other outcome. The quality and frequency of introductions may vary based on membership tier, profile completeness, and network composition.</p>
            <p>Andrel reserves the right to modify how credits are issued, used, calculated, or valued at any time. We will provide reasonable notice of material changes to credit terms.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">6. Membership and Billing</h2>
            <p>Paid memberships are billed on a monthly or annual basis through Stripe. You may cancel your membership at any time. Upon cancellation, you will retain access to your current tier until the end of the billing period, after which your account will revert to the Free tier. All payments are non-refundable unless required by applicable law. Andrel reserves the right to modify pricing at any time with reasonable notice.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">7. Founding Members</h2>
            <p>Certain members may be designated by Andrel as "Founding Members." Founding Member status is a personal designation extended at our sole discretion. It is non-transferable and revocable, and Andrel may modify, suspend, or discontinue Founding Member status, or any benefits associated with it, at any time and at our sole discretion. Founding Member status does not create any perpetual or guaranteed right to free membership, discounted pricing, credits, features, platform access, or any other special treatment, except where expressly stated otherwise in writing by Andrel. Any benefits extended to Founding Members are provided as a courtesy and may change as the platform evolves.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">8. Off-Platform Interactions</h2>
            <p>Members may choose to interact with one another outside of the Andrel platform. Andrel is not responsible for any conduct, communications, agreements, disputes, or outcomes that occur outside of the platform. You engage with other members off-platform at your own risk. Andrel expressly disclaims any liability for off-platform interactions.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">9. Intellectual Property</h2>
            <p>All content, design, and technology on the Andrel platform is owned by or licensed to Andrel. You may not reproduce, distribute, or create derivative works from any part of the platform without our express written consent. You retain ownership of content you submit, but grant Andrel a license to use it to operate and improve the platform.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">10. Disclaimer of Warranties</h2>
            <p>Andrel is provided "as is" without warranties of any kind, express or implied. We do not warrant that the platform will be uninterrupted, error-free, or free of harmful components. We make no guarantees regarding the quality, suitability, or outcomes of any introduction facilitated through the platform.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">11. Limitation of Liability</h2>
            <p>To the maximum extent permitted by law, Andrel shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of the platform, including but not limited to loss of profits, data, or business opportunities. Our total liability shall not exceed the amount you paid to Andrel in the 12 months preceding the claim.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">12. Dispute Resolution</h2>
            <p>Any dispute arising out of or relating to these Terms or your use of Andrel shall be resolved through binding arbitration administered by the American Arbitration Association under its applicable rules, with the arbitration seated in the Commonwealth of Virginia. These Terms and any such dispute shall continue to be governed by the laws of the State of Delaware, without regard to its conflict-of-laws principles. You waive any right to a jury trial or to participate in a class action. Nothing in this section prevents either party from seeking injunctive relief in a court of competent jurisdiction.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">13. Termination</h2>
            <p>We reserve the right to suspend or terminate your access to Andrel at any time, with or without notice, at our sole discretion. Grounds may include violation of these Terms, conduct harmful to the platform or other members, or any reason we deem appropriate to maintain the integrity of the network. You may delete your account at any time through Settings.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">14. Survival</h2>
            <p>Termination or expiration of your account or of these Terms shall not affect any provision that by its nature is intended to survive. Without limitation, the following provisions survive termination: Introductions and Credits (including the non-transferability and treatment of credits, where applicable), Intellectual Property, Off-Platform Interactions, Disclaimer of Warranties, Limitation of Liability, Dispute Resolution, any accrued payment obligations, any confidentiality or proprietary-rights obligations, and any other provision that by its nature is intended to survive.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">15. Changes to Terms</h2>
            <p>We may modify these Terms from time to time at our discretion. For material changes, we will provide reasonable advance notice by email or by posting a notice on the platform, and such changes will take effect as of the effective date stated in the notice or on the updated Terms. Your continued use of Andrel on or after the effective date constitutes your acceptance of the updated Terms. If you do not agree to the updated Terms, you must stop using the platform.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">16. Contact</h2>
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
