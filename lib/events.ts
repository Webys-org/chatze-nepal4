import { EventEmitter } from 'node:events'

// Global event emitter instance across serverless execution contexts
declare global {
  // eslint-disable-next-line no-var
  var __chatzeEventBus: EventEmitter | undefined
}

const eventBus: EventEmitter = global.__chatzeEventBus ?? new EventEmitter()
eventBus.setMaxListeners(200)

if (process.env.NODE_ENV !== 'production' || !global.__chatzeEventBus) {
  global.__chatzeEventBus = eventBus
}

export type RealtimeEvent =
  | {
      type: 'message'
      message: {
        id: string
        conversationId: string
        senderId: string
        body: string
        createdAt: string | Date
        deliveredAt?: string | Date | null
      }
      conversationId: string
      senderUsername?: string
      recipientUsername?: string
    }
  | {
      type: 'friend_request'
      requestId: string
      senderUsername: string
      remote: boolean
      sender?: {
        username: string
        displayName: string
      }
    }
  | {
      type: 'friend_accepted'
      friendshipId?: string
      remoteUsername?: string
      conversationId: string
      friend?: {
        username: string
        displayName: string
      }
    }

export function emitUserEvent(userId: string, event: RealtimeEvent) {
  try {
    eventBus.emit(`user:${userId}`, event)
    // Also emit broadcast channel if useful
    eventBus.emit('all', { userId, event })
  } catch (err) {
    console.error('[EventBus] Error emitting event to user:', userId, err)
  }
}

export function subscribeUserEvents(
  userId: string,
  handler: (event: RealtimeEvent) => void
): () => void {
  const channel = `user:${userId}`
  eventBus.on(channel, handler)
  return () => {
    eventBus.off(channel, handler)
  }
}
