import { NextRequest, NextResponse } from 'next/server'
import { generateOnboardingRecommendations } from '@/lib/generate-recommendations'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const { userId } = await request.json()
    
    if (!userId) {
      return NextResponse.json({ error: 'userId required' }, { status: 400 })
    }
    
    const result = await generateOnboardingRecommendations(userId)
    
    return NextResponse.json({ 
      success: true,
      count: result.count,
      message: `Generated ${result.count} onboarding recommendations`
    })
    
  } catch (error: any) {
    console.error('[generate-recommendations] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
