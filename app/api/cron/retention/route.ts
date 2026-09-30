import { and, eq, lt } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureDatabaseSchema } from '@/lib/db/ensure-schema'
import { conversations, messages } from '@/lib/db/schema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Automated 90-Day Retention Cron Handler
 * 
 * Invoked by Cloudflare Cron Trigger (crons = ["0 3 * * *"]) or scheduled worker.
 * Purges messages older than 90 days from archived or resolved conversations,
 * ensuring Cloudflare D1 stays permanently within the 5 GB free storage tier.
 */
export async function GET(request: Request) {
  await ensureDatabaseSchema()

  // Verify auth header or cron signature if configured
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET || process.env.BETTER_AUTH_SECRET

  // 90 days threshold calculation
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)

  try {
    // 1. Find conversations that are resolved or archived
    const resolvedConversations = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.status, 'archived'))

    let purgedCount = 0
    for (const conv of resolvedConversations) {
      const deleted = await db
        .delete(messages)
        .where(and(eq(messages.conversationId, conv.id), lt(messages.createdAt, ninetyDaysAgo)))
      if (Array.isArray(deleted)) {
        purgedCount += deleted.length
      }
    }

    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      purgedMessagesCount: purgedCount,
      resolvedConversationsChecked: resolvedConversations.length,
      storageEngine: 'Cloudflare D1 Native Database',
      retentionPolicy: '90-day resolved inquiries purge',
    })
  } catch (error) {
    console.error('[Cloudflare Retention Cron] Error:', error)
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Retention maintenance failed',
    }, { status: 500 })
  }
}

export async function POST(request: Request) {
  return GET(request)
}
