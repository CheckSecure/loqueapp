// ────────────────────────────────────────────────────────────────────────────
// UI REVIEW MODE — render-only demo data.
//
// Reachable ONLY when ALL THREE gates pass in page.tsx:
//   (1) process.env.NODE_ENV === 'development'
//   (2) supabase.auth.getUser() resolves to user.email === 'alexandra@horizoncapital.com'
//   (3) searchParams.demo === 'full'
// In production builds NODE_ENV === 'production', so the demo branch is dead
// code at runtime regardless of query string or who's logged in.
//
// SAFETY contracts enforced by this file's shape:
//   - This module imports NOTHING from @supabase, ./supabase/server, ./supabase/client,
//     ./lib/*, ./api/*, next/headers, next/server, or anything else that could
//     reach a write path. It exports static const objects only.
//   - Each row carries `isDemo: true as const`. renderFeatured/renderAdditional
//     branch on row.isDemo and render <button type="button"> with no onClick —
//     the production CTAs (RequestIntroButton, WithdrawInterestButton,
//     submitIntroRequest, /api/intro-requests/*) are unreachable from these rows.
//   - `matchReason` strings render as prose through the existing renderReasonBlock
//     (first branch: row.matchReason → <p>…</p>). They are never written anywhere
//     and never participate in matching/scoring/credits/analytics/email.
//
// Names/titles/companies/bios below are INVENTED placeholder content for the
// UI Review surface. The triple gate is the contract that prevents them from
// reaching a production render.
// ────────────────────────────────────────────────────────────────────────────

export const DEMO_FEATURED = {
  rowId: 'demo-featured',
  alreadyRequested: false,
  isDemo: true as const,
  matchReason:
    'You both work with PE-backed healthcare companies and share a focus on governance and risk. Sarah specializes in board oversight and could be a valuable peer in your network.',
  profile: {
    id: 'demo-sarah-whitman',
    full_name: 'Sarah Whitman',
    avatar_url: null,
    title: 'Partner',
    exact_job_title: null,
    role_type: null,
    company: 'Whitman Legal Group',
    location: 'Washington, DC',
    bio:
      'Specializes in government investigations and compliance. Two decades advising boards and audit committees of PE-backed healthcare companies.',
    seniority: 'Partner',
    mentorship_role: null,
    interests: ['Governance', 'Compliance', 'Healthcare', 'PE'],
  },
}

export const DEMO_ADDITIONAL = [
  {
    rowId: 'demo-james',
    alreadyRequested: false,
    isDemo: true as const,
    matchReason:
      'You both navigate complex enterprise regulation at scale — James leads legal for a Fortune 500 retailer and shares your focus on governance maturity.',
    profile: {
      id: 'demo-james-carter',
      full_name: 'James Carter',
      avatar_url: null,
      title: 'General Counsel',
      exact_job_title: null,
      role_type: null,
      company: 'Fortune 500 Retail',
      location: null,
      bio: null,
      seniority: 'General Counsel',
      mentorship_role: null,
      interests: [],
    },
  },
  {
    rowId: 'demo-priya',
    alreadyRequested: false,
    isDemo: true as const,
    matchReason:
      'Strong overlap on healthcare investments and post-deal governance. Priya leads operating diligence at a major PE firm — adjacent context to your work.',
    profile: {
      id: 'demo-priya-natarajan',
      full_name: 'Priya Natarajan',
      avatar_url: null,
      title: 'Managing Director',
      exact_job_title: null,
      role_type: null,
      company: 'Private Equity Firm',
      location: null,
      bio: null,
      seniority: 'Managing Director',
      mentorship_role: null,
      interests: [],
    },
  },
  {
    rowId: 'demo-michael',
    alreadyRequested: false,
    isDemo: true as const,
    matchReason:
      'You both operate at the board level in growth-stage healthtech. Michael runs a Series B company in your sector and would value an executive peer.',
    profile: {
      id: 'demo-michael-lee',
      full_name: 'Michael Lee',
      avatar_url: null,
      title: 'Founder & CEO',
      exact_job_title: null,
      role_type: null,
      company: 'Series B HealthTech',
      location: null,
      bio: null,
      seniority: 'Founder & CEO',
      mentorship_role: null,
      interests: [],
    },
  },
  {
    rowId: 'demo-elena',
    alreadyRequested: false,
    isDemo: true as const,
    matchReason:
      'Strong overlap on growth-stage finance and audit-committee readiness. Elena scaled her company from Series B to C and brings sharp CFO instincts.',
    profile: {
      id: 'demo-elena-park',
      full_name: 'Elena Park',
      avatar_url: null,
      title: 'Chief Financial Officer',
      exact_job_title: null,
      role_type: null,
      company: 'Series C SaaS',
      location: null,
      bio: null,
      seniority: 'CFO',
      mentorship_role: null,
      interests: [],
    },
  },
  {
    rowId: 'demo-david',
    alreadyRequested: false,
    isDemo: true as const,
    matchReason:
      'You both work at the intersection of capital and operations. David sits on portfolio boards and brings a balanced perspective on governance trade-offs.',
    profile: {
      id: 'demo-david-okonkwo',
      full_name: 'David Okonkwo',
      avatar_url: null,
      title: 'Operating Partner',
      exact_job_title: null,
      role_type: null,
      company: 'Mid-Market Growth Fund',
      location: null,
      bio: null,
      seniority: 'Operating Partner',
      mentorship_role: null,
      interests: [],
    },
  },
]
