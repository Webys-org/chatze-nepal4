import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { pushSubscriptions } from '@/lib/db/schema'

import { pushPublicKey } from '@/lib/push'

export const runtime = 'nodejs'

export async function GET() {
  return NextResponse.json({ publicKey: pushPublicKey() }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const body = await request.json().catch(() => null)
  if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 })
  await db.insert(pushSubscriptions).values({ id: randomUUID(), userId: session.user.id, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth }).onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: session.user.id, p256dh: body.keys.p256dh, auth: body.keys.auth } })
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const body = await request.json().catch(() => null)
  if (typeof body?.endpoint !== 'string') return NextResponse.json({ error: 'Invalid endpoint' }, { status: 400 })
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, session.user.id), eq(pushSubscriptions.endpoint, body.endpoint)))
  return NextResponse.json({ ok: true })
}
