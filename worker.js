/**
 * Chatze Nepal Edition - Cloudflare Edge Worker
 * 
 * Implements Section 2 & 4 of SYSTEM_DESIGN_CLOUDFLARE_ZERO_SETUP.md:
 * - 100% Native Cloudflare Worker entrypoint with zero external dependencies
 * - Binds directly to Cloudflare D1 Native Database (env.DB)
 * - 100-Second SSE Real-Time Streaming with Delta-Polling Fallback
 * - First-Launch 60-Second Business Setup Wizard
 * - Zero-Config Asymmetric WebCrypto Federation (ECDSA P-256)
 * - Nightly 90-Day Retention Scheduled Cron
 */

const D1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY NOT NULL,
  expiresAt TIMESTAMP NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  userId TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL UNIQUE,
  displayName TEXT NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY NOT NULL,
  userAId TEXT NOT NULL,
  userBId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  lastMessageSnippet TEXT,
  lastMessageAt TIMESTAMP,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (userAId, userBId)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversationId TEXT NOT NULL,
  senderId TEXT NOT NULL,
  body TEXT NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deliveredAt TIMESTAMP,
  readAt TIMESTAMP
);

CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY NOT NULL,
  senderId TEXT NOT NULL,
  recipientId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (senderId, recipientId)
);

CREATE TABLE IF NOT EXISTS federation_friendships (
  id TEXT PRIMARY KEY NOT NULL,
  localUserId TEXT NOT NULL,
  remoteDeploymentId TEXT NOT NULL,
  remoteUserId TEXT NOT NULL,
  remoteUsername TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  tokenHash TEXT NOT NULL,
  tokenVersion TEXT NOT NULL DEFAULT 'v1',
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acceptedAt TIMESTAMP,
  revokedAt TIMESTAMP,
  UNIQUE (localUserId, remoteDeploymentId, remoteUserId)
);

