import { NextResponse } from 'next/server'
import { completeOnboarding } from '@/app/actions'

export async function GET() {
  const fd = new FormData()
  fd.append('full_name', 'Test User')
  fd.append('title', 'CEO')
  fd.append('company', 'Test Corp')
  fd.append('city', 'New York')
  fd.append('state', 'NY')
  fd.append('role_type', 'In-house Counsel')
  fd.append('seniority', 'Senior')
  fd.append('expertise', 'M&A,Corporate Law')
  fd.append('bio', 'Test bio')
  fd.append('looking_for', 'Test')
  fd.append('intro_preferences', 'Law firm attorney,In-house attorney')
  fd.append('purposes', 'Business development')
  fd.append('meeting_format_preference', 'both')
  fd.append('geographic_scope', 'us-wide')
  
  const result = await completeOnboarding(fd)
  
  return NextResponse.json({ result })
}
