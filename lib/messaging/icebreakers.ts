import { Database } from '@/types/supabase'

type Profile = Database['public']['Tables']['profiles']['Row']

interface IcebreakerContext {
  userA: Profile
  userB: Profile
  sharedIndustry?: string
  sharedField?: string
  reason?: string
}

/**
 * Generate contextual icebreaker prompts for a new introduction
 */
export function generateIcebreakers(context: IcebreakerContext): string[] {
  const { userA, userB } = context
  
  const icebreakers: string[] = []

  // Role-based icebreaker
  if (userB.company) {
    icebreakers.push(
      `What are you currently focused on in your role at ${userB.company}?`
    )
  } else if (userB.title) {
    icebreakers.push(
      `What are you currently focused on in your ${userB.title} role?`
    )
  }

  // Industry/field discussion
  const industries = [userA.industry, userB.industry].filter(Boolean)
  if (industries.length > 0) {
    const industry = industries[0]
    icebreakers.push(
      `Would be great to hear your perspective on trends in ${industry}.`
    )
  }

  // Practice area for legal professionals
  const practices = [
    userA.practice_areas?.[0], 
    userB.practice_areas?.[0]
  ].filter(Boolean)
  
  if (practices.length > 0) {
    icebreakers.push(
      `Curious about your experience with ${practices[0]} matters.`
    )
  }

  // Generic professional icebreakers as fallback
  if (icebreakers.length < 2) {
    icebreakers.push(
      'What brought you to the platform?',
      'What are you hoping to get out of this connection?'
    )
  }

  // Return top 3
  return icebreakers.slice(0, 3)
}

/**
 * Generate system intro message for a new conversation
 */
export function generateSystemIntroMessage(context: IcebreakerContext): string {
  const { userA, userB, reason } = context
  
  const lines: string[] = [
    "You've been introduced based on shared professional interests."
  ]

  // Add reason if available
  if (reason) {
    lines.push('', `Reason for connection: ${reason}`)
  }

  // Add shared context
  const sharedElements: string[] = []
  
  if (userA.industry && userB.industry && userA.industry === userB.industry) {
    sharedElements.push(`Both work in ${userA.industry}`)
  }
  
  if (userA.practice_areas && userB.practice_areas) {
    const shared = userA.practice_areas.filter(pa => 
      userB.practice_areas?.includes(pa)
    )
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
