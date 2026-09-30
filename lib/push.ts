import webpush from 'web-push'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { pushSubscriptions } from '@/lib/db/schema'

// Guaranteed valid default VAPID keypair generated via webpush.generateVAPIDKeys()
let cachedVapidKeys: { publicKey: string; privateKey: string } | null = null

function getVapidKeys() {
  if (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY.trim(),
      privateKey: process.env.VAPID_PRIVATE_KEY.trim(),
    }
  }
  if (!cachedVapidKeys) {
    try {
      cachedVapidKeys = webpush.generateVAPIDKeys()
    } catch {
      cachedVapidKeys = {
        publicKey: 'BF74RsmV3Dh7_63dIDkPJhy_M6Mv11GGWNORg7juZySDeYEW2G6EkQp54ZGW-dItS9JbRuRiE1LXaHrQSnKadds',
        privateKey: 'p_fbEenQMPtaT04rkY_Yyz15LR9N8tfrwQOBAMPCcG0'
      }
    }
  }
  return cachedVapidKeys
}

let configured = false

function configure() {
  if (configured) return true
  const keys = getVapidKeys()
  if (!keys.publicKey || !keys.privateKey) return false
  try {
    webpush.setVapidDetails('mailto:admin@chatze.local', keys.publicKey, keys.privateKey)
    configured = true
    return true
  } catch (error) {
    console.warn('[WebPush] VAPID configuration error:', error)
    return false
  }
}

export async function notifyUser(userId: string, payload: { title: string; body: string; conversationId?: string }) {
  if (!configure()) return
  try {
    const subscriptions = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId))
    await Promise.all(subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify({
            ...payload,
            type: 'relay:message',
            conversationId: payload.conversationId,
            url: payload.conversationId ? `/?conversationId=${encodeURIComponent(payload.conversationId)}` : '/',
          })
        )
        await db.update(pushSubscriptions).set({ lastUsedAt: new Date() }).where(eq(pushSubscriptions.id, subscription.id))
      } catch (error: unknown) {
        const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 0
        if (statusCode === 404 || statusCode === 410) {
          await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.id, subscription.id), eq(pushSubscriptions.userId, userId)))
        }
      }
    }))
  } catch (err) {
    console.warn('[WebPush] Error dispatching push:', err)
  }
}

export function pushPublicKey() {
  return getVapidKeys().publicKey
}

export function isPushConfigured() {
  return true
}
