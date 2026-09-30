import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { profiles } from '@/lib/db/schema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ username: string }> }

export async function GET(request: Request, context: RouteContext) {
  const { username } = await context.params
  const normalized = decodeURIComponent(username).replace(/^@/, '').toLowerCase()

  if (!/^[a-z0-9_]{3,32}$/.test(normalized)) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const [profile] = await db
    .select({ username: profiles.username, displayName: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.username, normalized))
    .limit(1)

  if (!profile) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  return NextResponse.json(
    {
      protocol: 'relay-federation',
      version: 'v1',
      origin: new URL(request.url).origin,
      user: profile,
      relationship: 'discoverable',
    },
    {
      headers: {
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
        'Access-Control-Allow-Origin': '*',
      },
    },
  )
}
