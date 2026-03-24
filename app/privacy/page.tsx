import Link from 'next/link'

export const metadata = { title: 'Privacy Policy | Andrel' }

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[#F5F6FB] px-4 py-16">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-12">
          <Link href="/" className="text-xl font-bold text-[#1B2850] tracking-tight block mb-8">Andrel</Link>
          <h1 className="text-3xl font-bold text-slate-900 mb-3">Privacy Policy</h1>
          <p className="text-slate-500 text-sm">Effective date: March 24, 2026</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8 space-y-8 text-sm text-slate-600 leading-relaxed">

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">1. Introduction</h2>
            <p>Andrel ("we," "us," or "our") operates the Andrel platform, accessible at andrel.app. This Privacy Policy explains how we collect, use, and protect information about you when you use our services. By using Andrel, you agree to the practices described in this policy.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">2. Information We Collect</h2>
            <p className="mb-3">We collect the following categories of information:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Account information:</strong> Your name, email address, and password when you create an account.</li>
              <li><strong>Profile information:</strong> Your title, company, biography, role type, photo, and professional preferences that you provide during onboarding or profile editing.</li>
              <li><strong>Usage data:</strong> Information about how you interact with the platform, including pages visited, features used, and actions taken.</li>
              <li><strong>Payment information:</strong> Billing details processed securely through Stripe. We do not store your full payment card information.</li>
              <li><strong>Communications:</strong> Messages exchanged with other members through the platform.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">3. How We Use Your Information</h2>
            <p className="mb-3">We use the information we collect to:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Provide, operate, and improve the Andrel platform</li>
              <li>Curate and facilitate introductions between members</li>
              <li>Process payments and manage your membership</li>
              <li>Send transactional emails such as invitations and account notifications</li>
              <li>Analyze usage patterns to improve platform quality</li>
              <li>Enforce our Terms of Service and protect the integrity of the network</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">4. How We Share Your Information</h2>
            <p className="mb-3">We do not sell your personal information. We may share your information in the following limited circumstances:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>With other members:</strong> Your profile information is visible to other verified Andrel members through curated introductions only.</li>
              <li><strong>Service providers:</strong> We share data with third-party vendors who help us operate the platform, including Supabase (database), Stripe (payments), and Resend (email). These providers are contractually bound to protect your data.</li>
              <li><strong>Legal requirements:</strong> We may disclose information if required by law or to protect the rights and safety of Andrel or its members.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">5. Data Retention</h2>
            <p>We retain your information for as long as your account is active. If you delete your account, we will remove your personal data from our systems within 30 days, except where retention is required by law.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">6. Security</h2>
            <p>We implement industry-standard security measures to protect your information, including encrypted data storage and secure connections. No method of transmission over the internet is 100% secure, and we cannot guarantee absolute security.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">7. Your Rights</h2>
            <p className="mb-3">You have the right to:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Access the personal information we hold about you</li>
              <li>Request correction of inaccurate information</li>
              <li>Request deletion of your account and associated data</li>
              <li>Withdraw consent where processing is based on consent</li>
            </ul>
            <p className="mt-3">To exercise these rights, contact us at <a href="mailto:support@andrel.app" className="text-[#1B2850] underline">support@andrel.app</a>.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">8. Cookies</h2>
            <p>Andrel uses cookies and similar technologies to maintain your session and improve platform functionality. By using Andrel, you consent to our use of cookies. You may disable cookies in your browser settings, though this may affect platform functionality.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">9. Children's Privacy</h2>
            <p>Andrel is not intended for individuals under the age of 18. We do not knowingly collect personal information from minors. If we become aware that we have collected information from a minor, we will delete it promptly.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">10. Changes to This Policy</h2>
            <p>We may update this Privacy Policy from time to time. We will notify you of material changes by email or by posting a notice on the platform. Continued use of Andrel after changes constitutes acceptance of the updated policy.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">11. Contact</h2>
            <p>If you have questions about this Privacy Policy, please contact us at <a href="mailto:support@andrel.app" className="text-[#1B2850] underline">support@andrel.app</a>.</p>
          </section>

        </div>

        <div className="mt-8 text-center">
          <Link href="/terms" className="text-sm text-slate-500 hover:text-[#1B2850] transition-colors">Terms of Service →</Link>
        </div>
      </div>
    </div>
  )
}
