'use server'

import { createClient } from '@/lib/supabase/server'

interface VerificationResult {
  status: 'high_confidence' | 'flagged' | 'pending'
  metadata: {
    linkedin_provided: boolean
    name_match?: boolean
    title_match?: boolean
    company_match?: boolean
    checks_performed: string[]
    flagged_reasons?: string[]
  }
}

export async function verifyLinkedInConsistency(
  userId: string,
  profileData: {
    fullName: string
    title: string
    company: string
    linkedinUrl?: string
  }
): Promise<VerificationResult> {
  const supabase = createClient()
  
  const metadata: VerificationResult['metadata'] = {
    linkedin_provided: !!profileData.linkedinUrl,
    checks_performed: []
  }

  // If no LinkedIn provided, return pending
  if (!profileData.linkedinUrl) {
    return { status: 'pending', metadata }
  }

  const flaggedReasons: string[] = []
  
  // Basic LinkedIn URL validation
  const isValidLinkedIn = /^https?:\/\/(www\.)?linkedin\.com\/in\/.+/.test(profileData.linkedinUrl)
  if (!isValidLinkedIn) {
    flaggedReasons.push('Invalid LinkedIn URL format')
    metadata.checks_performed.push('url_format')
  }

  // Email domain vs company check (soft signal)
  const { data: { user } } = await supabase.auth.getUser()
  if (user?.email) {
    const emailDomain = user.email.split('@')[1]
    const companyName = profileData.company.toLowerCase()
    
    const domainMatchesCompany = emailDomain.toLowerCase().includes(companyName.replace(/[^a-z0-9]/g, '')) ||
                                 companyName.replace(/[^a-z0-9]/g, '').includes(emailDomain.split('.')[0])
    
    metadata.checks_performed.push('email_domain_match')
    
    if (domainMatchesCompany && !emailDomain.includes('gmail') && !emailDomain.includes('yahoo')) {
      metadata.company_match = true
    }
  }

  // Title plausibility check
  const suspiciousTitles = ['ceo', 'founder', 'general counsel', 'chief', 'president', 'vp', 'svp']
  const hasSuspiciousTitle = suspiciousTitles.some(t => profileData.title.toLowerCase().includes(t))
  
  const genericDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com']
  const hasGenericEmail = user?.email ? genericDomains.some(d => user.email!.includes(d)) : false
  
  if (hasSuspiciousTitle && hasGenericEmail && !metadata.company_match) {
    flaggedReasons.push('High-level title with generic email domain')
    metadata.checks_performed.push('title_email_consistency')
  }

  // Determine final status
  let finalStatus: 'high_confidence' | 'flagged' | 'pending'
  
  if (flaggedReasons.length > 0) {
    finalStatus = 'flagged'
    metadata.flagged_reasons = flaggedReasons
  } else if (isValidLinkedIn && metadata.company_match) {
    finalStatus = 'high_confidence'
  } else if (isValidLinkedIn) {
    finalStatus = 'high_confidence'
  } else {
    finalStatus = 'pending'
  }

  // Update profile with verification status
  await supabase
    .from('profiles')
    .update({
      verification_status: finalStatus,
      verification_metadata: metadata,
      verified_method: 'auto'
    })
    .eq('id', userId)

  return { status: finalStatus, metadata }
}
