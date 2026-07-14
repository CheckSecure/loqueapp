/**
 * Canonical shared profile options.
 *
 * Used everywhere a user can select expertise (onboarding, settings,
 * profile edit). DO NOT define new expertise lists in component files —
 * import from here. This keeps the matching engine's exact-string compare
 * working consistently.
 *
 * To add a new expertise tag: add it to EXPERTISE_OPTIONS below and ship.
 * Existing user data with non-canonical values is preserved as
 * "Additional expertise" in profile edit surfaces (display + remove only,
 * not selectable for new entries).
 */
export const EXPERTISE_OPTIONS: string[] = [
  // ─── Original 33 (preserved verbatim, exact order) ───
  'Legal',
  'Privacy',
  'Data Protection',
  'Compliance',
  'Regulatory',
  'Investigations',
  'Litigation',
  'Employment',
  'M&A',
  'Corporate Governance',
  'Contracts',
  'Commercial',
  'Intellectual Property',
  'Technology',
  'Cybersecurity',
  'AI',
  'Legal Operations',
  'eDiscovery',
  'Risk',
  'Finance',
  'Fundraising',
  'Strategy',
  'Operations',
  'Sales',
  'Marketing',
  'Product',
  'Healthcare',
  'Policy',
  'Government',
  'Real Estate',
  'Energy',
  'Tax',
  'Insurance',
  // ─── Phase D additions (all genuinely new — no existing equivalent concept) ───
  // Finance
  'FP&A',
  'Treasury',
  'Capital Markets',
  'Accounting',
  'Corporate Development',
  // Sales / Revenue / GTM
  'Enterprise Sales',
  'Revenue Operations',
  'Customer Success',
  'GTM Strategy',
  'Demand Generation',
  // Marketing
  'Brand',
  'Communications',
  'Product Marketing',
  // Technology
  'Cloud',
  'Data',
  'Engineering',
  // Operations
  'Digital Transformation',
  'Supply Chain',
  'Process Improvement',
  // Government Affairs / Policy
  'Public Affairs',
  'Lobbying',
  // HR / People
  'Compensation',
  'Benefits',
  'Recruiting',
  'Talent',
  'People Operations',
  'Leadership Development',
  // Healthcare
  'Life Sciences',
  'Pharma',
  'Medical Devices',
  // ─── Phase E additions — canonicalized from previously-saved member values ───
  'Business Development',
  'Legal Technology',
  'Networking',
]
