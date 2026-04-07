function isCompatiblePair(userA: any, userB: any): boolean {
  // 1. Geographic compatibility
  const aScope = userA.geographic_scope || 'us-wide'
  const bScope = userB.geographic_scope || 'us-wide'
  const aCity = userA.city?.toLowerCase().trim()
  const bCity = userB.city?.toLowerCase().trim()
  const aState = userA.state?.toLowerCase().trim()
  const bState = userB.state?.toLowerCase().trim()
  
  // If BOTH want local only, they must be in same city/state
  if (aScope === 'local' && bScope === 'local') {
    const sameCity = aCity && bCity && aCity === bCity
    const sameState = aState && bState && aState === bState
    if (!sameCity && !sameState) return false
  }
  
  // If ONE wants local only, check if other is in same area
  if (aScope === 'local' && bScope === 'us-wide') {
    const sameCity = aCity && bCity && aCity === bCity
    const sameState = aState && bState && aState === bState
    if (!sameCity && !sameState) return false
  }
  
  if (bScope === 'local' && aScope === 'us-wide') {
    const sameCity = aCity && bCity && aCity === bCity
    const sameState = aState && bState && aState === bState
    if (!sameCity && !sameState) return false
  }
  
  // 2. Meeting format compatibility
  const aFormat = userA.meeting_format_preference || 'both'
  const bFormat = userB.meeting_format_preference || 'both'
  
  // Incompatible if one wants ONLY virtual and other wants ONLY in-person
  if ((aFormat === 'virtual' && bFormat === 'in-person') ||
      (aFormat === 'in-person' && bFormat === 'virtual')) {
    return false
  }
  
  return true
}

function scoreMatch(recipient: any, candidate: any): number {
  let score = 0

  // 1. Intro preferences match
  const recipientPrefs: string[] = recipient.intro_preferences || []
  const candidateRole: string = candidate.role_type || ''
  if (recipientPrefs.some((p: string) => p.toLowerCase() === candidateRole.toLowerCase())) {
    score += 30
  }

  // 2. Reverse match
  const candidatePrefs: string[] = candidate.intro_preferences || []
  const recipientRole: string = recipient.role_type || ''
  if (candidatePrefs.some((p: string) => p.toLowerCase() === recipientRole.toLowerCase())) {
    score += 20
  }

  // 3. Purpose alignment - NEW
  const recipientPurposes: string[] = recipient.purposes || []
  const candidatePurposes: string[] = candidate.purposes || []
  const purposeOverlap = recipientPurposes.filter((p: string) =>
    candidatePurposes.some((cp: string) => cp.toLowerCase() === p.toLowerCase())
  ).length
  score += purposeOverlap * 12

  // 4. Expertise complementarity - NEW
  const recipientExpertise: string[] = recipient.expertise || []
  const candidateExpertise: string[] = candidate.expertise || []
  const expertiseOverlap = recipientExpertise.filter((e: string) =>
    candidateExpertise.some((ce: string) => ce.toLowerCase() === e.toLowerCase())
  ).length
  // Bonus for SOME overlap but not total overlap (complementary is better)
  if (expertiseOverlap > 0 && expertiseOverlap < Math.min(recipientExpertise.length, candidateExpertise.length)) {
    score += expertiseOverlap * 8
  }

  // 5. Geographic alignment bonus - NEW
  const recipientScope = recipient.geographic_scope || 'us-wide'
  const candidateScope = candidate.geographic_scope || 'us-wide'
  const sameCity = recipient.city?.toLowerCase().trim() === candidate.city?.toLowerCase().trim()
  const sameState = recipient.state?.toLowerCase().trim() === candidate.state?.toLowerCase().trim()
  
  if (recipientScope === 'local' && (sameCity || sameState)) {
    score += 15 // Strong bonus for local matches when preferred
  } else if (sameCity) {
    score += 8 // Mild bonus for same city even if not required
  } else if (sameState) {
    score += 5 // Small bonus for same state
  }

  // 6. Meeting format alignment bonus - NEW
  const recipientFormat = recipient.meeting_format_preference || 'both'
  const candidateFormat = candidate.meeting_format_preference || 'both'
  
  if (recipientFormat === candidateFormat) {
    score += 10 // Bonus for exact format match
  } else if (recipientFormat === 'both' || candidateFormat === 'both') {
    score += 5 // Small bonus if one is flexible
  }

  // 7. Seniority strategic pairing - UPDATED
  const recipientSeniority = recipient.seniority?.toLowerCase()
  const candidateSeniority = candidate.seniority?.toLowerCase()
  
  // Bonus for strategic seniority pairings
  if (recipientSeniority === 'junior' && ['senior', 'executive', 'c-suite'].includes(candidateSeniority || '')) {
    score += 12 // Junior benefits from senior
  } else if (['senior', 'executive', 'c-suite'].includes(recipientSeniority || '') && candidateSeniority === 'junior') {
    score += 8 // Senior can mentor junior
  } else if (recipientSeniority === candidateSeniority && recipientSeniority) {
    score += 5 // Peer connections also valuable
  }

  // 8. Interests overlap (existing)
  const recipientInterests: string[] = recipient.interests || []
  const candidateInterests: string[] = candidate.interests || []
  const interestOverlap = recipientInterests.filter((i: string) =>
    candidateInterests.some((ci: string) => ci.toLowerCase() === i.toLowerCase())
  ).length
  score += interestOverlap * 10

  // 9. Mentorship compatibility (existing)
  const rMentor = recipient.mentorship_role?.toLowerCase()
  const cMentor = candidate.mentorship_role?.toLowerCase()
  if ((rMentor === 'mentor' && cMentor === 'mentee') ||
      (rMentor === 'mentee' && cMentor === 'mentor')) {
    score += 25
  }

  // 10. Tier boost (existing)
  const tierBoost: Record<string, number> = { executive: 15, professional: 8, free: 0 }
  score += tierBoost[candidate.subscription_tier] ?? 0

  // 11. Network scores (existing)
  if (candidate.networkValueScore) {
    score += Math.round((candidate.networkValueScore / 100) * 15)
  }
  if (candidate.responsivenessScore) {
    score += Math.round((candidate.responsivenessScore / 100) * 5)
  }

  return score
}

