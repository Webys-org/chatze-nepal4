import { randomUUID } from 'node:crypto'
import { and, eq, or } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { conversations, federationFriendships, federationRequests, profiles } from '@/lib/db/schema'
import { getPublicOrigin, hashToken, verifyFederationSignature } from '@/lib/federation'
import { notifyUser } from '@/lib/push'
import { emitUserEvent } from '@/lib/events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(request: Request) {
  try {
    const raw = await request.text()
    const timestamp = request.headers.get('x-federation-timestamp') || ''
    const signature = request.headers.get('x-federation-signature') || ''
    if (!verifyFederationSignature(raw, timestamp, signature)) {
      return NextResponse.json({ error: 'Invalid federation signature' }, { status: 401 })
    }

    const body = JSON.parse(raw) as {
      senderOrigin?: string
      senderUsername?: string
      recipientUsername?: string
      requestId?: string
      connectionToken?: string
    }

    if (!body.senderUsername || !body.recipientUsername) {
      return NextResponse.json({ error: 'Invalid acceptance payload' }, { status: 400 })
    }

    const senderUsername = body.senderUsername.trim().toLowerCase()
    const recipientUsername = body.recipientUsername.trim().toLowerCase()

    // Find local user who sent the friend request originally
    const [sender] = await db.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.username, senderUsername)).limit(1)
    if (!sender) return NextResponse.json({ error: 'Sender profile not found' }, { status: 404 })

    const localUserId = sender.userId

    // Find the pending or existing friendship on this instance
    const [friendship] = await db.select().from(federationFriendships).where(
      and(
        eq(federationFriendships.localUserId, localUserId),
        eq(federationFriendships.remoteUsername, recipientUsername)
      )
    ).limit(1)

    const token = body.connectionToken || 'relay-federation-v1'
    const tokenHash = hashToken(token)

    if (friendship) {
      await db.update(federationFriendships).set({
        status: 'active',
        acceptedAt: new Date(),
        tokenHash,
        tokenVersion: 'v1',
      }).where(eq(federationFriendships.id, friendship.id))
    } else {
      await db.insert(federationFriendships).values({
        id: randomUUID(),
        localUserId,
        remoteDeploymentId: body.senderOrigin || '',
        remoteUserId: body.requestId || randomUUID(),
        remoteUsername: recipientUsername,
        status: 'active',
        tokenHash,
        tokenVersion: 'v1',
        acceptedAt: new Date(),
      }).onConflictDoNothing()
    }

    // Automatically ensure local conversation exists for this peer
    const [userAId, userBId] = [localUserId, recipientUsername].sort()
    let [conversation] = await db.select().from(conversations).where(or(
      and(eq(conversations.userAId, localUserId), eq(conversations.userBId, recipientUsername)),
      and(eq(conversations.userAId, recipientUsername), eq(conversations.userBId, localUserId)),
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

    if (conversation?.id) {
      emitUserEvent(localUserId, {
        type: 'friend_accepted',
        friendshipId: friendship?.id ?? '',
        remoteUsername: recipientUsername,
        conversationId: conversation.id,
      })
    }

    void notifyUser(localUserId, {
      title: 'Friend request accepted',
      body: `@${recipientUsername} accepted your friend request!`,
      conversationId: conversation?.id
    }).catch(() => undefined)

    return NextResponse.json({ ok: true, conversationId: conversation?.id })
  } catch (error) {
    console.error('[Federation Requests PATCH] Error:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const raw = await request.text()
    const timestamp = request.headers.get('x-federation-timestamp') || ''
    const signature = request.headers.get('x-federation-signature') || ''
    if (!verifyFederationSignature(raw, timestamp, signature)) {
      return NextResponse.json({ error: 'Invalid federation signature' }, { status: 401 })
    }

    const body = await Promise.resolve().then(() => JSON.parse(raw)).catch(() => null) as {
      senderOrigin?: string
      senderUsername?: string
      recipientUsername?: string
      idempotencyKey?: string
      connectionToken?: string
    } | null

    if (!body?.senderOrigin || !body.senderUsername || !body.recipientUsername || !body.idempotencyKey) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    let senderOrigin: string
    try {
      senderOrigin = new URL(body.senderOrigin).origin
    } catch {
      return NextResponse.json({ error: 'Invalid sender origin' }, { status: 400 })
    }

    const recipientUsername = body.recipientUsername.trim().toLowerCase()
    const senderUsername = body.senderUsername.trim().toLowerCase()

    if (!/^[a-z0-9_]{3,32}$/.test(recipientUsername)) {
      return NextResponse.json({ error: 'Invalid recipient' }, { status: 400 })
    }

    const [recipient] = await db.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.username, recipientUsername)).limit(1)
    if (!recipient) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const [created] = await db.insert(federationRequests).values({
      id: randomUUID(),
      senderUserId: `${senderOrigin}:${senderUsername}`,
      senderOrigin,
      senderUsername,
      recipientUsername,
      nonceHash: signature,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      idempotencyKey: body.idempotencyKey,
    }).onConflictDoNothing().returning({ id: federationRequests.id })

    if (created) {
      emitUserEvent(recipient.userId, {
        type: 'friend_request',
        requestId: created.id,
        senderUsername,
        remote: true,
      })

      void notifyUser(recipient.userId, {
        title: 'New friend request',
        body: `@${senderUsername} wants to connect with you.`
      }).catch(() => undefined)
    }

    return NextResponse.json({
      ok: true,
      requestId: created?.id ?? null,
      origin: getPublicOrigin(request)
    }, { status: created ? 201 : 200 })
  } catch (error) {
    console.error('[Federation Requests POST] Error:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal error' }, { status: 500 })
  }
}

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, x-federation-timestamp, x-federation-signature',
      'Access-Control-Max-Age': '86400',
    },
  })
}
