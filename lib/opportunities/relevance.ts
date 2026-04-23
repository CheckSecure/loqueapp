/**
 * lib/opportunities/relevance.ts
 *
 * Business-need → accepted provider role_types mapping. Values match the
 * actual vocabulary in profiles.role_type as of April 2026.
 */

const NEED_TO_ROLE_TYPES: Record<string, string[]> = {
  'litigation support': ['Law firm attorney'],
  'privacy counsel': ['Law firm attorney', 'In-house Counsel'],
  'privacy': ['Law firm attorney', 'In-house Counsel'],
  'm&a advisory': ['Law firm attorney', 'Consultant'],
  'm&a': ['Law firm attorney', 'Consultant'],
  'antitrust': ['Law firm attorney'],
  'employment counsel': ['Law firm attorney', 'In-house Counsel'],
  'tax counsel': ['Law firm attorney', 'Consultant'],
  'ip counsel': ['Law firm attorney'],
  'compliance': ['Law firm attorney', 'Consultant', 'In-house Counsel', 'Compliance'],
  'regulatory': ['Law firm attorney', 'Consultant', 'In-house Counsel', 'Compliance'],
  'corporate governance': ['Law firm attorney', 'Consultant'],
  'strategy consulting': ['Consultant'],
  'operations consulting': ['Consultant', 'Legal Operations'],
  'financial advisory': ['Consultant'],
  'investigations': ['Law firm attorney', 'Consultant'],
};

const DEFAULT_ROLE_TYPES: string[] = ['Law firm attorney', 'Consultant'];

export function acceptedRoleTypesForNeed(need?: string): string[] {
  if (!need) return DEFAULT_ROLE_TYPES;
  const key = need.toLowerCase().trim();
  if (NEED_TO_ROLE_TYPES[key]) return NEED_TO_ROLE_TYPES[key];
  for (const [k, v] of Object.entries(NEED_TO_ROLE_TYPES)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return DEFAULT_ROLE_TYPES;
}
