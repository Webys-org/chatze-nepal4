import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { profiles } from '@/lib/db/schema'

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const body = await request.json().catch(() => null)
  const username = typeof body?.username === 'string' ? body.username.toLowerCase().trim() : ''
  const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : ''
  if (!/^[a-z0-9_]{3,32}$/.test(username) || !displayName || displayName.length > 80) return NextResponse.json({ error: 'Choose a valid username and display name.' }, { status: 400 })
  try { const [profile] = await db.insert(profiles).values({ userId: session.user.id, username, displayName }).returning(); return NextResponse.json({ profile }, { status: 201 }) } catch { return NextResponse.json({ error: 'That username is already taken.' }, { status: 409 }) }
}

export const runtime = 'nodejs'