function generateReason(recipient: any, candidate: any): string {
  const recipientPrefs: string[] = recipient.intro_preferences || []
  const candidateRole: string = candidate.role_type || ''
  const recipientPurposes: string[] = recipient.purposes || []
  const candidatePurposes: string[] = candidate.purposes || []
  const recipientExpertise: string[] = recipient.expertise || []
  const candidateExpertise: string[] = candidate.expertise || []
  const recipientInterests: string[] = recipient.interests || []
  const candidateInterests: string[] = candidate.interests || []

  const sharedPurposes = recipientPurposes.filter((p: string) =>
    candidatePurposes.some((cp: string) => cp.toLowerCase() === p.toLowerCase())
  )
  
  const sharedExpertise = recipientExpertise.filter((e: string) =>
    candidateExpertise.some((ce: string) => ce.toLowerCase() === e.toLowerCase())
  )
  
  const sharedInterests = recipientInterests.filter((i: string) =>
    candidateInterests.some((ci: string) => ci.toLowerCase() === i.toLowerCase())
  )

  const rMentor = recipient.mentorship_role?.toLowerCase()
  const cMentor = candidate.mentorship_role?.toLowerCase()
  
  const sameCity = recipient.city?.toLowerCase().trim() === candidate.city?.toLowerCase().trim()
  const candidateName = candidate.full_name?.split(' ')[0] || 'They'

  // Priority 1: Purpose + Expertise alignment
  if (sharedPurposes.length > 0 && sharedExpertise.length > 0) {
    return `${candidateName} shares your focus on ${sharedPurposes[0]} with expertise in ${sharedExpertise[0]} — strong strategic alignment.`
  }

  // Priority 2: Mentorship
  if (rMentor === 'mentee' && cMentor === 'mentor') {
    return `${candidateName} is an experienced mentor in your field — strong mentorship alignment.`
  }
  if (rMentor === 'mentor' && cMentor === 'mentee') {
    return `${candidateName} is looking for guidance in areas where you have deep expertise.`
  }

  // Priority 3: Local connection
  if (sameCity && recipient.geographic_scope === 'local') {
    return `${candidateName} is based in ${recipient.city} and matches your preference for local connections.`
  }

  // Priority 4: Purpose alignment
  if (sharedPurposes.length > 0) {
    return `${candidateName} is also focused on ${sharedPurposes[0]} — aligned on goals and timing.`
  }

  // Priority 5: Shared interests
  if (sharedInterests.length >= 2) {
    return `You both share a focus on ${sharedInterests.slice(0, 2).join(' and ')} — strong thematic alignment.`
  }

  // Priority 6: Role preference match
  if (recipientPrefs.some((p: string) => p.toLowerCase() === candidateRole.toLowerCase())) {
    return `${candidateName} matches the type of connection you're looking for — curated based on your preferences.`
  }

  // Fallback
  return `Curated based on your professional background and stated goals.`
}
