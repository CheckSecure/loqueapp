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
            <p>Andrel ("we," "us," or "our") operates the Andrel platform at andrel.app. This Privacy Policy describes how we collect, use, and protect information about you. By using Andrel, you agree to the practices described in this policy. If you are located outside the United States, you consent to the transfer and processing of your data in the United States, where our infrastructure is based.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">2. Information We Collect</h2>
            <p className="mb-3">We collect the following categories of information:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Account information:</strong> Your name, email address, and password.</li>
              <li><strong>Profile information:</strong> Your title, company, biography, role type, photo, and professional preferences provided during onboarding or profile editing.</li>
              <li><strong>Behavioral and usage data:</strong> Actions taken on the platform, features used, interactions with introductions, engagement patterns, and session activity. This data is collected to improve matching quality and platform performance.</li>
              <li><strong>Payment information:</strong> Billing details processed securely through Stripe. We do not store full payment card information.</li>
              <li><strong>Communications:</strong> Messages exchanged with other members through the platform.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">3. How We Use Your Information</h2>
            <p className="mb-3">We use the information we collect to:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Provide, operate, and improve the Andrel platform</li>
              <li>Curate and facilitate introductions between members using profile data, stated preferences, and behavioral signals — this may involve automated processing, though not decisions with legal or financial consequences</li>
              <li>Generate recommendations and improve matching accuracy over time</li>
              <li>Process payments and manage your membership</li>
              <li>Send transactional emails such as invitations and account notifications</li>
              <li>Analyze usage patterns through analytics tools to improve platform quality and member experience</li>
              <li>Enforce our Terms of Service and protect the integrity of the network</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">4. How We Share Your Information</h2>
            <p className="mb-3">We do not sell your personal information. We may share your information in the following limited circumstances:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>With other members:</strong> Your profile information is visible to other verified Andrel members only through curated introductions.</li>
              <li><strong>Service providers:</strong> We share data with third-party vendors who process data on our behalf under contractual obligations, including:
                <ul className="list-disc pl-5 mt-2 space-y-1">
                  <li>Supabase — database infrastructure</li>
                  <li>Stripe — payment processing</li>
                  <li>Resend — email delivery</li>
                  <li>Analytics providers — platform usage and engagement tracking</li>
                </ul>
              </li>
              <li><strong>Legal requirements:</strong> We may disclose information if required by law or to protect the rights and safety of Andrel or its members.</li>
              <li><strong>Off-platform interactions:</strong> Members may choose to interact outside the platform. Andrel is not responsible for how members use or share information in those contexts. You engage off-platform at your own discretion and risk.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">5. Data Retention</h2>
            <p>We retain your information for as long as your account is active. If you delete your account, we will remove your personal data within 30 days, except where retention is required for legal obligations, dispute resolution, or enforcement of our Terms of Service. Certain records, including messages and transaction history, may be retained longer where necessary.</p>
          </section>

          <section>
            <h2 className="text-base font-bold text-slate-900 mb-3">6. Security</h2>
            <p>We implement industry-standard security measures to protect your information, including encrypted data storage and secure connections. However, no system is completely secure. While we take reasonable precautions, we cannot guarantee the absolute security of your data. You share information on the platform at your own risk, and you are responsible for maintaining the security of your account credentials.</p>
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
            <p>Andrel uses cookies and similar technologies to maintain your session, analyze platform usage, and improve functionality. Analytics tools may use cookies to track behavioral data as described in Section 3. By using Andrel, you consent to our use of cookies. You may disable cookies in your browser settings, though this may affect platform functionality.</p>
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
            <p>For questions about this Privacy Policy, contact us at <a href="mailto:support@andrel.app" className="text-[#1B2850] underline">support@andrel.app</a>.</p>
          </section>

        </div>

        <div className="mt-8 text-center">
          <Link href="/terms" className="text-sm text-slate-500 hover:text-[#1B2850] transition-colors">Terms of Service →</Link>
        </div>
      </div>
    </div>
  )
}
