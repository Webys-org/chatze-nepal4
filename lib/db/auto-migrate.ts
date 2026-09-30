/**
 * Zero-Setup Cloudflare D1 & SQLite / PostgreSQL Auto-Migrator
 * 
 * Automatically provisions all required tables, constraints, and high-performance
 * indexes on first boot without any manual migrations or external database account.
 */
import { Pool } from 'pg'

export const D1_MIGRATION_STATEMENTS = [
  // 1. System Configuration & Cryptographic Identity Storage
  `CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // 2. Authentication & User Tables
  `CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    emailVerified BOOLEAN NOT NULL DEFAULT false,
    image TEXT,
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY NOT NULL,
    expiresAt TIMESTAMP NOT NULL,
    token TEXT NOT NULL UNIQUE,
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ipAddress TEXT,
    userAgent TEXT,
    userId TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY NOT NULL,
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    userId TEXT NOT NULL,
    accessToken TEXT,
    refreshToken TEXT,
    idToken TEXT,
    accessTokenExpiresAt TIMESTAMP,
    refreshTokenExpiresAt TIMESTAMP,
    scope TEXT,
    password TEXT,
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY NOT NULL,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt TIMESTAMP NOT NULL,
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  // 3. User Profiles & Social Graph
  `CREATE TABLE IF NOT EXISTS profiles (
    userId TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL UNIQUE,
    displayName TEXT NOT NULL,
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS friend_requests (
    id TEXT PRIMARY KEY NOT NULL,
    senderId TEXT NOT NULL,
    recipientId TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (senderId, recipientId)
  )`,

  // 4. High-Volume Conversations & Messaging
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY NOT NULL,
    userAId TEXT NOT NULL,
    userBId TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    lastMessageSnippet TEXT,
    lastMessageAt TIMESTAMP,
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (userAId, userBId)
  )`,

  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    conversationId TEXT NOT NULL,
    senderId TEXT NOT NULL,
    body TEXT NOT NULL,
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deliveredAt TIMESTAMP,
    readAt TIMESTAMP
  )`,

  // 5. Zero-Config Federation Protocol Tables
  `CREATE TABLE IF NOT EXISTS federation_deployments (
    id TEXT PRIMARY KEY NOT NULL,
    origin TEXT NOT NULL UNIQUE,
    protocolVersion TEXT NOT NULL DEFAULT 'v1',
    publicKey TEXT,
    lastManifestAt TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'active',
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS federation_friendships (
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
  )`,

  `CREATE TABLE IF NOT EXISTS federation_requests (
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
  )`,

  `CREATE TABLE IF NOT EXISTS federation_inbox (
    id TEXT PRIMARY KEY NOT NULL,
    remoteEventId TEXT NOT NULL UNIQUE,
    friendshipId TEXT NOT NULL,
    payloadHash TEXT NOT NULL,
    acceptedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS federation_outbox (
    id TEXT PRIMARY KEY NOT NULL,
    friendshipId TEXT NOT NULL,
    messageId TEXT NOT NULL,
    remoteEndpoint TEXT NOT NULL,
    payloadHash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attemptCount INTEGER NOT NULL DEFAULT 0,
    nextAttemptAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    remoteAcknowledgement TEXT,
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY NOT NULL,
    userId TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lastUsedAt TIMESTAMP
  )`,

  // 6. High-Performance Indexes for 5,000+ Daily Inquiries
  `CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversationId, createdAt DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_user_a ON conversations(userAId, createdAt DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_user_b ON conversations(userBId, createdAt DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_friend_requests_recipient ON friend_requests(recipientId, status)`,
  `CREATE INDEX IF NOT EXISTS idx_federation_requests_recipient ON federation_requests(recipientUsername, status)`,
]

let migrationPromise: Promise<void> | undefined

/**
 * Executes zero-setup auto-migration on the active database runtime.
 * Works uniformly on Cloudflare D1, PostgreSQL, and in-memory mock.
 */
export async function runAutoMigrate(): Promise<void> {
  if (migrationPromise) return migrationPromise

  migrationPromise = (async () => {
    // 1. If running under Cloudflare Worker with D1 env.DB binding
    const globalContext = globalThis as any
    const d1Database = globalContext.env?.DB || process.env.DB
    if (d1Database && typeof d1Database.prepare === 'function') {
      try {
        for (const statement of D1_MIGRATION_STATEMENTS) {
          await d1Database.prepare(statement).run()
        }
        return
      } catch (err) {
        console.warn('[Cloudflare D1 Auto-Migrate] D1 statement execution error:', err)
      }
    }

    // 2. If running with PostgreSQL DATABASE_URL
    if (process.env.DATABASE_URL) {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL })
      let client
      try {
        client = await pool.connect()
        await client.query('BEGIN')
        for (const statement of D1_MIGRATION_STATEMENTS) {
          // Replace DEFAULT CURRENT_TIMESTAMP with DEFAULT now() if PG
          const pgStatement = statement.replace(/CURRENT_TIMESTAMP/g, 'now()')
          await client.query(pgStatement).catch((e) => {
            // Ignore already exists errors during race conditions
            if (!String(e).includes('already exists')) throw e
          })
        }
        await client.query('COMMIT')
      } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {})
        console.warn('[PostgreSQL Auto-Migrate] Note:', error instanceof Error ? error.message : error)
      } finally {
        if (client) client.release()
        await pool.end().catch(() => {})
      }
    }

    // 3. In-memory mode (handled by mock tables automatically in memory store)
  })()

  return migrationPromise
}
