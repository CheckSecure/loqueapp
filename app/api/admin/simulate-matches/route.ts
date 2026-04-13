import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

// Tier-based match counts
const TIER_MATCH_COUNTS: Record<string, [number, number]> = {
  'platinum': [3, 5],
  'gold': [3, 4],
  'silver': [2, 3],
  'bronze': [1, 2],
  'professional': [2, 3],
  'executive': [3, 4],
  'free': [1, 2]
}

function getRandomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function calculateMatchScore(userA: any, userB: any): number {
  let score = 0

  // Role compatibility
  if (userA.role_type === 'in_house' && userB.role_type === 'law_firm') score += 30
  if (userA.role_type === 'law_firm' && userB.role_type === 'in_house') score += 30
  if (userA.role_type === userB.role_type) score += 15

  // Seniority alignment (±1 level)
  const seniorityLevels = ['junior', 'mid-level', 'senior', 'executive', 'c-suite']
  const aLevel = seniorityLevels.indexOf(userA.seniority?.toLowerCase() || 'mid-level')
  const bLevel = seniorityLevels.indexOf(userB.seniority?.toLowerCase() || 'mid-level')
  const levelDiff = Math.abs(aLevel - bLevel)
  if (levelDiff === 0) score += 20
  if (levelDiff === 1) score += 15
  if (levelDiff === 2) score += 10

  // Location bonus (same state/city)
  if (userA.location && userB.location && userA.location === userB.location) score += 15

  // Expertise overlap
  if (userA.expertise && userB.expertise) {
    const aExpertise = userA.expertise.toLowerCase()
    const bExpertise = userB.expertise.toLowerCase()
    if (aExpertise.includes(bExpertise) || bExpertise.includes(aExpertise)) score += 20
  }

  // Intro preferences overlap
  if (userA.intro_preferences && userB.intro_preferences) {
    const overlap = userA.intro_preferences.filter((p: string) => 
      userB.intro_preferences.includes(p)
    )
    score += overlap.length * 5
  }

  // Random variance for realism
  score += getRandomInt(-10, 10)

  return Math.max(0, Math.min(100, score))
}

export async function POST(request: Request) {
  const supabase = createClient()
  
  // Auth check
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // PART 1: Identify stuck users
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, email, subscription_tier, role_type, seniority, expertise, intro_preferences, location, company')
      .eq('account_status', 'active')

    if (!profiles) throw new Error('Failed to fetch profiles')

    // Get existing matches
    const { data: existingMatches } = await supabase
      .from('matches')
      .select('user_a_id, user_b_id, status')

    const matchCounts: Record<string, number> = {}
    existingMatches?.forEach(m => {
      if (m.status === 'active') {
        matchCounts[m.user_a_id] = (matchCounts[m.user_a_id] || 0) + 1
        matchCounts[m.user_b_id] = (matchCounts[m.user_b_id] || 0) + 1
      }
    })

    // Get intro request counts
    const { data: intros } = await supabase
      .from('intro_requests')
      .select('requester_id, target_user_id, status')

    const introCounts: Record<string, number> = {}
    intros?.forEach(i => {
      if (i.status === 'pending' || i.status === 'approved') {
        introCounts[i.requester_id] = (introCounts[i.requester_id] || 0) + 1
        introCounts[i.target_user_id] = (introCounts[i.target_user_id] || 0) + 1
      }
    })

    const stuckUsers = profiles.filter(p => 
      (matchCounts[p.id] || 0) === 0 && (introCounts[p.id] || 0) === 0
    )

    console.log(`Found ${stuckUsers.length} stuck users`)

    // PART 2 & 3: Generate and create matches
    const createdMatches: any[] = []
    const matchSet = new Set<string>() // Track created pairs

    for (const user of stuckUsers) {
      const tier = user.subscription_tier || 'free'
      const [minMatches, maxMatches] = TIER_MATCH_COUNTS[tier] || [1, 2]
      const targetMatches = getRandomInt(minMatches, maxMatches)
      
      // Calculate scores for all potential matches
      const candidates = profiles
        .filter(p => p.id !== user.id)
        .map(p => ({
          profile: p,
          score: calculateMatchScore(user, p)
        }))
        .sort((a, b) => b.score - a.score)

      // Select top candidates
      let matchesCreated = 0
      for (const candidate of candidates) {
        if (matchesCreated >= targetMatches) break

        const pairKey = [user.id, candidate.profile.id].sort().join('|')
        if (matchSet.has(pairKey)) continue

        // Check if match already exists
        const exists = existingMatches?.some(m =>
          (m.user_a_id === user.id && m.user_b_id === candidate.profile.id) ||
          (m.user_a_id === candidate.profile.id && m.user_b_id === user.id)
        )
        if (exists) continue

        // Create match
        const { data: match, error: matchError } = await supabase
          .from('matches')
          .insert({
            user_a_id: user.id,
            user_b_id: candidate.profile.id,
            status: 'active',
            admin_facilitated: true,
            admin_notes: `Simulated match (score: ${candidate.score})`
          })
          .select()
          .single()

        if (matchError) {
          console.error('Match creation error:', matchError)
          continue
        }

        // Create conversation
        await supabase.from('conversations').insert({
          match_id: match.id
        })

        // PART 4: Optionally add a simulated message (50% chance)
        if (Math.random() > 0.5) {
          const { data: conversation } = await supabase
            .from('conversations')
            .select('id')
            .eq('match_id', match.id)
            .single()

          if (conversation) {
            const messages = [
              "Looking forward to connecting!",
              "Great to meet a fellow legal professional.",
              "Thanks for the connection!",
              "Excited to learn more about your work.",
              "Happy to connect!"
            ]
            const randomMessage = messages[getRandomInt(0, messages.length - 1)]

            await supabase.from('messages').insert({
              conversation_id: conversation.id,
              sender_id: Math.random() > 0.5 ? user.id : candidate.profile.id,
              content: randomMessage,
              created_at: new Date().toISOString()
            })
          }
        }

        matchSet.add(pairKey)
        createdMatches.push({
          userA: user.full_name,
          userB: candidate.profile.full_name,
          score: candidate.score,
          tierA: tier,
          tierB: candidate.profile.subscription_tier
        })
        matchesCreated++
      }
    }

    // PART 8: Generate statistics
    const tierDistribution: Record<string, number> = {}
    createdMatches.forEach(m => {
      tierDistribution[m.tierA] = (tierDistribution[m.tierA] || 0) + 1
    })

    // Recount stuck users
    const { data: updatedMatches } = await supabase
      .from('matches')
      .select('user_a_id, user_b_id, status')

    const updatedMatchCounts: Record<string, number> = {}
    updatedMatches?.forEach(m => {
      if (m.status === 'active') {
        updatedMatchCounts[m.user_a_id] = (updatedMatchCounts[m.user_a_id] || 0) + 1
        updatedMatchCounts[m.user_b_id] = (updatedMatchCounts[m.user_b_id] || 0) + 1
      }
    })

    const remainingStuck = profiles.filter(p =>
      (updatedMatchCounts[p.id] || 0) === 0 && (introCounts[p.id] || 0) === 0
    )

    return NextResponse.json({
      success: true,
      stats: {
        initialStuckUsers: stuckUsers.length,
        matchesCreated: createdMatches.length,
        remainingStuckUsers: remainingStuck.length,
        tierDistribution,
        sampleMatches: createdMatches.slice(0, 10),
        averageScore: createdMatches.reduce((sum, m) => sum + m.score, 0) / createdMatches.length || 0
      }
    })

  } catch (error: any) {
    console.error('Simulation error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
