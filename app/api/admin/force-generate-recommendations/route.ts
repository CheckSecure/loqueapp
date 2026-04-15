import { NextRequest, NextResponse } from 'next/server'
import { generateOnboardingRecommendations } from '@/lib/generate-recommendations'

export async function GET(req: NextRequest) {
  // Check for secret key in URL to prevent abuse
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== 'generate-recs-2026') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = req.nextUrl.searchParams.get('userId')
  if (!userId) {
    return NextResponse.json({ error: 'userId required' }, { status: 400 })
  }
  
  try {
    const result = await generateOnboardingRecommendations(userId)
    return NextResponse.json({ success: true, ...result })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
