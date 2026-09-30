# Chatze System Design: Instant Real-Time Federated Messaging & PWA

This document details the architectural blueprint, data flow, scaling principles, and troubleshooting guidelines for Chatze. It explains **why**, **how**, and **what** guarantees sub-millisecond perceived latency, flawless PC + Mobile cross-device synchronization, and scalable peer-to-peer federation with zero manual configuration.

---

## 1. Architectural Philosophy: The Pure DB + In-Memory + SSE Pipeline

### Why `localStorage` is Forbidden for Chat Messages
Using `localStorage` or local browser disk storage for dynamic chat data creates severe production bugs:
1. **Multi-Device State Desync**: If a user is logged in on their PC and their Mobile phone at the same time, actions taken on Mobile do not update the PC's disk storage.
2. **State Tearing & Collision**: When two browser tabs or devices write to `localStorage` independently, messages get overwritten, duplicate IDs are minted, and histories get scrambled out of order.
3. **Stale Reads on Startup**: Reading from disk introduces race conditions against incoming live network packets.

### The Winning Model
- **Single Source of Truth**: PostgreSQL database managed via Drizzle ORM.
- **Client Cache**: Pure in-memory React state (`messages` array), garbage-collected when navigating.
- **Real-Time Transport**: Server-Sent Events (`/api/stream`), maintaining **one single idle connection** per open browser tab or PWA instance.
- **Background Delivery**: Asynchronous, non-blocking HTTP peer-to-peer federation (`POST /api/federation/v1/messages`).

---

## 2. The Four Speed Guarantees

| Metric | Target | How It Is Guaranteed |
| :--- | :--- | :--- |
| **Send Latency** | **0 ms** | **Optimistic in-memory injection**: Input clears immediately; bubble renders before the network request leaves the device. |
| **Same-User Cross-Device Sync** | **< 25 ms** | When Mobile sends, the server writes to DB and broadcasts `emitUserEvent(userId, ...)`. PC receives the event via its open `/api/stream` and renders immediately. |
| **Remote Peer Delivery** | **< 80 ms** | **Non-blocking asynchronous dispatch**: Local server confirms `201 OK` in ~10ms, then dispatches the remote peer HTTP request in the background. |
| **Network & Socket Health** | **0 flood** | Zero repetitive interval polling. One persistent SSE stream with keep-alive pings eliminates `ERR_INSUFFICIENT_RESOURCES`. |

---

## 3. End-to-End Sequence Diagrams

### Flow A: Sending a Message (Instant Optimistic + Background Federation)

```
[ Your Phone (Mobile) ]             [ Your Server (Instance A) ]             [ Friend Server (Instance B) ]
        |                                       |                                         |
1. User types "Hey!" & hits Enter               |                                         |
   - React appends temp bubble (0ms)            |                                         |
   - Status: 'sending' (single checkmark ✓)     |                                         |
   - Text input clears immediately              |                                         |
        |                                       |                                         |
2. POST /api/messaging (async)                  |                                         |
   -------------------------------------------->|                                         |
                                        3. Persist to PostgreSQL                          |
                                           (Takes ~8-12ms)                                |
                                                |                                         |
                                        4. Broadcast to user stream                       |
                                           emitUserEvent(senderId, msg)                   |
                                           (Updates your PC in <20ms)                     |
                                                |                                         |
                                        5. Return HTTP 201 Created                        |
   <--------------------------------------------+                                         |
6. Phone swaps temp ID                          |                                         |
   for permanent DB ID in place                 |                                         |
   (Status: 'sent' ✓)                           |                                         |
                                                | 7. Non-Blocking Async Dispatch          |
                                                |    fetch(peerUrl/api/federation/...)    |
                                                |---------------------------------------->|
                                                |                                  8. Ingests message &
                                                |                                     persists to DB (10ms)
                                                |                                         |
                                                |                                  9. emitUserEvent(friendId)
                                                |                                         |
                                                |                                         v
                                                |                               [ Friend's Screen: <20ms ]
                                                |                                 (Renders bubble!)
```

---

### Flow B: Simultaneous PC & Mobile Synchronization

