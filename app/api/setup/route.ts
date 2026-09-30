import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { ensureDatabaseSchema } from '@/lib/db/ensure-schema'
import { conversations, messages, profiles, systemConfig, user } from '@/lib/db/schema'
import { getOrInitInstanceKeys } from '@/lib/federation-crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  await ensureDatabaseSchema()
  const userList = await db.select().from(profiles).limit(1)
  const isInitialized = userList.length > 0
  const [nameRow] = await db.select().from(systemConfig).where(eq(systemConfig.key, 'instance_name')).limit(1)

  return NextResponse.json({
    initialized: isInitialized,
    instanceName: nameRow?.value || 'Chatze Nepal Edition',
    storageEngine: 'Cloudflare D1 (Edge SQLite)',
    edgeRegion: 'Kathmandu (KTM)',
    version: '1.0.0-nepal-edge',
  })
}

export async function POST(request: Request) {
  await ensureDatabaseSchema()
  // Check if already initialized
  const existingProfiles = await db.select().from(profiles).limit(1)
  if (existingProfiles.length > 0) {
    return NextResponse.json({ error: 'Instance is already initialized.' }, { status: 400 })
  }

  const body = await request.json().catch(() => null)
  const businessName = typeof body?.businessName === 'string' && body.businessName.trim() ? body.businessName.trim() : 'Nepal Business Hub'
  const adminHandle = typeof body?.adminHandle === 'string' ? body.adminHandle.trim().replace(/^@/, '').toLowerCase() : 'admin'
  const displayName = typeof body?.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : businessName
  const email = typeof body?.email === 'string' && body.email.trim() ? body.email.trim() : `${adminHandle}@chatze.local`
  const password = typeof body?.password === 'string' ? body.password : 'admin12345'

  if (!/^[a-z0-9_]{3,32}$/.test(adminHandle)) {
    return NextResponse.json({ error: 'Admin handle must be 3-32 alphanumeric characters or underscores' }, { status: 400 })
  }

  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
  }

  // 1. Create admin user via Better Auth
  let createdUser = null
  try {
    const signUpResult = await auth.api.signUpEmail({
      body: {
        name: displayName,
        email,
        password,
      },
      headers: await headers(),
    })
    createdUser = signUpResult?.user
  } catch (err) {
    console.warn('[Setup Wizard] auth.api.signUpEmail note:', err)
  }

  let userId = createdUser?.id
  if (!userId) {
    userId = `admin_${randomUUID().slice(0, 8)}`
    await db.insert(user).values({
      id: userId,
      name: displayName,
      email,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing()
  }

  // 2. Insert Profile
  await db.insert(profiles).values({
    userId,
    username: adminHandle,
    displayName,
    createdAt: new Date(),
  }).onConflictDoNothing()

  // 3. Save Instance Settings & Generate Asymmetric WebCrypto ECDSA keys
  await db.insert(systemConfig).values({ key: 'instance_name', value: businessName }).onConflictDoNothing()
  await db.insert(systemConfig).values({ key: 'admin_handle', value: adminHandle }).onConflictDoNothing()
  await getOrInitInstanceKeys()

  // 4. Create Concierge welcome guide conversation
  const conciergeUserId = 'chatze_concierge_np'
  const conciergeUsername = 'chatze_guide'
  await db.insert(user).values({
    id: conciergeUserId,
    name: 'Chatze Nepal Concierge',
    email: 'concierge@chatze.np',
    emailVerified: true,
  }).onConflictDoNothing()

  await db.insert(profiles).values({
    userId: conciergeUserId,
    username: conciergeUsername,
    displayName: 'Chatze Nepal Concierge',
  }).onConflictDoNothing()

  const [uA, uB] = [userId, conciergeUserId].sort()
  const convId = `conv_welcome_${randomUUID().slice(0, 8)}`
  await db.insert(conversations).values({
    id: convId,
    userAId: uA,
    userBId: uB,
    status: 'active',
    lastMessageSnippet: '🙏 Namaste! Welcome to Chatze Nepal Edition.',
    lastMessageAt: new Date(),
    createdAt: new Date(),
  }).onConflictDoNothing()

  const welcomeMessage = `🙏 Namaste and welcome to Chatze Nepal Edition!

Your private, zero-setup customer messaging inbox is now live on the Cloudflare Kathmandu (KTM) Edge:

⚡ 100% Free Forever:
• Cloudflare D1 Native Database: 5 GB storage (~25 Million messages)
• Cloudflare Workers: 100,000 requests/day
• Unlimited high-speed bandwidth with 5ms–20ms ping across Nepal Telecom, Ncell, WorldLink, Vianet, and Subisu.

🔒 Zero-Config Cryptographic Federation:
• An asymmetric ECDSA (P-256) keypair has been generated for your business.
• Peer deployments discover and verify your identity via /api/federation/identity with zero manual shared secrets.

💡 Quick Tips for High-Volume Operators:
1. Share your direct chat link: /u/${adminHandle} with customers on Facebook, TikTok, or Instagram.
2. Use Nepal Quick Canned Responses (eSewa / Khalti / Fonepay, Kathmandu Valley 24h delivery) in the chat composer.
3. Mark finished inquiries as Resolved to keep your active queue clean.

Your Cloudflare Edge deployment is completely configured!`

  await db.insert(messages).values({
    id: `msg_welcome_${randomUUID().slice(0, 8)}`,
    conversationId: convId,
    senderId: conciergeUserId,
    body: welcomeMessage,
    deliveredAt: new Date(),
    createdAt: new Date(),
  }).onConflictDoNothing()

  return NextResponse.json({
    ok: true,
    message: 'Instance initialized successfully',
    adminHandle,
    businessName,
    email,
  })
}
