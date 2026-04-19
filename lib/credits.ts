/**
 * Credit Type Management Utility
 * 
 * Handles dual credit system:
 * - Free Credits: Refill monthly, basic usage
 * - Premium Credits: Purchased only, unlock enhanced features
 */

export interface CreditBalance {
  free_credits: number
  premium_credits: number
  total: number
}

export interface CreditDeduction {
  free_used: number
  premium_used: number
  total_used: number
  remaining_free: number
  remaining_premium: number
}

/**
 * Deduct credits with priority: free first, then premium
 */
export function deductCredits(
  currentFree: number,
  currentPremium: number,
  amount: number
): CreditDeduction {
  let freeUsed = 0
  let premiumUsed = 0
  
  // Use free credits first
  if (currentFree >= amount) {
    freeUsed = amount
  } else {
    // Use all available free credits
    freeUsed = currentFree
    // Use premium credits for remainder
    const remainder = amount - freeUsed
    premiumUsed = Math.min(remainder, currentPremium)
  }
  
  return {
    free_used: freeUsed,
    premium_used: premiumUsed,
    total_used: freeUsed + premiumUsed,
    remaining_free: currentFree - freeUsed,
    remaining_premium: currentPremium - premiumUsed
  }
}

/**
 * Check if user has enough credits (free + premium combined)
 */
export function hasEnoughCredits(
  free: number,
  premium: number,
  required: number
): boolean {
  return (free + premium) >= required
}

/**
 * Get total credit balance
 */
export function getTotalCredits(free: number, premium: number): number {
  return free + premium
}

/**
 * Check if user used premium credits (for flagging premium actions)
 */
export function usedPremiumCredits(deduction: CreditDeduction): boolean {
  return deduction.premium_used > 0
}