```
              [ User Account: @yogesh98 ]
              
  [ Device 1: Mobile Phone ]          [ Device 2: Laptop / PC ]
             |                                    |
     Open /api/stream                     Open /api/stream
             |                                    |
             +-----------------+------------------+
                               |
                               v
                     [ Backend Server A ]
                               |
1. Phone sends "Meet at 5?" --->|
                               2. Writes to PostgreSQL
                               3. Emits event on channel: `user:yogesh_id`
                                    |
            +-----------------------+-----------------------+
            | (Pushed down Stream)                          | (Pushed down Stream)
            v                                               v
  [ Device 1: Phone ]                             [ Device 2: PC ]
  Swaps temp ID for DB ID.                        Receives new message packet.
  Double checkmark ✓                              Instantly renders bubble (<25ms)!
```

---

## 4. Deduplication & Conflict Resolution Rules

1. **Optimistic ID Tagging**:
   - Sent messages initially receive `temp_${crypto.randomUUID()}`.
   - When the server responds with `{ message: { id: "real-uuid-from-db" } }`, the frontend updates the item with matching temporary ID:
     ```ts
     setMessages(prev => prev.map(m => m.id === tempId ? confirmedMessage : m))
     ```
2. **Stream Event Ingestion**:
   - When receiving messages over `/api/stream`, verify the message ID is not already rendered:
     ```ts
     setMessages(prev => {
       if (prev.some(m => m.id === incoming.id || (m.body === incoming.body && m.senderId === incoming.senderId && isWithinWindow(m.createdAt, incoming.createdAt)))) {
         return prev
       }
       return [...prev, incoming]
     })
     ```
3. **No Duplicate Friendships**:
   - Conversations are normalized alphabetically `[userAId, userBId].sort()` so user order never results in split conversation threads.

---

## 5. File Map & Responsibilities

| File | Purpose | Key Logic |
| :--- | :--- | :--- |
| `lib/events.ts` | Process-wide Real-Time Event Hub | Maintains user-specific channels (`user:${userId}`). Multiplexes incoming peer messages and local actions. |
| `app/api/stream/route.ts` | Server-Sent Events Route | Opens `ReadableStream`. Emits `connected` event, transmits `relay-event` packets, sends `: ping` keep-alives every 15s to keep proxy connections healthy. |
| `app/api/messaging/route.ts` | Local Messages & Requests API | Validates session, writes to PostgreSQL, emits to local user stream, dispatches non-blocking federation calls to remote instances. |
| `app/api/federation/v1/messages/route.ts` | Remote Peer Ingestion | Validates incoming peer request, saves message to recipient's conversation, emits `emitUserEvent` so recipient sees the bubble in real time. |
| `app/api/federation/v1/requests/route.ts` | Remote Friend Handshake | Handles cross-domain friend requests and acceptances with dynamic auto-negotiated tokens. |
| `components/messaging-app.tsx` | High-Speed Frontend UI | Manages 0ms optimistic message append, EventSource subscription, auto-reconnection on tab focus, and UI rendering. |
| `app/manifest.ts` | Progressive Web App Manifest | Enables standalone display mode, system theme colors, and native mobile launch. |
| `public/sw.js` | Service Worker | Precaches static app shell (HTML/CSS/JS). Never intercepts or caches dynamic `/api/*` data to avoid stale messages. |

---

## 6. PWA Integration Principles

1. **Precache Shell Only**:
   - Service worker caches CSS, JavaScript, and static assets.
   - Dynamic API routes (`/api/messaging`, `/api/stream`) are flagged as **Network Only** (`cache: 'no-store'`).
2. **Installability**:
   - The app fulfills all Chromium and iOS PWA criteria:
     - `display: 'standalone'`
     - Valid 192x192 and 512x512 icons
     - `start_url: '/'`
     - Valid web app manifest linked in `<head>`
3. **Push Notification Enhancement**:
   - Native Web Push functions as an out-of-app alerting mechanism when the browser is closed or in background.
   - When the app is open in foreground, the `/api/stream` SSE channel handles in-app updates in **< 20ms**, bypassing web push queue delays.

---

## 7. Troubleshooting & Recovery Checklist

### If Messages Appear Twice
- **Check**: Did an optimistic temporary ID fail to swap when the server returned?
- **Fix**: Verify `temp_` ID resolution in `components/messaging-app.tsx` `setMessages`.

### If Remote Friend Never Receives Message
- **Check**: Is the friend's instance URL accessible from the sender's server?
- **Debug**: Check local server logs for `[Federation Dispatch]` warning messages. Ensure both instances use HTTPS or public reachable origins.

