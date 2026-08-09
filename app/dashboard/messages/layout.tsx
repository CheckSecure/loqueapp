'use client'

import { PresenceProvider } from '@/components/presence/PresenceProvider'

/**
 * One presence provider for the whole Messages route tree. It persists across navigations
 * between the conversation list and an individual conversation, so switching conversations
 * updates the header IMMEDIATELY from the shared label map (no new poll per conversation) and
 * the list + header + expanded profile all share a single batched poll.
 */
export default function MessagesLayout({ children }: { children: React.ReactNode }) {
  return <PresenceProvider>{children}</PresenceProvider>
}
