import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, or } from 'drizzle-orm'
import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { conversations, federationFriendships, federationRequests, friendRequests, messages, profiles } from '@/lib/db/schema'
import { notifyUser } from '@/lib/push'
import { emitUserEvent } from '@/lib/events'
import { createFederationHeadersAsync, getPublicOrigin, hashToken, isAllowedOrigin, remoteApiUrl } from '@/lib/federation'

async function getUserId() {
  const session = await auth.api.getSession({ headers: await headers() })
  return session?.user?.id ?? null
}

export async function GET(request: Request) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const url = new URL(request.url)
  const conversationId = url.searchParams.get('conversationId')
  const sinceParam = url.searchParams.get('since') || url.searchParams.get('last_message_at')
  const statusFilter = url.searchParams.get('status') // 'active', 'archived', 'all'
  const filterType = url.searchParams.get('filter') // 'unread', etc.
  const searchQuery = (url.searchParams.get('q') || '').trim().toLowerCase()
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '40', 10), 1), 100)
  const page = Math.max(parseInt(url.searchParams.get('page') || '0', 10), 0)
  const offset = parseInt(url.searchParams.get('offset') || String(page * limit), 10)

  if (conversationId) {
    let resolvedId = conversationId

    // If client requested a remote friendship conversation by friendship ID (e.g. remote:friendshipId)
    if (resolvedId.startsWith('remote:')) {
      const friendshipId = resolvedId.slice('remote:'.length)
      const [friendship] = await db.select().from(federationFriendships).where(and(
        eq(federationFriendships.id, friendshipId),
        eq(federationFriendships.localUserId, userId)
      )).limit(1)

      if (friendship) {
        const [userAId, userBId] = [userId, friendship.remoteUsername].sort()
        let [existing] = await db.select().from(conversations).where(or(
          and(eq(conversations.userAId, friendship.remoteUsername), eq(conversations.userBId, userId)),
          and(eq(conversations.userAId, userId), eq(conversations.userBId, friendship.remoteUsername)),
          and(eq(conversations.userAId, userAId), eq(conversations.userBId, userBId))
        )).limit(1)

        if (!existing) {
          const [created] = await db.insert(conversations).values({
            id: randomUUID(),
            userAId,
            userBId,
            status: 'active',
          }).onConflictDoNothing().returning()
          existing = created ?? (await db.select().from(conversations).where(
            and(eq(conversations.userAId, userAId), eq(conversations.userBId, userBId))
          ).limit(1))[0]
        }
        resolvedId = existing?.id ?? resolvedId
      }
    }

    let conversation = await db.select().from(conversations).where(and(
      eq(conversations.id, resolvedId),
      or(eq(conversations.userAId, userId), eq(conversations.userBId, userId))
    ))

    if (!conversation[0]) {
      // Check if conversationId was passed as a username or userId
      const cleanHandle = resolvedId.replace(/^@/, '')
      const [otherProf] = await db.select().from(profiles).where(or(
        eq(profiles.userId, resolvedId),
        eq(profiles.username, cleanHandle)
      )).limit(1)

      if (otherProf) {
        const [uA, uB] = [userId, otherProf.userId].sort()
        const [foundConv] = await db.select().from(conversations).where(or(
          and(eq(conversations.userAId, uA), eq(conversations.userBId, uB)),
          and(eq(conversations.userAId, otherProf.userId), eq(conversations.userBId, userId)),
          and(eq(conversations.userAId, userId), eq(conversations.userBId, otherProf.userId))
        )).limit(1)
        if (foundConv) {
          resolvedId = foundConv.id
          conversation = [foundConv]
        }
      }
    }

    if (!conversation[0]) {
      return NextResponse.json({ messages: [], conversationId: resolvedId }, { headers: { 'Cache-Control': 'no-store' } })
    }

    let rows: any[] = []
    if (sinceParam && Number.isFinite(Number(sinceParam))) {
      const sinceDate = new Date(Number(sinceParam))
      rows = await db.select().from(messages).where(and(
        eq(messages.conversationId, resolvedId),
        gt(messages.createdAt, sinceDate)
      )).orderBy(asc(messages.createdAt)).limit(100)
    } else {
      rows = await db.select().from(messages).where(eq(messages.conversationId, resolvedId)).orderBy(asc(messages.createdAt)).limit(200)
    }

    return NextResponse.json({
      messages: rows,
      conversationId: resolvedId,
      status: conversation[0]?.status || 'active',
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // Load all user conversations and friend requests
  const rows = await db.select().from(conversations)
    .where(or(eq(conversations.userAId, userId), eq(conversations.userBId, userId)))
    .orderBy(desc(conversations.createdAt))

  const profileRows = await db.select().from(profiles)
  const profile = profileRows.find((row) => row.userId === userId)

  const localRequests = await db.select().from(friendRequests)
    .where(and(eq(friendRequests.recipientId, userId), eq(friendRequests.status, 'pending')))
  const incomingRequests = localRequests.map((request) => ({
    ...request,
    remote: false,
    sender: profileRows.find((p) => p.userId === request.senderId) ?? null
  }))

  const federationRows = profile ? await db.select().from(federationRequests).where(and(
    eq(federationRequests.recipientUsername, profile.username),
    eq(federationRequests.status, 'pending')
  )) : []

  // Pre-load latest messages for previews and instant live ordering
  const convIdSet = new Set(rows.map((r) => r.id))
  let allRecentMessages: any[] = []
  try {
    const allMsgs = await db.select().from(messages).orderBy(desc(messages.createdAt))
    allRecentMessages = allMsgs.filter((m) => convIdSet.has(m.conversationId))
  } catch {
    allRecentMessages = []
  }

  const lastMessageMap = new Map<string, { body: string; createdAt: Date; senderId: string }>()
  for (const m of allRecentMessages) {
    if (!lastMessageMap.has(m.conversationId)) {
      lastMessageMap.set(m.conversationId, {
        body: m.body,
        createdAt: m.createdAt,
        senderId: m.senderId
      })
    }
  }

  // Hydrate local conversations
  const conversationsForUi = rows.flatMap((row) => {
    const otherId = row.userAId === userId ? row.userBId : row.userAId
    const other = profileRows.find((item) => item.userId === otherId)
    const lastMsg = lastMessageMap.get(row.id) ?? (row.lastMessageSnippet ? { body: row.lastMessageSnippet, createdAt: row.lastMessageAt || row.createdAt, senderId: '' } : null)
    if (other) {
      return [{
        id: row.id,
        otherUser: { username: other.username, displayName: other.displayName },
        status: row.status || 'active',
        remote: false,
        pending: false,
        lastMessage: lastMsg
      }]
    }
    // Remote friend stored locally
    const remoteName = otherId.replace(/^@/, '')
    return [{
      id: row.id,
      otherUser: { username: remoteName, displayName: `@${remoteName}` },
      status: row.status || 'active',
      remote: true,
      pending: false,
      lastMessage: lastMsg
    }]
  })

  // Hydrate remote friendships
  const remoteFriends = await db.select().from(federationFriendships).where(and(
    eq(federationFriendships.localUserId, userId),
    or(eq(federationFriendships.status, 'active'), eq(federationFriendships.status, 'pending'))
  ))

  const remoteConversations = remoteFriends.map((friend) => {
    const localConversation = rows.find((row) => row.userAId === friend.remoteUsername || row.userBId === friend.remoteUsername)
    const convId = localConversation?.id ?? `remote:${friend.id}`
    const lastMsg = localConversation ? (lastMessageMap.get(localConversation.id) ?? null) : null
    return {
      id: convId,
      otherUser: { username: friend.remoteUsername, displayName: `@${friend.remoteUsername}` },
      status: localConversation?.status || 'active',
      remote: !localConversation,
      pending: friend.status === 'pending',
      lastMessage: lastMsg
    }
  })

  // Deduplicate conversations strictly by username to avoid duplicate cards for the same friend
  const allConversations = [...conversationsForUi, ...remoteConversations]
  let dedupedConversations: typeof allConversations = []
  const seenUsernames = new Set<string>()
  for (const item of allConversations) {
    const key = item.otherUser.username.toLowerCase()
    if (!seenUsernames.has(key)) {
      seenUsernames.add(key)
      dedupedConversations.push(item)
    }
  }

  // Filter by status if specified ('active', 'archived')
  if (statusFilter && statusFilter !== 'all') {
    dedupedConversations = dedupedConversations.filter((c) => (c.status || 'active') === statusFilter)
  }

  // Filter by search query if provided
  if (searchQuery) {
    dedupedConversations = dedupedConversations.filter((c) =>
      c.otherUser.username.toLowerCase().includes(searchQuery) ||
      c.otherUser.displayName.toLowerCase().includes(searchQuery)
    )
  }

  // Sort by latest message timestamp so active conversations appear at the top
  dedupedConversations.sort((a, b) => {
    const timeA = a.lastMessage?.createdAt ? new Date(a.lastMessage.createdAt).getTime() : 0
    const timeB = b.lastMessage?.createdAt ? new Date(b.lastMessage.createdAt).getTime() : 0
    return timeB - timeA
  })

  const total = dedupedConversations.length
  const paginatedList = dedupedConversations.slice(offset, offset + limit)

  return NextResponse.json({
    conversations: paginatedList,
    total,
    page,
    limit,
    hasMore: offset + limit < total,
    requests: [
      ...incomingRequests,
      ...federationRows.map((request) => ({
        ...request,
        remote: true,
        sender: { username: request.senderUsername, displayName: request.senderUsername }
      }))
    ]
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: Request) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const body = await request.json().catch(() => null)
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
  const messageBody = typeof body?.body === 'string' ? body.body.trim() : ''
  if (!conversationId || !messageBody || messageBody.length > 4000) {
    return NextResponse.json({ error: 'Invalid message' }, { status: 400 })
  }

  const [senderProfile] = await db.select({ username: profiles.username }).from(profiles).where(eq(profiles.userId, userId)).limit(1)
  if (!senderProfile) return NextResponse.json({ error: 'Sender profile not found' }, { status: 404 })

  // Resolve whether this message is destined for a remote federation contact
  let storedConversation = conversationId.startsWith('remote:')
    ? null
    : (await db.select().from(conversations).where(and(
        eq(conversations.id, conversationId),
        or(eq(conversations.userAId, userId), eq(conversations.userBId, userId))
      )).limit(1))[0] ?? null

  let remoteFriendship = null

  if (storedConversation) {
    const otherUserId = storedConversation.userAId === userId ? storedConversation.userBId : storedConversation.userAId
    const [friendship] = await db.select().from(federationFriendships).where(and(
      eq(federationFriendships.localUserId, userId),
      or(
        eq(federationFriendships.remoteUsername, otherUserId),
        eq(federationFriendships.remoteUserId, otherUserId)
      )
    )).limit(1)
    remoteFriendship = friendship ?? null
  } else if (conversationId.startsWith('remote:')) {
    const friendshipId = conversationId.slice('remote:'.length)
    const [friendship] = await db.select().from(federationFriendships).where(and(
      eq(federationFriendships.id, friendshipId),
      eq(federationFriendships.localUserId, userId)
    )).limit(1)
    remoteFriendship = friendship ?? null
  }

  // Handle remote federation delivery
  if (remoteFriendship) {
    const friendship = remoteFriendship
    const remoteUsername = friendship.remoteUsername

    // Ensure local conversation record exists
    const [userAId, userBId] = [userId, remoteUsername].sort()
    let [localConversation] = await db.select().from(conversations).where(or(
      and(eq(conversations.userAId, userId), eq(conversations.userBId, remoteUsername)),
      and(eq(conversations.userAId, remoteUsername), eq(conversations.userBId, userId)),
      and(eq(conversations.userAId, userAId), eq(conversations.userBId, userBId))
    )).limit(1)

    if (!localConversation) {
      const [created] = await db.insert(conversations).values({
        id: randomUUID(),
        userAId,
        userBId,
        status: 'active',
        lastMessageSnippet: messageBody.slice(0, 100),
        lastMessageAt: new Date(),
      }).onConflictDoNothing().returning()
      localConversation = created ?? (await db.select().from(conversations).where(
        and(eq(conversations.userAId, userAId), eq(conversations.userBId, userBId))
      ).limit(1))[0]
    } else {
      await db.update(conversations).set({
        lastMessageSnippet: messageBody.slice(0, 100),
        lastMessageAt: new Date(),
        status: 'active',
      }).where(eq(conversations.id, localConversation.id))
    }

    const convId = localConversation?.id ?? randomUUID()
    const myOrigin = getPublicOrigin(request)

    const payload = JSON.stringify({
      eventId: randomUUID(),
      token: 'relay-federation-v1',
      senderUsername: senderProfile.username,
      senderOrigin: myOrigin,
      recipientUsername: remoteUsername,
      body: messageBody,
    })

    // 1. Insert into database immediately so the sender never waits
    const [created] = await db.insert(messages).values({
      id: randomUUID(),
      conversationId: convId,
      senderId: userId,
      body: messageBody,
      deliveredAt: null,
    }).returning()

    // 2. Broadcast to sender's own stream so any other open devices sync in <20ms
    emitUserEvent(userId, {
      type: 'message',
      message: {
        id: created.id,
        conversationId: convId,
        senderId: userId,
        body: created.body,
        createdAt: created.createdAt,
        deliveredAt: created.deliveredAt,
      },
      conversationId: convId,
      senderUsername: senderProfile.username,
      recipientUsername: remoteUsername,
    })

    // 3. Dispatch peer delivery asynchronously in the background using WebCrypto ECDSA headers
    if (friendship.remoteDeploymentId && isAllowedOrigin(friendship.remoteDeploymentId)) {
      void (async () => {
        try {
          const authHeaders = await createFederationHeadersAsync(payload)
          const response = await fetch(remoteApiUrl(friendship.remoteDeploymentId, '/api/federation/v1/messages'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeaders },
            body: payload,
            signal: AbortSignal.timeout(10000),
            cache: 'no-store',
          })
          if (response.ok) {
            await db.update(messages).set({ deliveredAt: new Date() }).where(eq(messages.id, created.id))
          }
        } catch (err) {
          console.warn('[Federation Background Delivery] Warning:', err instanceof Error ? err.message : err)
        }
      })()
    }

    return NextResponse.json({ message: created, conversationId: convId }, { status: 201 })
  }

  // Handle local conversation delivery
  let targetConversation = storedConversation
  if (!targetConversation) {
    const [convByUser] = await db.select().from(conversations).where(or(
      and(eq(conversations.userAId, userId), eq(conversations.userBId, conversationId)),
      and(eq(conversations.userAId, conversationId), eq(conversations.userBId, userId))
    )).limit(1)
    targetConversation = convByUser ?? null
  }

  if (!targetConversation) {
    const [otherProfile] = await db.select().from(profiles).where(or(
      eq(profiles.userId, conversationId),
      eq(profiles.username, conversationId.replace(/^@/, ''))
    )).limit(1)
    if (otherProfile && otherProfile.userId !== userId) {
      const [uA, uB] = [userId, otherProfile.userId].sort()
      const [existing] = await db.select().from(conversations).where(and(
        eq(conversations.userAId, uA),
        eq(conversations.userBId, uB)
      )).limit(1)
      if (existing) {
        targetConversation = existing
      } else {
        const [newConv] = await db.insert(conversations).values({
          id: randomUUID(),
          userAId: uA,
          userBId: uB,
          status: 'active',
          lastMessageSnippet: messageBody.slice(0, 100),
          lastMessageAt: new Date(),
        }).onConflictDoNothing().returning()
        targetConversation = newConv ?? (await db.select().from(conversations).where(and(
          eq(conversations.userAId, uA),
          eq(conversations.userBId, uB)
        )).limit(1))[0]
      }
    }
  }

  if (!targetConversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

  const convId = targetConversation.id
  const [created] = await db.insert(messages).values({
    id: randomUUID(),
    conversationId: convId,
    senderId: userId,
    body: messageBody,
    deliveredAt: new Date()
  }).returning()

  // Update conversation lastMessage metadata & activate
  await db.update(conversations).set({
    lastMessageSnippet: messageBody.slice(0, 100),
    lastMessageAt: new Date(),
    status: 'active',
  }).where(eq(conversations.id, convId))

  const recipientId = targetConversation.userAId === userId ? targetConversation.userBId : targetConversation.userAId
  const [recipientProfile] = await db.select({ username: profiles.username }).from(profiles).where(eq(profiles.userId, recipientId)).limit(1)

  // Broadcast to sender
  emitUserEvent(userId, {
    type: 'message',
    message: {
      id: created.id,
      conversationId: convId,
      senderId: userId,
      body: created.body,
      createdAt: created.createdAt,
      deliveredAt: created.deliveredAt,
    },
    conversationId: convId,
    senderUsername: senderProfile.username,
    recipientUsername: recipientProfile?.username ?? recipientId,
  })

  // Broadcast to recipient
  emitUserEvent(recipientId, {
    type: 'message',
    message: {
      id: created.id,
      conversationId: convId,
      senderId: userId,
      body: created.body,
      createdAt: created.createdAt,
      deliveredAt: created.deliveredAt,
    },
    conversationId: convId,
    senderUsername: senderProfile.username,
    recipientUsername: recipientProfile?.username ?? recipientId,
  })

  void notifyUser(recipientId, {
    title: senderProfile ? `@${senderProfile.username}` : 'New message',
    body: messageBody,
    conversationId: convId
  }).catch(() => undefined)

  return NextResponse.json({ message: created, conversationId: convId }, { status: 201 })
}

export async function PUT(request: Request) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const body = await request.json().catch(() => null)
  const messageId = typeof body?.messageId === 'string' ? body.messageId : ''
  if (!messageId) return NextResponse.json({ error: 'Invalid message' }, { status: 400 })

  const [message] = await db.select().from(messages).where(eq(messages.id, messageId))
  if (!message) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  const [conversation] = await db.select().from(conversations).where(and(
    eq(conversations.id, message.conversationId),
    or(eq(conversations.userAId, userId), eq(conversations.userBId, userId)),
  ))
  if (!conversation) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  if (message.senderId === userId) return NextResponse.json({ error: 'Only the recipient can mark this read' }, { status: 403 })
  const [updated] = await db.update(messages).set({ readAt: new Date() }).where(eq(messages.id, messageId)).returning()
  return NextResponse.json({ message: updated })
}

export async function PATCH(request: Request) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const body = await request.json().catch(() => null)

  // 1. Status toggle for high-volume inbox: 'active' | 'archived' | 'closed'
  if (typeof body?.conversationId === 'string' && typeof body?.status === 'string') {
    const convId = body.conversationId
    const newStatus = ['active', 'archived', 'closed'].includes(body.status) ? body.status : 'active'
    await db.update(conversations).set({ status: newStatus }).where(and(
      eq(conversations.id, convId),
      or(eq(conversations.userAId, userId), eq(conversations.userBId, userId))
    ))
    return NextResponse.json({ ok: true, conversationId: convId, status: newStatus })
  }

  // 2. Friend request by handle or URL
  const rawHandle = typeof body?.handle === 'string' ? body.handle.trim() : ''

  // Support full remote profile URL: e.g. https://chatze2.vercel.app/u/suraj97
  const remoteMatch = rawHandle.match(/^(https?:\/\/[^/]+)\/u\/([a-z0-9_]{3,32})\/?$/i)
  if (remoteMatch) {
    const remoteOrigin = new URL(remoteMatch[1]).origin
    const localOrigin = getPublicOrigin(request)
    if (remoteOrigin !== localOrigin) {
      if (!isAllowedOrigin(remoteOrigin)) return NextResponse.json({ error: 'Invalid remote profile URL' }, { status: 400 })
      const [sender] = await db.select({ username: profiles.username }).from(profiles).where(eq(profiles.userId, userId)).limit(1)
      if (!sender) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

      const remoteRecipient = remoteMatch[2].toLowerCase()
      const connectionToken = `conn_${randomUUID().replace(/-/g, '')}`
      const payload = JSON.stringify({
        idempotencyKey: randomUUID(),
        senderOrigin: localOrigin,
        senderUsername: sender.username,
        recipientUsername: remoteRecipient,
        connectionToken,
      })

      const authHeaders = await createFederationHeadersAsync(payload)
      const response = await fetch(remoteApiUrl(remoteOrigin, '/api/federation/v1/requests'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: payload,
        signal: AbortSignal.timeout(8000)
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.requestId) {
        await db.insert(federationFriendships).values({
          id: randomUUID(),
          localUserId: userId,
          remoteDeploymentId: remoteOrigin,
          remoteUserId: data.requestId,
          remoteUsername: remoteRecipient,
          status: 'pending',
          tokenHash: hashToken(connectionToken),
          tokenVersion: 'v1'
        }).onConflictDoNothing()
      }
      return NextResponse.json(data, { status: response.status })
    }
  }

  // Handle local username formats: @user, /u/user, u/user, user
  const username = rawHandle.replace(/^@/, '').replace(/^\/?u\//, '').toLowerCase()
  if (!/^[a-z0-9_]{3,32}$/.test(username)) return NextResponse.json({ error: 'Enter a valid username or /u/ path' }, { status: 400 })
  const [recipient] = await db.select().from(profiles).where(eq(profiles.username, username))
  const [senderProfile] = await db.select({ username: profiles.username }).from(profiles).where(eq(profiles.userId, userId)).limit(1)
  if (!recipient || recipient.userId === userId || !senderProfile) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  const [created] = await db.insert(friendRequests).values({ id: randomUUID(), senderId: userId, recipientId: recipient.userId, status: 'pending' }).onConflictDoNothing().returning()
  if (created) {
    emitUserEvent(recipient.userId, {
      type: 'friend_request',
      requestId: created.id,
      senderUsername: senderProfile.username,
      remote: false,
      sender: {
        username: senderProfile.username,
        displayName: senderProfile.username,
      },
    })
    void notifyUser(recipient.userId, { title: 'New friend request', body: `@${senderProfile.username} wants to connect.` }).catch(() => undefined)
  }
  return NextResponse.json({ request: created ?? null }, { status: created ? 201 : 200 })
}

export async function DELETE(request: Request) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const { requestId, accept, clearAll } = await request.json().catch(() => ({}))

  if (clearAll === true) {
    const userConversations = await db.select({ id: conversations.id }).from(conversations).where(or(eq(conversations.userAId, userId), eq(conversations.userBId, userId)))
    for (const conversation of userConversations) await db.delete(messages).where(eq(messages.conversationId, conversation.id))
    await db.delete(conversations).where(or(eq(conversations.userAId, userId), eq(conversations.userBId, userId)))
    await db.delete(friendRequests).where(or(eq(friendRequests.senderId, userId), eq(friendRequests.recipientId, userId)))
    await db.delete(federationFriendships).where(eq(federationFriendships.localUserId, userId))
    return NextResponse.json({ ok: true })
  }

  if (typeof requestId !== 'string' || typeof accept !== 'boolean') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const [requestRow] = await db.select().from(friendRequests).where(and(eq(friendRequests.id, requestId), eq(friendRequests.recipientId, userId), eq(friendRequests.status, 'pending')))

  if (!requestRow) {
    // Check if this is a remote federation request
    const profile = (await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1))[0]
    const [remoteRequest] = profile ? await db.select().from(federationRequests).where(and(eq(federationRequests.id, requestId), eq(federationRequests.recipientUsername, profile.username), eq(federationRequests.status, 'pending'))).limit(1) : []
    if (!remoteRequest) return NextResponse.json({ error: 'Request not found' }, { status: 404 })

    await db.update(federationRequests).set({ status: accept ? 'accepted' : 'declined', updatedAt: new Date() }).where(eq(federationRequests.id, requestId))

    if (accept) {
      const myOrigin = getPublicOrigin(request)
      const connectionToken = `conn_${randomUUID().replace(/-/g, '')}`

      // Create active friendship locally
      await db.insert(federationFriendships).values({
        id: randomUUID(),
        localUserId: userId,
        remoteDeploymentId: remoteRequest.senderOrigin,
        remoteUserId: remoteRequest.senderUsername,
        remoteUsername: remoteRequest.senderUsername,
        status: 'active',
        tokenHash: hashToken(connectionToken),
        tokenVersion: 'v1',
        acceptedAt: new Date()
      }).onConflictDoNothing()

      // Create local conversation
      const [conversationA, conversationB] = [userId, remoteRequest.senderUsername].sort()
      let [conv] = await db.select().from(conversations).where(and(
        eq(conversations.userAId, conversationA),
        eq(conversations.userBId, conversationB)
      )).limit(1)

      if (!conv) {
        const [created] = await db.insert(conversations).values({
          id: randomUUID(),
          userAId: conversationA,
          userBId: conversationB,
          status: 'active',
        }).returning()
        conv = created
      }

      emitUserEvent(userId, {
        type: 'friend_accepted',
        conversationId: conv?.id ?? '',
        remoteUsername: remoteRequest.senderUsername,
        friend: {
          username: remoteRequest.senderUsername,
          displayName: `@${remoteRequest.senderUsername}`,
        },
      })

      // Notify the remote sender deployment
      const acceptance = JSON.stringify({
        requestId,
        senderOrigin: myOrigin,
        senderUsername: remoteRequest.senderUsername,
        recipientUsername: profile.username,
        connectionToken,
      })

      const authHeaders = await createFederationHeadersAsync(acceptance)
      void fetch(remoteApiUrl(remoteRequest.senderOrigin, '/api/federation/v1/requests'), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: acceptance,
        signal: AbortSignal.timeout(8000)
      }).catch(() => null)
    }
    return NextResponse.json({ ok: true, remote: true })
  }

  // Handle local friend request accept/decline
  await db.update(friendRequests).set({ status: accept ? 'accepted' : 'declined', updatedAt: new Date() }).where(eq(friendRequests.id, requestId))
  if (accept) {
    const [userAId, userBId] = [requestRow.senderId, requestRow.recipientId].sort()
    let [conv] = await db.select().from(conversations).where(and(
      eq(conversations.userAId, userAId),
      eq(conversations.userBId, userBId)
    )).limit(1)

    if (!conv) {
      const [created] = await db.insert(conversations).values({ id: randomUUID(), userAId, userBId, status: 'active' }).returning()
      conv = created
    }

    const [senderProfile] = await db.select().from(profiles).where(eq(profiles.userId, requestRow.senderId)).limit(1)
    const [recipientProfile] = await db.select().from(profiles).where(eq(profiles.userId, requestRow.recipientId)).limit(1)

    if (senderProfile && recipientProfile && conv) {
      emitUserEvent(requestRow.senderId, {
        type: 'friend_accepted',
        conversationId: conv.id,
        remoteUsername: recipientProfile.username,
        friend: {
          username: recipientProfile.username,
          displayName: recipientProfile.displayName,
        },
      })

      emitUserEvent(requestRow.recipientId, {
        type: 'friend_accepted',
        conversationId: conv.id,
        remoteUsername: senderProfile.username,
        friend: {
          username: senderProfile.username,
          displayName: senderProfile.displayName,
        },
      })

      void notifyUser(requestRow.senderId, {
        title: 'Friend request accepted',
        body: `@${recipientProfile.username} accepted your friend request!`,
        conversationId: conv.id,
      }).catch(() => undefined)
    }
  }
  return NextResponse.json({ ok: true })
}
