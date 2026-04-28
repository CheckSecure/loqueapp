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
]
