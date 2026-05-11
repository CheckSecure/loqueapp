import { NextRequest, NextResponse } from 'next/server'
import { generateOnboardingRecommendations } from '@/lib/generate-recommendations'
import { requireAdmin } from '@/lib/admin/requireAdmin'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin()
  if (error) return error

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
