import { and, desc, eq, or } from 'drizzle-orm'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { MessagingApp } from '@/components/messaging-app'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { ensureDatabaseSchema } from '@/lib/db/ensure-schema'
import { conversations, federationFriendships, messages, profiles } from '@/lib/db/schema'

export const dynamic = 'force-dynamic'

export default async function Page() {
  await ensureDatabaseSchema()

  // First boot check: If no profiles exist, redirect to the 60-second Setup Wizard
  const existingProfiles = await db.select({ userId: profiles.userId }).from(profiles).limit(1)
  if (existingProfiles.length === 0) {
    redirect('/setup')
  }

  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/sign-in')

  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, session.user.id))
  if (!profile) redirect('/sign-up')

  const rows = await db
    .select()
    .from(conversations)
    .where(or(eq(conversations.userAId, session.user.id), eq(conversations.userBId, session.user.id)))
    .orderBy(desc(conversations.createdAt))

  const remoteFriends = await db
    .select()
    .from(federationFriendships)
    .where(
      and(
        eq(federationFriendships.localUserId, session.user.id),
        or(eq(federationFriendships.status, 'active'), eq(federationFriendships.status, 'pending'))
      )
    )

  const otherIds = rows.map((row) => (row.userAId === session.user.id ? row.userBId : row.userAId))
  const otherProfiles = otherIds.length
    ? await db.select().from(profiles).where(or(...otherIds.map((id) => eq(profiles.userId, id))))
    : []

  // Pre-load recent messages for fast conversation preview
  const convIds = rows.map((r) => r.id)
  const recentMsgs = convIds.length
    ? await db.select().from(messages).orderBy(desc(messages.createdAt)).limit(200)
    : []

  const lastMsgMap = new Map<string, { body: string; createdAt: Date; senderId: string }>()
  for (const m of recentMsgs) {
    if (!lastMsgMap.has(m.conversationId)) {
      lastMsgMap.set(m.conversationId, {
        body: m.body,
        createdAt: m.createdAt,
        senderId: m.senderId,
      })
    }
  }

  const conversationsForUi = rows.flatMap((row) => {
    const otherId = row.userAId === session.user.id ? row.userBId : row.userAId
    const other = otherProfiles.find((item) => item.userId === otherId)
    const lastMsg = lastMsgMap.get(row.id) ?? null
    if (other) {
      return [
        {
          id: row.id,
          otherUser: { username: other.username, displayName: other.displayName },
          status: row.status || 'active',
          lastMessage: lastMsg,
          remote: false,
          pending: false,
        },
      ]
    }
    const cleanOther = otherId.replace(/^@/, '')
    return [
      {
        id: row.id,
        otherUser: { username: cleanOther, displayName: `@${cleanOther}` },
        status: row.status || 'active',
        lastMessage: lastMsg,
        remote: true,
        pending: false,
      },
    ]
  })

  const remoteConversations = remoteFriends.map((friend) => {
    const localConversation = rows.find(
      (row) => row.userAId === friend.remoteUsername || row.userBId === friend.remoteUsername
    )
    const lastMsg = localConversation ? lastMsgMap.get(localConversation.id) ?? null : null
    return {
      id: localConversation?.id ?? `remote:${friend.id}`,
      otherUser: { username: friend.remoteUsername, displayName: `@${friend.remoteUsername}` },
      status: localConversation?.status || 'active',
      lastMessage: lastMsg,
      remote: !localConversation,
      pending: friend.status === 'pending',
    }
  })

  return (
    <MessagingApp
      username={profile.username}
      displayName={profile.displayName}
      currentUserId={session.user.id}
      conversations={[...conversationsForUi, ...remoteConversations]}
    />
  )
}
