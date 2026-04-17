'use client'

export function PricingTiers() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-16">
      {/* Header */}
      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold text-slate-900 mb-4">
          Choose your access level
        </h1>
        <p className="text-lg text-slate-600 max-w-2xl mx-auto">
          Get curated introductions to the right people at the right time. 
          Upgrade for better access and more frequent connections.
        </p>
      </div>

      {/* Pricing Tiers */}
      <div className="grid md:grid-cols-3 gap-8 mb-16">
        
        {/* FREE TIER */}
        <div className="border border-slate-200 rounded-2xl p-8 bg-white">
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2">
              Free
            </h3>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Explore the network
            </h2>
            <div className="flex items-baseline mb-6">
              <span className="text-4xl font-bold text-slate-900">$0</span>
              <span className="text-slate-500 ml-2">/month</span>
            </div>
          </div>
          
          <ul className="space-y-4 mb-8">
            <li className="flex items-start">
              <svg className="w-5 h-5 text-emerald-600 mr-3 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-slate-700">Curated introductions each week</span>
            </li>
            <li className="flex items-start">
              <svg className="w-5 h-5 text-emerald-600 mr-3 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-slate-700">3 introduction credits per month</span>
            </li>
            <li className="flex items-start">
              <svg className="w-5 h-5 text-emerald-600 mr-3 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-slate-700">Access to relevant, high-quality professionals</span>
            </li>
            <li className="flex items-start">
              <svg className="w-5 h-5 text-emerald-600 mr-3 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-slate-700">Standard visibility in the network</span>
            </li>
          </ul>

          <button className="w-full py-3 px-6 border-2 border-slate-300 text-slate-700 font-semibold rounded-lg hover:border-slate-400 transition">
            Get Started
          </button>
        </div>

        {/* PROFESSIONAL TIER */}
        <div className="border-2 border-[#1B2850] rounded-2xl p-8 bg-white relative shadow-lg">
          <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-[#1B2850] text-white px-4 py-1 rounded-full text-sm font-semibold">
            Most Popular
          </div>
          
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-[#1B2850] uppercase tracking-wide mb-2">
              Professional
            </h3>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Build meaningful relationships faster
            </h2>
            <div className="flex items-baseline mb-6">
              <span className="text-4xl font-bold text-slate-900">$49</span>
              <span className="text-slate-500 ml-2">/month</span>
            </div>
          </div>
          
          <ul className="space-y-4 mb-6">
            <li className="flex items-start">
              <svg className="w-5 h-5 text-emerald-600 mr-3 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-slate-700">More introductions, refreshed more frequently</span>
            </li>
            <li className="flex items-start">
              <svg className="w-5 h-5 text-emerald-600 mr-3 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-slate-700">Priority access to higher-relevance matches</span>
            </li>
            <li className="flex items-start">
              <svg className="w-5 h-5 text-emerald-600 mr-3 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-slate-700">Increased visibility to other members</span>
            </li>
            <li className="flex items-start">
              <svg className="w-5 h-5 text-emerald-600 mr-3 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-slate-700 font-semibold">10 introduction credits per month</span>
            </li>
          </ul>

          <div className="mb-8 p-3 bg-slate-50 rounded-lg border border-slate-200">
            <p className="text-sm text-slate-600 italic text-center">
              See better matches, more often
            </p>
          </div>

          <button className="w-full py-3 px-6 bg-[#1B2850] text-white font-semibold rounded-lg hover:bg-[#2a3a6b] transition">
            Upgrade to Professional
          </button>
        </div>

        {/* EXECUTIVE TIER */}
        <div className="border border-slate-200 rounded-2xl p-8 bg-gradient-to-br from-slate-50 to-white">
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2">
              Executive
            </h3>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Access the most valuable connections
            </h2>
            <div className="flex items-baseline mb-6">
              <span className="text-4xl font-bold text-slate-900">$99</span>
              <span className="text-slate-500 ml-2">/month</span>
            </div>
          </div>
          
          <ul className="space-y-4 mb-8">
            <li className="flex items-start">
              <svg className="w-5 h-5 text-emerald-600 mr-3 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-slate-700 font-semibold">Top placement in the matching system</span>
            </li>
            <li className="flex items-start">
              <svg className="w-5 h-5 text-emerald-600 mr-3 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-slate-700">Priority access to the highest-value members</span>
            </li>
            <li className="flex items-start">
              <svg className="w-5 h-5 text-emerald-600 mr-3 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-slate-700">More frequent, highly curated introductions</span>
            </li>
            <li className="flex items-start">
              <svg className="w-5 h-5 text-emerald-600 mr-3 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-slate-700 font-semibold">20 introduction credits per month</span>
            </li>
          </ul>

          <button className="w-full py-3 px-6 bg-slate-900 text-white font-semibold rounded-lg hover:bg-slate-800 transition">
            Upgrade to Executive
          </button>
        </div>
      </div>

      {/* How It Works Section */}
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-10 mb-12">
        <h2 className="text-2xl font-bold text-slate-900 mb-4 text-center">
          How introductions work
        </h2>
        <p className="text-lg text-slate-600 text-center max-w-3xl mx-auto leading-relaxed">
          You'll receive curated introductions based on your profile and preferences. 
          When both people express interest, we facilitate the connection.
        </p>
      </div>

      {/* Credits Explanation */}
      <div className="max-w-3xl mx-auto">
        <div className="bg-white border border-slate-200 rounded-xl p-8">
          <h3 className="text-xl font-bold text-slate-900 mb-3">
            Introduction Credits
          </h3>
          <p className="text-slate-600 leading-relaxed">
            Credits are only used when an introduction is successfully made. Your monthly plan 
            includes credits, and you can purchase additional credits if you want more access.
          </p>
        </div>
      </div>

      {/* FAQ or Additional Info (Optional) */}
      <div className="mt-16 text-center">
        <p className="text-sm text-slate-500">
          Questions about pricing?{' '}
          <a href="mailto:hello@andrel.app" className="text-[#1B2850] font-semibold hover:underline">
            Contact us
          </a>
        </p>
      </div>
    </div>
  )
}
