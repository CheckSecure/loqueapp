/**
 * Tier Override Logic for Founding Members
 * 
 * Founding members get premium features without Stripe subscription.
 * This is an application-level override only - does NOT modify Stripe.
 */

export function getEffectiveTier(profile: any): string {
  // Check if founding member status is active
  if (profile.is_founding_member) {
    // Check expiration if set
    if (profile.founding_member_expires_at) {
      const expirationDate = new Date(profile.founding_member_expires_at)
      if (expirationDate < new Date()) {
        // Expired - fall through to regular tier
        return profile.subscription_tier || 'free'
      }
    }
    
    // Active founding member - treat as premium
    return 'founding'
  }
  
  // Regular tier from Stripe
  return profile.subscription_tier || 'free'
}

export function getMonthlyCredits(effectiveTier: string): number {
  const MONTHLY_CREDITS: Record<string, number> = {
    free: 3,
    professional: 10,
    executive: 20,
    founding: 30  // Higher credit allocation for founding members
  }
  
  return MONTHLY_CREDITS[effectiveTier] || 3
}

export function getCreditCap(effectiveTier: string): number {
  const CREDIT_CAPS: Record<string, number> = {
    free: 6,
    professional: 20,
    executive: 40,
    founding: 60  // Higher cap for founding members
  }
  
  return CREDIT_CAPS[effectiveTier] || 6
}
