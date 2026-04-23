// Simple profile type
type Profile = {
  id: string
  full_name: string | null
  title: string | null
  company: string | null
  bio: string | null
  [key: string]: any
}

interface IcebreakerContext {
  userA: Profile
  userB: Profile
  sharedIndustry?: string
  sharedField?: string
  reason?: string
}

/**
 * Extract the first sentence of a bio, trimmed and cleaned for inline use.
 */
function firstBioClause(bio: string): string {
  const firstSentence = bio.split(/[.!?]/)[0] || ''
  return firstSentence
    .trim()
    .replace(/^(and|but|so|however)\s+/i, '')
    .replace(/\s+/g, ' ')
}

/**
 * Generate contextual icebreaker prompts for a new introduction.
 * Uses title / company / bio — the fields actually present on profiles.
 */
export function generateIcebreakers(context: IcebreakerContext): string[] {
  const { userB } = context
  const prompts: string[] = []

  if (userB.title && userB.company) {
    prompts.push(
      `Would be great to hear how you're approaching your role as ${userB.title} at ${userB.company}.`
    )
  } else if (userB.company) {
    prompts.push(
      `Would be great to hear what you're currently focused on at ${userB.company}.`
    )
  } else if (userB.title) {
    prompts.push(
      `Curious what you're currently focused on as ${userB.title}.`
    )
  }

  if (userB.bio) {
    const clause = firstBioClause(userB.bio)
    if (clause && clause.length >= 8 && clause.length <= 140) {
      prompts.push(
        `Your background stood out — would be great to hear more about ${clause}.`
      )
    }
  }

  // Generic fallbacks to ensure we always return at least 2 prompts
  prompts.push(
    `Curious what you're currently focused on in your work.`,
    `Would be great to exchange perspectives on your area of focus.`
  )

  return prompts.slice(0, 3)
}

/**
 * Generate system intro message for a new conversation.
 */
export function generateSystemIntroMessage(context: IcebreakerContext): string {
  const { userA, userB, reason } = context

  const lines: string[] = [
    "You've been introduced based on shared professional interests."
  ]

  if (reason) {
    lines.push('', `Reason for connection: ${reason}`)
  }

  const sharedElements: string[] = []

  if ((userA as any).industry && (userB as any).industry && (userA as any).industry === (userB as any).industry) {
    sharedElements.push(`Both work in ${(userA as any).industry}`)
  }

  const aPractices = (userA as any).practice_areas as string[] | undefined
  const bPractices = (userB as any).practice_areas as string[] | undefined
  if (aPractices && bPractices) {
    const shared = aPractices.filter(pa => bPractices.includes(pa))
    if (shared.length > 0) {
      sharedElements.push(`Shared practice area: ${shared[0]}`)
    }
  }

  if (sharedElements.length > 0) {
    lines.push('', 'Shared background:')
    sharedElements.forEach(element => {
      lines.push(`• ${element}`)
    })
  }

  lines.push('', 'Start the conversation by introducing yourselves or discussing a relevant topic.')

  return lines.join('\n')
}