CREATE TABLE IF NOT EXISTS federation_requests (
  id TEXT PRIMARY KEY NOT NULL,
  senderUserId TEXT NOT NULL,
  senderOrigin TEXT NOT NULL,
  senderUsername TEXT NOT NULL,
  recipientUsername TEXT NOT NULL,
  nonceHash TEXT NOT NULL,
  expiresAt TIMESTAMP NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  idempotencyKey TEXT NOT NULL UNIQUE,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS federation_inbox (
  id TEXT PRIMARY KEY NOT NULL,
  remoteEventId TEXT NOT NULL UNIQUE,
  friendshipId TEXT NOT NULL,
  payloadHash TEXT NOT NULL,
  acceptedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversationId, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_user_a ON conversations(userAId, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_user_b ON conversations(userBId, createdAt DESC);
`

let dbMigrated = false

async function ensureD1Tables(db) {
  if (dbMigrated || !db) return
  try {
    const statements = D1_SCHEMA_SQL.trim()
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const stmt of statements) {
      await db.prepare(stmt).run().catch(() => {})
    }
    dbMigrated = true
  } catch (err) {
    console.warn('[D1 Worker Init]', err)
  }
}

// In-memory pub/sub for real-time dispatch across worker requests
const activeStreams = new Map()

function broadcastUserEvent(userId, event) {
  const listeners = activeStreams.get(userId)
  if (listeners) {
    const payload = `event: event\ndata: ${JSON.stringify(event)}\n\n`
    for (const send of listeners) {
      try {
        send(payload)
      } catch {}
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    if (env.DB) {
      globalThis.env = env
      await ensureD1Tables(env.DB)
    }

    const url = new URL(request.url)
    const pathname = url.pathname

    // 1. Health & Discovery Endpoint (/api/health)
    if (pathname === '/api/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        platform: 'Cloudflare Workers (KTM Edge)',
        d1Ready: Boolean(env.DB),
        timestamp: Date.now()
      }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // 2. Real-time Server-Sent Events Endpoint (/api/stream)
    if (pathname === '/api/stream' && request.method === 'GET') {
      const cfRay = request.headers.get('cf-ray') || ''
      const edgeRegion = cfRay ? `KTM-CF-${cfRay.slice(-4).toUpperCase()}` : 'Kathmandu (KTM) Edge'
      const since = url.searchParams.get('since')
      const userId = url.searchParams.get('userId') || 'current'

      let pingTimer
      let cycleTimer
      let sendFn

      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          sendFn = (text) => {
            try {
              controller.enqueue(encoder.encode(text))
            } catch {}
          }

          // Initial connection event with edge metadata
          sendFn(`event: connected\ndata: ${JSON.stringify({
            ok: true,
            edgeLocation: edgeRegion,
            maxDurationSeconds: 100,
            ts: Date.now()
          })}\n\n`)

          // Delta recovery if client passed timestamp
          if (since && env.DB) {
            try {
              const rows = await env.DB.prepare(
                'SELECT * FROM messages WHERE createdAt > ? ORDER BY createdAt ASC LIMIT 50'
              ).bind(new Date(Number(since)).toISOString()).all()
              if (rows?.results?.length) {
                for (const msg of rows.results) {
                  sendFn(`event: event\ndata: ${JSON.stringify({
                    type: 'message',
                    message: msg,
                    conversationId: msg.conversationId
                  })}\n\n`)
                }
              }
            } catch {}
          }

          // Register in active listeners
          if (!activeStreams.has(userId)) activeStreams.set(userId, new Set())
          activeStreams.get(userId).add(sendFn)

          // 8-second keepalive ping
          pingTimer = setInterval(() => {
            sendFn(`event: ping\ndata: ${Date.now()}\n\n: ping\n\n`)
          }, 8000)

          // 95-second Cloudflare Workers graceful cycling
          cycleTimer = setTimeout(() => {
            sendFn(`event: cycle\ndata: ${JSON.stringify({ reconnect: true, ts: Date.now() })}\n\n`)
            try { controller.close() } catch {}
          }, 95000)
        },
        cancel() {
          if (pingTimer) clearInterval(pingTimer)
          if (cycleTimer) clearTimeout(cycleTimer)
          if (activeStreams.has(userId) && sendFn) {
            activeStreams.get(userId).delete(sendFn)
          }
        }
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform, no-store',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Edge-Region': edgeRegion
        }
      })
    }

    // 3. First-Launch Setup Wizard API (/api/setup)
    if (pathname === '/api/setup') {
      if (request.method === 'GET') {
        let isInitialized = false
        let instanceName = 'Chatze Nepal Edition'
        if (env.DB) {
          try {
            const countRes = await env.DB.prepare('SELECT COUNT(*) as cnt FROM profiles').first()
            isInitialized = (countRes?.cnt || 0) > 0
            const nameRow = await env.DB.prepare("SELECT value FROM system_config WHERE key = 'instance_name'").first()
            if (nameRow?.value) instanceName = nameRow.value
          } catch {}
        }
        return new Response(JSON.stringify({
          initialized: isInitialized,
          instanceName,
          storageEngine: 'Cloudflare D1 Native Database',
          edgeRegion: 'Kathmandu (KTM) Edge',
          version: '1.0.0-nepal-edge'
        }), {
          headers: { 'Content-Type': 'application/json' }
        })
      }

      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}))
        const businessName = (body.businessName || 'Nepal Business Hub').trim()
        const adminHandle = (body.adminHandle || 'admin').trim().replace(/^@/, '').toLowerCase()
        const displayName = (body.displayName || businessName).trim()
        const email = (body.email || `${adminHandle}@chatze.np`).trim()

        if (env.DB) {
          const userId = `usr_${crypto.randomUUID().slice(0, 8)}`
          await env.DB.prepare(
            'INSERT OR IGNORE INTO "user" (id, name, email, emailVerified) VALUES (?, ?, ?, 1)'
          ).bind(userId, displayName, email).run()

          await env.DB.prepare(
            'INSERT OR IGNORE INTO profiles (userId, username, displayName) VALUES (?, ?, ?)'
          ).bind(userId, adminHandle, displayName).run()

          await env.DB.prepare(
            "INSERT OR REPLACE INTO system_config (key, value) VALUES ('instance_name', ?)"
          ).bind(businessName).run()

          // Generate ECDSA P-256 keypair
          try {
            const keyPair = await crypto.subtle.generateKey(
              { name: 'ECDSA', namedCurve: 'P-256' },
              true,
              ['sign', 'verify']
            )
            const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey)
            const pubB64 = btoa(String.fromCharCode(...new Uint8Array(spki)))
            const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
            await env.DB.prepare(
              "INSERT OR REPLACE INTO system_config (key, value) VALUES ('federation_public_key', ?)"
            ).bind(pubB64).run()
            await env.DB.prepare(
              "INSERT OR REPLACE INTO system_config (key, value) VALUES ('federation_private_key_jwk', ?)"
            ).bind(JSON.stringify(jwk)).run()
          } catch (e) {
            console.warn('[ECDSA Keygen]', e)
          }

          // Concierge Welcome message
          const guideId = 'chatze_guide'
          const convId = `conv_welcome_${crypto.randomUUID().slice(0, 8)}`
          await env.DB.prepare(
            'INSERT OR IGNORE INTO profiles (userId, username, displayName) VALUES (?, ?, ?)'
          ).bind(guideId, guideId, 'Chatze Nepal Concierge').run()

          const [uA, uB] = [userId, guideId].sort()
          await env.DB.prepare(
            'INSERT OR IGNORE INTO conversations (id, userAId, userBId, status, lastMessageSnippet) VALUES (?, ?, ?, ?, ?)'
          ).bind(convId, uA, uB, 'active', '🙏 Namaste! Welcome to Chatze Nepal Edition.').run()

          await env.DB.prepare(
            'INSERT INTO messages (id, conversationId, senderId, body) VALUES (?, ?, ?, ?)'
          ).bind(
            `msg_${crypto.randomUUID().slice(0, 8)}`,
            convId,
            guideId,
            `🙏 Namaste and welcome to Chatze Nepal Edition!\n\nYour 100% Free-Forever Cloudflare Edge inbox is active on the Kathmandu (KTM) PoP:\n• 5 GB Free Cloudflare D1 Native Database (~25M messages)\n• 100,000 requests/day\n• Share your store link /u/${adminHandle} in Facebook / TikTok / Instagram.\n• Use Nepal Quick Canned Responses to answer customers in 1 second!`
          ).run()
        }

        return new Response(JSON.stringify({
          ok: true,
          message: 'Workspace initialized successfully',
          adminHandle,
          businessName
        }), {
          headers: { 'Content-Type': 'application/json' }
        })
      }
    }

    // 4. Asymmetric Federation Discovery (/api/federation/identity)
    if (pathname === '/api/federation/identity') {
      let pubKey = ''
      let instanceName = 'Chatze Nepal Edition'
      if (env.DB) {
        try {
          const row = await env.DB.prepare("SELECT value FROM system_config WHERE key = 'federation_public_key'").first()
          if (row?.value) pubKey = row.value
          const nameRow = await env.DB.prepare("SELECT value FROM system_config WHERE key = 'instance_name'").first()
          if (nameRow?.value) instanceName = nameRow.value
        } catch {}
      }
      return new Response(JSON.stringify({
        instance_url: url.origin,
        name: instanceName,
        public_key: pubKey,
        algorithm: 'ECDSA-P256-SHA256',
        region: 'KTM',
        created_at: Math.floor(Date.now() / 1000)
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400'
        }
      })
    }

    // 5. Automated 90-Day Retention Endpoint (/api/cron/retention)
    if (pathname === '/api/cron/retention') {
      let purged = 0
      if (env.DB) {
        try {
          const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
          const res = await env.DB.prepare(
            `DELETE FROM messages WHERE createdAt < ? AND conversationId IN 
             (SELECT id FROM conversations WHERE status = 'archived')`
          ).bind(ninetyDaysAgo).run()
          purged = res?.meta?.changes || 0
        } catch (e) {
          console.warn('[Retention Cleanup]', e)
        }
      }
      return new Response(JSON.stringify({
        ok: true,
        purgedMessagesCount: purged,
        storageEngine: 'Cloudflare D1 Native Database',
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // 6. Static Assets & Frontend Routing (Serves Next.js UI via Cloudflare Assets)
    if (env.ASSETS) {
      try {
        const assetResponse = await env.ASSETS.fetch(request)
        if (assetResponse.status !== 404) {
          return assetResponse
        }
        // SPA Fallback for client navigation (/setup, /sign-in, /sign-up, etc.)
        const indexRequest = new Request(new URL('/', request.url), request)
        const indexResponse = await env.ASSETS.fetch(indexRequest)
        if (indexResponse.status === 200) {
          return indexResponse
        }
      } catch {}
    }

    return new Response('Chatze Nepal Edition - Cloudflare Kathmandu Edge Active', {
      headers: { 'Content-Type': 'text/plain' }
    })
  },

  // 7. Nightly Scheduled Cron Trigger (crons = ["0 3 * * *"])
  async scheduled(event, env, ctx) {
    if (!env.DB) return
    ctx.waitUntil((async () => {
      try {
        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
        await env.DB.prepare(
          `DELETE FROM messages WHERE createdAt < ? AND conversationId IN 
           (SELECT id FROM conversations WHERE status = 'archived')`
        ).bind(ninetyDaysAgo).run()
        console.log('[Cloudflare Cron] Nightly 90-day retention purge completed.')
      } catch (err) {
        console.warn('[Cloudflare Cron Error]', err)
      }
    })())
  }
}
