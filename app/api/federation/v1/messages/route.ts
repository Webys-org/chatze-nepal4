import { randomUUID } from 'node:crypto'
import { and, eq, or } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { conversations, federationFriendships, federationInbox, messages, profiles } from '@/lib/db/schema'
import { verifyFederationSignature } from '@/lib/federation'
import { notifyUser } from '@/lib/push'
import { emitUserEvent } from '@/lib/events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const raw = await request.text()
    if (raw.length > 32_000) return NextResponse.json({ error: 'Payload too large' }, { status: 413 })

    const timestamp = request.headers.get('x-federation-timestamp') || ''
    const signature = request.headers.get('x-federation-signature') || ''
    if (!verifyFederationSignature(raw, timestamp, signature)) {
      return NextResponse.json({ error: 'Invalid federation signature' }, { status: 401 })
    }

    let body: {
      eventId?: string
      token?: string
      senderUsername?: string
      senderOrigin?: string
      recipientUsername?: string
      body?: string
      conversationId?: string
    }

    try {
      body = JSON.parse(raw)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    if (!body.eventId || !body.body?.trim() || body.body.length > 4000 || !body.senderUsername) {
      return NextResponse.json({ error: 'Invalid event payload' }, { status: 400 })
    }

    const senderUsername = body.senderUsername.trim().toLowerCase()
    const senderOrigin = body.senderOrigin ? new URL(body.senderOrigin).origin : ''

    // Check idempotency deduplication
    const [existing] = await db.select().from(federationInbox).where(eq(federationInbox.remoteEventId, body.eventId)).limit(1)
    if (existing) {
      return NextResponse.json({ ok: true, duplicate: true, messageId: existing.id }, { status: 200 })
    }

    // Locate the local friendship for this sender
    const rawFriendships = await db.select().from(federationFriendships).where(
      eq(federationFriendships.remoteUsername, senderUsername)
    )
    const candidateFriendships: any[] = rawFriendships.map((r: any) => (r.friendship ? r.friendship : r))
    let friendship = candidateFriendships.find((f) => f.status === 'active') || candidateFriendships[0]

    let localUserId: string | null = friendship?.localUserId ?? null

    // If no friendship row found, attempt to find local recipient via specified recipientUsername
    if (!localUserId && body.recipientUsername) {
      const [recipientProfile] = await db.select().from(profiles).where(eq(profiles.username, body.recipientUsername.toLowerCase())).limit(1)
      if (recipientProfile) {
        localUserId = recipientProfile.userId
      }
    }

    // Or check if there's an existing conversation with this remote sender
    if (!localUserId) {
      const [existingConv] = await db.select().from(conversations).where(or(
        eq(conversations.userAId, senderUsername),
        eq(conversations.userBId, senderUsername)
      )).limit(1)
      if (existingConv) {
        localUserId = existingConv.userAId === senderUsername ? existingConv.userBId : existingConv.userAId
      }
    }

    // If still no local recipient found, fail with clear message
    if (!localUserId) {
      return NextResponse.json({ error: `No recipient found for remote sender @${senderUsername}` }, { status: 404 })
    }

    // Auto-promote friendship to active if it was pending or newly received
    if (friendship && friendship.status !== 'active') {
      await db.update(federationFriendships).set({ status: 'active', acceptedAt: new Date() }).where(eq(federationFriendships.id, friendship.id))
    } else if (!friendship) {
      const newFriendshipId = randomUUID()
      await db.insert(federationFriendships).values({
        id: newFriendshipId,
        localUserId,
        remoteDeploymentId: senderOrigin,
        remoteUserId: senderUsername,
        remoteUsername: senderUsername,
        status: 'active',
        tokenHash: 'auto-negotiated',
        tokenVersion: 'v1',
        acceptedAt: new Date(),
      }).onConflictDoNothing()
      friendship = { id: newFriendshipId, localUserId, remoteUsername: senderUsername }
    }

    // Ensure conversation exists between localUserId and remoteUsername
    const [userAId, userBId] = [localUserId, senderUsername].sort()
    let [conversation] = await db.select().from(conversations).where(or(
      and(eq(conversations.userAId, localUserId), eq(conversations.userBId, senderUsername)),
      and(eq(conversations.userAId, senderUsername), eq(conversations.userBId, localUserId)),
      and(eq(conversations.userAId, userAId), eq(conversations.userBId, userBId))
    )).limit(1)

    if (!conversation) {
      const [created] = await db.insert(conversations).values({
        id: randomUUID(),
        userAId,
        userBId,
      }).onConflictDoNothing().returning()

      conversation = created ?? (await db.select().from(conversations).where(
        and(eq(conversations.userAId, userAId), eq(conversations.userBId, userBId))
      ).limit(1))[0]
    }

    const conversationId = conversation?.id ?? randomUUID()

    // Store incoming message with senderId as remoteUsername
    const [message] = await db.insert(messages).values({
      id: randomUUID(),
      conversationId,
      senderId: senderUsername,
      body: body.body.trim(),
      deliveredAt: new Date(),
    }).returning()

    // Record in federationInbox
    await db.insert(federationInbox).values({
      id: randomUUID(),
      remoteEventId: body.eventId,
      friendshipId: friendship?.id ?? randomUUID(),
      payloadHash: signature || 'delivered',
    }).onConflictDoNothing()

    // Emit real-time event through active SSE stream for immediate zero-polling UI update
    if (message) {
      emitUserEvent(localUserId, {
        type: 'message',
        message: {
          id: message.id,
          conversationId,
          senderId: senderUsername,
          body: message.body,
          createdAt: message.createdAt,
          deliveredAt: message.deliveredAt,
        },
        conversationId,
        senderUsername,
        recipientUsername: body.recipientUsername,
      })
    }

    // Dispatch real-time push notification to local recipient
    void notifyUser(localUserId, {
      title: `@${senderUsername}`,
      body: body.body.trim(),
      conversationId,
    }).catch(() => undefined)

    return NextResponse.json({
      ok: true,
      duplicate: false,
      messageId: message?.id ?? randomUUID(),
      conversationId,
    }, { status: 201 })
  } catch (error) {
    console.error('[Federation Messages POST] Error:', error)
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Internal federation error',
    }, { status: 500 })
  }
}

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, x-federation-timestamp, x-federation-signature',
      'Access-Control-Max-Age': '86400',
    },
  })
}
