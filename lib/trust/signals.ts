'use server'

import { createClient } from '@/lib/supabase/server'

type SignalType = 'profile_complete' | 'message_sent' | 'message_replied' | 'meeting_scheduled' | 'meeting_completed' | 'intro_accepted'

const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  profile_complete: 5,
  message_sent: 2,
  message_replied: 3,
  meeting_scheduled: 10,
  meeting_completed: 15,
  intro_accepted: 5,
}

export async function trackTrustSignal(userId: string, signalType: SignalType) {
  const supabase = createClient()
  
  await supabase.from('trust_signals').insert({
    user_id: userId,
    signal_type: signalType,
    signal_value: SIGNAL_WEIGHTS[signalType]
  })

  await updateTrustScore(userId)
}

async function updateTrustScore(userId: string) {
  const supabase = createClient()
  
  const { data: signals } = await supabase
    .from('trust_signals')
    .select('signal_type, signal_value, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (!signals || signals.length === 0) {
    return
  }

  let score = 50
  
  const signalCounts: Partial<Record<SignalType, number>> = {}
  for (const signal of signals) {
    const count = signalCounts[signal.signal_type as SignalType] || 0
    signalCounts[signal.signal_type as SignalType] = count + 1
    
    const multiplier = count === 0 ? 1 : 0.5
    score += signal.signal_value * multiplier
  }

  score = Math.min(100, Math.round(score))

  await supabase
    .from('profiles')
    .update({ trust_score: score })
    .eq('id', userId)
}

export async function checkProfileCompletion(userId: string) {
  const supabase = createClient()
  
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, title, company, expertise, purposes, bio')
    .eq('id', userId)
    .single()

  if (!profile) return false

  const isComplete = !!(
    profile.full_name &&
    profile.title &&
    profile.company &&
    profile.expertise?.length > 0 &&
    profile.purposes?.length > 0 &&
    profile.bio
  )

  if (isComplete) {
    const { data: existing } = await supabase
      .from('trust_signals')
      .select('id')
      .eq('user_id', userId)
      .eq('signal_type', 'profile_complete')
      .single()

    if (!existing) {
      await trackTrustSignal(userId, 'profile_complete')
    }
  }

  return isComplete
}