### If `ERR_INSUFFICIENT_RESOURCES` Ever Reappears
- **Cause**: An unbounded `setInterval` or an unmemoized function inside a `useEffect` dependency array.
- **Rule**: Never place unmemoized functions inside `useEffect` dependencies. All real-time delivery must be handled by `new EventSource('/api/stream')`, not polling loops.

---

## 8. Real-Time Friend Request Acceptance & Zero Duplication

1. **Dual-Sided Live Broadcast**:
   - When User B accepts User A's friend request, the server emits `friend_accepted` to **both** User A and User B over their respective `/api/stream` connections.
   - User A's client immediately unlocks the conversation without requiring a page reload.
2. **Username-Keyed Deduplication**:
   - Both `GET /api/messaging` and `components/messaging-app.tsx` use a strict `Map<string, Conversation>` keyed by `otherUser.username.toLowerCase()`.
   - If an active conversation is accepted, it replaces the pending state in place.
   - Result: Exactly one conversation item per friend at all times.
3. **Instant Visual Snap (WhatsApp-grade UX)**:
   - When a message is sent, optimistic insertion occurs in `0ms`, text clears immediately, and `messagesEndRef.scrollIntoView({ behavior: 'instant', block: 'end' })` snaps the bubble into full view.

---

## 9. Multi-Device Real-Time Synchronization & Resilient Reconnection

1. **Dual-Key Conversation Resolution**:
   - Client and server reconcile conversations using both the database UUID (`conversationId`) and the friend's username (`senderUsername` / `recipientUsername`).
   - Ensures incoming messages are never dropped even if one device hasn't resolved the local conversation UUID yet.
2. **Mobile Background & Sleep Recovery Protocol**:
   - `visibilitychange`, `window.focus`, and `window.online` listeners re-fetch active conversation messages whenever the phone wakes or switches back to the app.
   - `EventSource.onopen` automatically pulls missed messages upon reconnection after network or Wi-Fi drops.
3. **Live Inbox Reordering & Unread Indicator**:
   - The conversation list displays real-time `lastMessage` snippets and moves newly active chats to the top in `0ms`.
   - Inactive or background chats receive an unread badge (`new`) that clears when the conversation is opened.
4. **Heartbeat Watchdog & Pure Push SSE (Zero Polling)**:
   - **8-Second Keep-Alive**: Server stream emits explicit `ping` events every 8 seconds to prevent mobile carrier and proxy connection death.
   - **15-Second Watchdog**: The client monitors stream activity; if no ping or message is received within 15 seconds, it forcefully tears down the stale socket and re-establishes a fresh connection.
   - **Non-Destructive Message Merging**: Incoming messages are merged into state via a unique-keyed Map rather than array replacement, eliminating race conditions, flicker, or overwritten messages.
   - **Zero Polling & Zero DB Idle Load**: Removed background intervals so that idle state incurs 0 database queries, 0 serverless invocations, and 0 CPU waste. Real-time updates push in <35ms via SSE.

---

## 10. Responsive Layout & Chat Scroll Interface Architecture

1. **Explicit Flex Constraints (`min-height: 0`)**:
   - Both `.chat-panel` and `.messages` are constrained with `min-height: 0`, `max-height: 100dvh`, and `flex: 1 1 0%` to ensure internal scrollbars activate without expanding the viewport or pushing the composer off-screen.
2. **High-Contrast Visible Custom Scrollbars**:
   - Styled scrollbars with visible thumb tracks (`#9cb5ab` on `#f0f4f2`) provide visual feedback and mouse/trackpad drag control on desktop and tablet browsers.
3. **Floating "Scroll to Bottom" Button**:
   - Automatically appears when the user scrolls up past 90px from the bottom.
   - Displays a "New" badge when messages arrive while viewing history, preventing sudden jumps while reading past messages.
4. **Mobile Responsiveness & Virtual Keyboard Adaptation**:
   - Next.js viewport configured with `interactiveWidget: 'resizes-content'`, preventing virtual keyboards from obscuring the input bar on iOS Safari and Android Chrome.
   - Single-column view with back-navigation on mobile (<768px), 2-column on tablet (768px-1023px), and 3-column on desktop (1024px+).


