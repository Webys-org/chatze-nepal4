import { and, eq, gt, or } from 'drizzle-orm'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { conversations, messages, profiles } from '@/lib/db/schema'
import { RealtimeEvent, subscribeUserEvents } from '@/lib/events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const reqHeaders = await headers()
  const session = await auth.api.getSession({ headers: reqHeaders })
  const userId = session?.user?.id

  if (!userId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const url = new URL(request.url)
  const sinceParam = url.searchParams.get('since') || url.searchParams.get('last_message_at')
  const sinceTimestamp = sinceParam ? Number(sinceParam) : null

  // Cloudflare Edge Metadata
  const cfRay = reqHeaders.get('cf-ray') || ''
  const cfCountry = reqHeaders.get('cf-ipcountry') || 'NP'
  const edgeLocation = cfRay ? `KTM-CF-${cfRay.slice(-4).toUpperCase()}` : 'KTM Edge (Nepal)'

  let cleanup: (() => void) | null = null
  let pingInterval: NodeJS.Timeout | null = null
  let cycleTimeout: NodeJS.Timeout | null = null

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()

      // 1. Send initial connection acknowledgement with edge metadata
      controller.enqueue(
        encoder.encode(
          `event: connected\ndata: ${JSON.stringify({
            ok: true,
            userId,
            edgeLocation,
            country: cfCountry,
            maxDurationSeconds: 100,
            ts: Date.now(),
          })}\n\n`
        )
      )

      // 2. D1 Delta-Polling Fallback: catch up on any messages created while reconnecting
      if (sinceTimestamp && Number.isFinite(sinceTimestamp)) {
        try {
          const sinceDate = new Date(sinceTimestamp)
          const userConvs = await db
            .select({ id: conversations.id })
            .from(conversations)
            .where(or(eq(conversations.userAId, userId), eq(conversations.userBId, userId)))
          const convIds = userConvs.map((c) => c.id)

          if (convIds.length > 0) {
            const allDelta = await db
              .select()
              .from(messages)
              .where(gt(messages.createdAt, sinceDate))
            const deltaForUser = allDelta.filter((m) => convIds.includes(m.conversationId))

            for (const dm of deltaForUser) {
              controller.enqueue(
                encoder.encode(
                  `event: event\ndata: ${JSON.stringify({
                    type: 'message',
                    message: dm,
                    conversationId: dm.conversationId,
                  })}\n\n`
                )
              )
            }
          }
        } catch {
          // Delta catch-up silent fallback
        }
      }

      // 3. Subscribe to real-time events for this user
      cleanup = subscribeUserEvents(userId, (event: RealtimeEvent) => {
        try {
          const payload = `event: event\ndata: ${JSON.stringify(event)}\n\n`
          controller.enqueue(encoder.encode(payload))
        } catch {
          // Stream might be closed
        }
      })

      // 4. Send keep-alive ping every 8 seconds to prevent mobile network dropouts
      pingInterval = setInterval(() => {
        try {
          const now = Date.now()
          controller.enqueue(encoder.encode(`event: ping\ndata: ${now}\n\n: ping ${now}\n\n`))
        } catch {
          if (pingInterval) clearInterval(pingInterval)
        }
      }, 8000)

      // 5. Cloudflare Workers 100-Second SSE Lifecycle Management:
      // Gracefully signal cycling at 95 seconds so client immediately reconnects (<1s)
      cycleTimeout = setTimeout(() => {
        try {
          controller.enqueue(
            encoder.encode(
              `event: cycle\ndata: ${JSON.stringify({ reconnect: true, ts: Date.now() })}\n\n`
            )
          )
          controller.close()
        } catch {
          // stream already closed
        }
      }, 95000)
    },
    cancel() {
      if (cleanup) cleanup()
      if (pingInterval) clearInterval(pingInterval)
      if (cycleTimeout) clearTimeout(cycleTimeout)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable proxy buffering for instant delivery
      'X-Edge-Region': edgeLocation,
    },
  })
}
