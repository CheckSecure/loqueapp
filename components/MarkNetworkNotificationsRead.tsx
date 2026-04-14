'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function MarkNetworkNotificationsRead({ userId }: { userId: string }) {
  const router = useRouter()
  
  useEffect(() => {
    const markAsRead = async () => {
      const supabase = createClient()
      await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('user_id', userId)
        .in('type', ['intro_accepted', 'new_connection'])
        .is('read_at', null)
      
      // Refresh to update the badge count
      router.refresh()
    }
    
    markAsRead()
  }, [userId, router])
  
  return null
}
