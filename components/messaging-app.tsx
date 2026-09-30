'use client'

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  Filter,
  Menu,
  MessageCircle,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Send,
  Share2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Store,
  UserPlus,
  X,
  Zap,
} from 'lucide-react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type Conversation = {
  id: string
  otherUser: { username: string; displayName: string }
  status?: string // 'active' | 'archived' | 'closed'
  remote?: boolean
  pending?: boolean
  lastMessage?: { body: string; createdAt: string | Date; senderId: string } | null
  unread?: boolean
}
type ChatMessage = { id: string; senderId: string; body: string; createdAt: string | Date; readAt: string | Date | null }
type IncomingRequest = { id: string; remote: boolean; sender: { username: string; displayName: string } | null; senderOrigin?: string }

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

const NEPAL_QUICK_REPLIES = [
  { label: '🙏 Namaste Welcome', text: '🙏 Namaste! Welcome to our store. How can we assist you today?' },
  { label: '💳 eSewa / Fonepay', text: '💳 Payment QR: eSewa, Khalti, and Fonepay QR available for instant transfer.' },
  { label: '🚚 24h Valley Delivery', text: '🚚 Delivery: Inside Kathmandu Valley within 24 hours. Outside valley via courier.' },
  { label: '📍 Store Location', text: '📍 Visit our showroom: New Road, Kathmandu (near Bishal Bazar). Open 10 AM - 7 PM.' },
  { label: '📦 Order Dispatched', text: '📦 Your order has been packed and handed over to the courier partner!' },
]

export function MessagingApp({
  username,
  displayName,
  conversations,
  currentUserId,
}: {
  username: string
  displayName: string
  conversations: Conversation[]
  currentUserId: string
}) {
  const router = useRouter()
  const [visibleConversations, setVisibleConversations] = useState(conversations)
  const [active, setActive] = useState<Conversation | undefined>(conversations[0])
  const activeRef = useRef<Conversation | undefined>(conversations[0])
  activeRef.current = active

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [handle, setHandle] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [queueTab, setQueueTab] = useState<'active' | 'unread' | 'archived'>('active')
  const [showQuickReplies, setShowQuickReplies] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [requests, setRequests] = useState<IncomingRequest[]>([])
  const [host, setHost] = useState('')
  const [edgeRegion, setEdgeRegion] = useState('Kathmandu (KTM) Edge')
  const [pushStatus, setPushStatus] = useState<'granted' | 'default' | 'denied' | 'unsupported'>('default')
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isStandalone, setIsStandalone] = useState(false)
  const [mobileChatOpen, setMobileChatOpen] = useState(false)
  const mobileChatOpenRef = useRef(false)
  mobileChatOpenRef.current = mobileChatOpen
  const [showMobileSidebar, setShowMobileSidebar] = useState(false)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setHost(window.location.host)
      if ('Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window) {
        setPushStatus(Notification.permission)
      } else {
        setPushStatus('unsupported')
      }

      if (window.matchMedia('(display-mode: standalone)').matches || (window.navigator as unknown as { standalone?: boolean }).standalone) {
        setIsStandalone(true)
      }

      const handleBeforeInstallPrompt = (e: Event) => {
        e.preventDefault()
        setDeferredInstallPrompt(e as BeforeInstallPromptEvent)
      }

      const handleAppInstalled = () => {
        setIsStandalone(true)
        setDeferredInstallPrompt(null)
      }

      window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.addEventListener('appinstalled', handleAppInstalled)

      return () => {
        window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
        window.removeEventListener('appinstalled', handleAppInstalled)
      }
    }
  }, [])

  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const messagesContainerRef = useRef<HTMLDivElement | null>(null)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const [hasNewUnseen, setHasNewUnseen] = useState(false)

  const handleScroll = useCallback(() => {
    if (!messagesContainerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 90
    setShowScrollBottom(!isAtBottom)
    if (isAtBottom) {
      setHasNewUnseen(false)
    }
  }, [])

  const scrollToBottom = useCallback((instant = false) => {
    if (messagesContainerRef.current) {
      if (instant) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight
      } else {
        messagesContainerRef.current.scrollTo({
          top: messagesContainerRef.current.scrollHeight,
          behavior: 'smooth',
        })
      }
    } else if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: instant ? 'instant' : 'smooth', block: 'end' })
    }
    setShowScrollBottom(false)
    setHasNewUnseen(false)
  }, [])

  const dedupeConversations = useCallback((list: Conversation[]) => {
    const map = new Map<string, Conversation>()
    for (const item of list) {
      const key = item.otherUser.username.toLowerCase()
      const existing = map.get(key)
      if (!existing) {
        map.set(key, item)
      } else {
        const newerLastMsg = (item.lastMessage?.createdAt && (!existing.lastMessage?.createdAt || new Date(item.lastMessage.createdAt) > new Date(existing.lastMessage.createdAt)))
          ? item.lastMessage
          : existing.lastMessage
        map.set(key, {
          ...existing,
          ...item,
          id: (item.id && !item.id.startsWith('remote:')) ? item.id : existing.id,
          status: item.status ?? existing.status ?? 'active',
          lastMessage: newerLastMsg,
          unread: item.unread ?? existing.unread ?? false,
          pending: existing.pending && !item.pending ? false : (item.pending ?? existing.pending)
        })
      }
    }
    return Array.from(map.values())
  }, [])

  useEffect(() => {
    setVisibleConversations(dedupeConversations(conversations))
    setActive((current) => {
      if (!current) return conversations[0]
      const match = conversations.find(
        (c) => c.otherUser.username.toLowerCase() === current.otherUser.username.toLowerCase()
      )
      return match ?? conversations[0]
    })
  }, [conversations, dedupeConversations])

  const fetchMessages = useCallback(async (conversationId: string) => {
    try {
      const response = await fetch(`/api/messaging?conversationId=${encodeURIComponent(conversationId)}`, { cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json()
      if (Array.isArray(data.messages)) {
        setMessages((prev) => {
          const incoming = data.messages as ChatMessage[]
          const existingMap = new Map<string, ChatMessage>()
          for (const m of prev) {
            existingMap.set(m.id, m)
          }
          for (const inc of incoming) {
            for (const [k, v] of existingMap.entries()) {
              if (k.startsWith('temp_') && v.body === inc.body && v.senderId === inc.senderId) {
                existingMap.delete(k)
              }
            }
            existingMap.set(inc.id, inc)
          }
          return Array.from(existingMap.values()).sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          )
        })
      }
      if (data.status && activeRef.current?.id === conversationId) {
        setActive((curr) => curr ? { ...curr, status: data.status } : curr)
      }
      if (data.conversationId && data.conversationId !== conversationId) {
        setActive((current) => (current && current.id === conversationId ? { ...current, id: data.conversationId, remote: false } : current))
      }
    } catch {
      // ignore
    }
  }, [])

  const refreshData = useCallback(async () => {
    try {
      const response = await fetch('/api/messaging', { cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json()
      if (Array.isArray(data.requests)) setRequests(data.requests)
      if (Array.isArray(data.conversations)) {
        setVisibleConversations((prev) => {
          return dedupeConversations([...data.conversations, ...prev])
        })
      }
    } catch {
      // ignore
    }
  }, [dedupeConversations])

  useEffect(() => {
    if (!showScrollBottom) {
      scrollToBottom(true)
    }
  }, [messages, showScrollBottom, scrollToBottom])

  async function enablePush(interactive = false) {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setPushStatus('unsupported')
      return
    }

    try {
      let perm = Notification.permission
      if (interactive && perm === 'default') {
        perm = await Notification.requestPermission()
        setPushStatus(perm)
      }
      if (perm !== 'granted') return

      setPushStatus('granted')
      const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      await registration.update()

      const response = await fetch('/api/push/subscribe', { cache: 'no-store' })
      const { publicKey } = await response.json()
      if (!publicKey) return

      let subscription: PushSubscription | null = null
      try {
        const existing = await registration.pushManager.getSubscription()
        if (existing) {
          subscription = existing
        } else {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          })
        }
      } catch {
        try {
          const old = await registration.pushManager.getSubscription()
          if (old) await old.unsubscribe()
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          })
        } catch {
          return
        }
      }

      if (subscription) {
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription.toJSON()),
        })
      }
    } catch {
      // silent
    }
  }

  // Real-time SSE Connection with Cloudflare 100s Lifecycle & Heartbeat Watchdog
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'relay:message') return
      void refreshData()
      router.refresh()
      const convId = event.data?.conversationId
      const currentActive = activeRef.current
      if (convId && currentActive && currentActive.id === convId) {
        void fetchMessages(convId)
      } else if (currentActive) {
        void fetchMessages(currentActive.id)
      }
    }

    navigator.serviceWorker?.addEventListener('message', onMessage)

    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      void enablePush(false)
    }

    let eventSource: EventSource | null = null
    let reconnectTimer: NodeJS.Timeout | null = null
    let watchdogTimer: NodeJS.Timeout | null = null
    let lastHeartbeat = Date.now()
    let isDisposed = false

    const cleanHandle = (h?: string | null) => (h ? h.replace(/^@/, '').trim().toLowerCase() : '')

    function connectStream() {
      if (isDisposed) return
      if (eventSource) {
        try {
          eventSource.close()
        } catch {
          // ignore
        }
        eventSource = null
      }

      try {
        // Delta catch-up: pass lastHeartbeat so server supplies any missed rows
        const streamUrl = `/api/stream?since=${encodeURIComponent(lastHeartbeat)}`
        eventSource = new EventSource(streamUrl)
        lastHeartbeat = Date.now()

        eventSource.onopen = () => {
          lastHeartbeat = Date.now()
          void refreshData()
          if (activeRef.current?.id && !activeRef.current?.pending) {
            void fetchMessages(activeRef.current.id)
          }
        }

        eventSource.addEventListener('connected', (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data)
            if (data.edgeLocation) setEdgeRegion(data.edgeLocation)
          } catch {}
        })

        // Clean Cloudflare 100s stream cycle
        eventSource.addEventListener('cycle', () => {
          connectStream()
        })

        eventSource.addEventListener('ping', () => {
          lastHeartbeat = Date.now()
        })

        eventSource.addEventListener('event', (e: MessageEvent) => {
          lastHeartbeat = Date.now()
          try {
            const payload = JSON.parse(e.data)
            if (payload.type === 'message') {
              const currentActive = activeRef.current
              const currentActiveId = currentActive?.id
              const currentActiveUsername = cleanHandle(currentActive?.otherUser.username)
              const senderUsername = cleanHandle(payload.senderUsername || payload.message?.senderId)
              const recipientUsername = cleanHandle(payload.recipientUsername)
              const myUsername = cleanHandle(username)

              const isCurrentChat = Boolean(
                currentActive && (
                  payload.conversationId === currentActiveId ||
                  payload.message?.conversationId === currentActiveId ||
                  (currentActiveUsername && (currentActiveUsername === senderUsername || currentActiveUsername === recipientUsername))
                )
              )

              const isViewingChat = Boolean(
                isCurrentChat && (typeof window === 'undefined' || window.innerWidth >= 768 || mobileChatOpenRef.current)
              )

              if (isCurrentChat) {
                if (payload.conversationId && currentActiveId !== payload.conversationId && !payload.conversationId.startsWith('remote:')) {
                  setActive((curr) => (curr ? { ...curr, id: payload.conversationId, remote: false } : curr))
                }

                setMessages((prev) => {
                  if (prev.some((m) => m.id === payload.message.id)) return prev
                  const tempIndex = prev.findIndex(
                    (m) => m.id.startsWith('temp_') && m.body === payload.message.body && m.senderId === payload.message.senderId
                  )
                  if (tempIndex !== -1) {
                    const updated = [...prev]
                    updated[tempIndex] = payload.message
                    return updated
                  }
                  return [...prev, payload.message]
                })

                if (payload.message.senderId === currentUserId) {
                  scrollToBottom(true)
                } else if (messagesContainerRef.current) {
                  const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current
                  const isAtBottom = scrollHeight - scrollTop - clientHeight < 120
                  if (isAtBottom) {
                    scrollToBottom(true)
                  } else {
                    setShowScrollBottom(true)
                    setHasNewUnseen(true)
                  }
                } else {
                  scrollToBottom(true)
                }
              }

              // Update conversation list preview and status
              setVisibleConversations((prev) => {
                const updated = prev.map((c) => {
                  const cUser = cleanHandle(c.otherUser.username)
                  const matches = (
                    c.id === payload.conversationId ||
                    (senderUsername && cUser === senderUsername) ||
                    (recipientUsername && cUser === recipientUsername)
                  )
                  if (matches) {
                    return {
                      ...c,
                      id: payload.conversationId || c.id,
                      status: 'active', // message reactivates inquiry
                      lastMessage: {
                        body: payload.message.body,
                        createdAt: payload.message.createdAt,
                        senderId: payload.message.senderId,
                      },
                      unread: !isViewingChat && senderUsername !== myUsername,
                    }
                  }
                  return c
                })
                return updated.sort((a, b) => {
                  const timeA = a.lastMessage?.createdAt ? new Date(a.lastMessage.createdAt).getTime() : 0
                  const timeB = b.lastMessage?.createdAt ? new Date(b.lastMessage.createdAt).getTime() : 0
                  return timeB - timeA
                })
              })
            } else if (payload.type === 'friend_request' || payload.type === 'friend_accepted') {
              void refreshData()
              router.refresh()
              if (payload.type === 'friend_accepted' && payload.conversationId) {
                const friendUsername = cleanHandle(payload.friend?.username)
                setActive((curr) => {
                  if (curr && (cleanHandle(curr.otherUser.username) === friendUsername || curr.id === payload.conversationId)) {
                    return {
                      id: payload.conversationId,
                      otherUser: curr.otherUser,
                      status: 'active',
                      pending: false,
                      remote: false,
                    }
                  }
                  return curr
                })
                void fetchMessages(payload.conversationId)
              }
            }
          } catch {
            // ignore parse errors
          }
        })

        eventSource.onerror = () => {
          if (isDisposed) return
          if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null
              connectStream()
            }, 1200)
          }
        }
      } catch (err) {
        console.warn('[SSE] Connection error:', err)
      }
    }

    connectStream()

    // Watchdog: If no heartbeat in 15 seconds, auto-reconnect (<1s)
    watchdogTimer = setInterval(() => {
      if (Date.now() - lastHeartbeat > 15000) {
        connectStream()
      }
    }, 4000)

    const onSync = () => {
      connectStream()
      void refreshData()
      if (activeRef.current?.id && !activeRef.current?.pending) {
        void fetchMessages(activeRef.current.id)
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        onSync()
      }
    }

    window.addEventListener('focus', onSync)
    window.addEventListener('online', onSync)
    document.addEventListener('visibilitychange', onVisibilityChange)

    void refreshData()

    return () => {
      isDisposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (watchdogTimer) clearInterval(watchdogTimer)
      if (eventSource) {
        try {
          eventSource.close()
        } catch {
          // ignore
        }
      }
      navigator.serviceWorker?.removeEventListener('message', onMessage)
      window.removeEventListener('focus', onSync)
      window.removeEventListener('online', onSync)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [router, fetchMessages, refreshData, scrollToBottom, username, currentUserId])

  // Fetch messages when active conversation changes
  useEffect(() => {
    if (!active?.id || active.pending) return
    setShowScrollBottom(false)
    setHasNewUnseen(false)
    void fetchMessages(active.id)
    const t = setTimeout(() => {
      scrollToBottom(true)
    }, 50)
    return () => clearTimeout(t)
  }, [active?.id, active?.pending, fetchMessages, scrollToBottom])

  async function openConversation(conversation: Conversation) {
    setActive(conversation)
    setMobileChatOpen(true)
    setNotice('')
    setVisibleConversations((prev) =>
      prev.map((c) =>
        c.otherUser.username.toLowerCase() === conversation.otherUser.username.toLowerCase()
          ? { ...c, unread: false }
          : c
      )
    )
    if (conversation.pending) {
      setMessages([])
      setNotice('Friend request sent. Waiting for acceptance.')
      return
    }
    setLoading(true)
    await fetchMessages(conversation.id)
    setLoading(false)
  }

  // Resolve / Reopen Conversation for High-Volume Inbox
  async function toggleConversationStatus(newStatus: 'active' | 'archived') {
    if (!active?.id) return
    const targetId = active.id
    try {
      const response = await fetch('/api/messaging', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: targetId, status: newStatus }),
      })
      if (response.ok) {
        setActive((curr) => (curr && curr.id === targetId ? { ...curr, status: newStatus } : curr))
        setVisibleConversations((prev) =>
          prev.map((c) => (c.id === targetId ? { ...c, status: newStatus } : c))
        )
        setNotice(
          newStatus === 'archived'
            ? 'Inquiry marked as Resolved. Kept active queue clean!'
            : 'Inquiry reopened and moved to active queue.'
        )
      }
    } catch {
      setNotice('Failed to update conversation status.')
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    if (!active || !text.trim()) return
    const bodyContent = text.trim()
    const activeConvId = active.id
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

    // Optimistic UI update
    setText('')
    const optimisticMsg: ChatMessage = {
      id: tempId,
      senderId: currentUserId,
      body: bodyContent,
      createdAt: new Date().toISOString(),
      readAt: null,
    }
    setMessages((current) => [...current, optimisticMsg])
    scrollToBottom(true)

    try {
      const response = await fetch('/api/messaging', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: activeConvId, body: bodyContent }),
      })
      const data = await response.json()
      if (response.ok && data.message) {
        setMessages((current) => {
          if (current.some((m) => m.id === data.message.id)) {
            return current.filter((m) => m.id !== tempId)
          }
          return current.map((msg) => (msg.id === tempId ? data.message : msg))
        })
        if (data.conversationId && active && active.id !== data.conversationId) {
          setActive((current) => (current ? { ...current, id: data.conversationId, remote: false } : current))
        }
      } else {
        setMessages((current) => current.filter((msg) => msg.id !== tempId))
        setNotice(data.error ?? 'Message could not be sent.')
        setText(bodyContent)
      }
    } catch {
      setMessages((current) => current.filter((msg) => msg.id !== tempId))
      setNotice('Network error sending message.')
      setText(bodyContent)
    }
  }

  async function sendRequest() {
    if (!handle.trim()) return
    const inputHandle = handle.trim()
    setNotice('Connecting with user...')
    try {
      const response = await fetch('/api/messaging', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: inputHandle }),
      })
      const data = await response.json()
      if (response.ok) {
        setNotice('Connected! Customer added to queue.')
        setHandle('')
        router.refresh()
        void refreshData()
      } else {
        setNotice(data.error ?? 'Request could not be sent.')
      }
    } catch {
      setNotice('Network error sending request.')
    }
  }

  async function respondToRequest(requestId: string, accept: boolean) {
    try {
      const response = await fetch('/api/messaging', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, accept }),
      })
      if (response.ok) {
        setRequests((current) => current.filter((request) => request.id !== requestId))
        setNotice(accept ? 'Connection accepted. Started new conversation.' : 'Connection declined.')
        void refreshData()
        router.refresh()
      } else {
        setNotice('Request could not be updated.')
      }
    } catch {
      setNotice('Network error updating request.')
    }
  }

  async function clearAllFriendData() {
    if (!window.confirm('Delete all friend requests, friendships, conversations, and messages for this account?')) return
    const response = await fetch('/api/messaging', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearAll: true }),
    })
    if (response.ok) {
      setVisibleConversations([])
      setActive(undefined)
      setRequests([])
      setMessages([])
      setNotice('Friend data cleared. You can start fresh.')
    }
  }

  // Filter conversations for High-Volume Inbox
  const filteredConversations = useMemo(() => {
    let result = visibleConversations

    // Search query filter
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      result = result.filter(
        (c) =>
          c.otherUser.displayName.toLowerCase().includes(q) ||
          c.otherUser.username.toLowerCase().includes(q) ||
          (c.lastMessage?.body && c.lastMessage.body.toLowerCase().includes(q))
      )
    }

    // Queue tab filter
    if (queueTab === 'active') {
      result = result.filter((c) => (c.status || 'active') !== 'archived')
    } else if (queueTab === 'unread') {
      result = result.filter((c) => c.unread)
    } else if (queueTab === 'archived') {
      result = result.filter((c) => (c.status || 'active') === 'archived')
    }

    return result
  }, [visibleConversations, searchQuery, queueTab])

  const counts = useMemo(() => {
    const activeCount = visibleConversations.filter((c) => (c.status || 'active') !== 'archived').length
    const unreadCount = visibleConversations.filter((c) => c.unread).length
    const archivedCount = visibleConversations.filter((c) => (c.status || 'active') === 'archived').length
    return { activeCount, unreadCount, archivedCount }
  }, [visibleConversations])

  return (
    <main className="shell" data-mobile-view={mobileChatOpen && active ? 'chat' : 'list'}>
      {/* Mobile Off-Canvas Drawer for Identity & Settings */}
      {showMobileSidebar && (
        <div className="mobile-drawer-overlay md:hidden" onClick={() => setShowMobileSidebar(false)}>
          <div className="mobile-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between pb-3 mb-2 border-b border-[#e5e9e9]">
              <div className="brand">
                <div className="brand-mark">
                  <MessageCircle size={18} />
                </div>
                <span>Chatze Nepal</span>
              </div>
              <button
                type="button"
                onClick={() => setShowMobileSidebar(false)}
                className="p-1.5 rounded-lg text-zinc-500 hover:bg-zinc-100"
                aria-label="Close menu"
              >
                <X size={20} />
              </button>
            </div>

            <div className="profile-row">
              <div className="avatar avatar-me">{displayName.slice(0, 2).toUpperCase()}</div>
              <div className="profile-copy">
                <strong>{displayName}</strong>
                <span>@{username}</span>
              </div>
            </div>

            {/* Edge Status Badge */}
            <div className="my-2 p-2.5 rounded-xl bg-emerald-50 border border-emerald-200/80 text-xs flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="font-semibold text-emerald-900">{edgeRegion}</span>
              </div>
              <span className="text-[10px] text-emerald-700 font-bold uppercase">100s SSE</span>
            </div>

            <div className="share-card">
              <div className="share-icon">
                <UserPlus size={16} />
              </div>
              <div>
                <strong>Customer Chat Link</strong>
                <p>Add to TikTok / Instagram / FB Bio</p>
                <button
                  className="handle"
                  onClick={() => {
                    if (typeof window !== 'undefined') {
                      void navigator.clipboard?.writeText(`${window.location.origin}/u/${username}`)
                      setNotice('Customer link copied to clipboard!')
                    }
                  }}
                >
                  {host || 'chatze'}/u/{username} <Copy size={12} />
                </button>
              </div>
            </div>

            {deferredInstallPrompt && !isStandalone && (
              <div className="push-banner">
                <button
                  className="push-button"
                  onClick={async () => {
                    if (!deferredInstallPrompt) return
                    await deferredInstallPrompt.prompt()
                    const { outcome } = await deferredInstallPrompt.userChoice
                    if (outcome === 'accepted') {
                      setDeferredInstallPrompt(null)
                      setIsStandalone(true)
                      setNotice('Chatze app installed successfully!')
                      setShowMobileSidebar(false)
                    }
                  }}
                >
                  <Download size={14} /> Install App (PWA)
                </button>
              </div>
            )}

            {pushStatus === 'default' && (
              <div className="push-banner">
                <button className="push-button" onClick={() => void enablePush(true)}>
                  <Bell size={14} /> Enable Web Push
                </button>
              </div>
            )}

            <div className="mt-4 pt-3 border-t border-[#e5e9e9]">
              <button
                className="clear-data text-xs text-red-600 w-full text-left py-2 flex items-center justify-between"
                onClick={() => {
                  setShowMobileSidebar(false)
                  void clearAllFriendData()
                }}
              >
                Clear all chat data <span>✕</span>
              </button>
            </div>

            <div className="sidebar-footer mt-auto">
              <span className="status-dot" />
              ⚡ Cloudflare D1 Native • 5 GB Free
            </div>
          </div>
        </div>
      )}

      {/* Desktop Sidebar (hidden on tablet and mobile) */}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <MessageCircle size={18} />
          </div>
          <span>Chatze Nepal</span>
        </div>

        <div className="profile-row">
          <div className="avatar avatar-me">{displayName.slice(0, 2).toUpperCase()}</div>
          <div className="profile-copy">
            <strong>{displayName}</strong>
            <span>@{username}</span>
          </div>
        </div>

        {/* Cloudflare Kathmandu Edge Live Badge */}
        <div className="my-2.5 p-2.5 rounded-xl bg-emerald-50/90 border border-emerald-200/80 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-semibold text-emerald-950 text-[11px]">{edgeRegion}</span>
          </div>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-200 text-emerald-900 font-bold">LIVE</span>
        </div>

        <div className="share-card">
          <div className="share-icon">
            <Store size={16} />
          </div>
          <div>
            <strong>Customer Inquiries Link</strong>
            <p>Share in FB/TikTok ads & profile bio:</p>
            <button
              className="handle"
              onClick={() => {
                if (typeof window !== 'undefined') {
                  void navigator.clipboard?.writeText(`${window.location.origin}/u/${username}`)
                  setNotice('Store chat link copied to clipboard!')
                }
              }}
            >
              {host || 'chatze'}/u/{username} <Copy size={12} />
            </button>
          </div>
        </div>

        {deferredInstallPrompt && !isStandalone && (
          <div className="push-banner">
            <button
              className="push-button"
              onClick={async () => {
                if (!deferredInstallPrompt) return
                await deferredInstallPrompt.prompt()
                const { outcome } = await deferredInstallPrompt.userChoice
                if (outcome === 'accepted') {
                  setDeferredInstallPrompt(null)
                  setIsStandalone(true)
                  setNotice('Chatze app installed successfully!')
                }
              }}
            >
              <Download size={14} /> Install App (PWA)
            </button>
          </div>
        )}

        {pushStatus === 'default' && (
          <div className="push-banner">
            <button className="push-button" onClick={() => void enablePush(true)}>
              <Bell size={14} /> Enable Web Push
            </button>
          </div>
        )}

        {pushStatus === 'denied' && (
          <div className="sidebar-footer text-xs text-amber-500">
            <BellOff size={13} className="inline mr-1" /> Notifications blocked in browser
          </div>
        )}

        <div className="sidebar-footer">
          <span className="status-dot" />
          ⚡ Cloudflare D1 • 5GB Free SQLite
        </div>
      </aside>

      {/* Conversation List Column (High-Volume Inbox Optimized) */}
      <section className="conversation-list">
        {/* Mobile Header Bar */}
        <div className="flex md:hidden items-center justify-between pb-3 mb-3 border-b border-[#e5e9e9]">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setShowMobileSidebar(true)}
              className="p-1 rounded-lg text-zinc-700 hover:bg-zinc-100 flex items-center justify-center"
              aria-label="Open identity & settings"
            >
              <Menu size={22} />
            </button>
            <div className="brand-mark w-7 h-7 text-xs rounded-lg">
              <MessageCircle size={15} />
            </div>
            <span className="font-bold text-lg tracking-tight font-['Space_Grotesk']">Chatze</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowMobileSidebar(true)}
              className="avatar avatar-me w-8 h-8 text-xs rounded-lg cursor-pointer"
              aria-label="View profile"
            >
              {displayName.slice(0, 2).toUpperCase()}
            </button>
          </div>
        </div>

        <div className="list-header">
          <div>
            <p className="eyebrow text-emerald-800">BUSINESS INBOX</p>
            <h1>Customers</h1>
          </div>
          <button className="clear-data" onClick={() => void clearAllFriendData()}>
            Clear
          </button>
        </div>

        {/* Real-time Customer Search */}
        <div className="relative mb-2">
          <div className="search flex items-center">
            <Search size={15} className="text-slate-400 shrink-0" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search customers or inquiries..."
              className="w-full text-xs"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* High-Volume Queue Filter Tabs (Section 6: Active, Unread, Resolved) */}
        <div className="flex items-center gap-1.5 p-1 mb-2.5 rounded-xl bg-slate-100/90 border border-slate-200/80 text-xs font-medium">
          <button
            type="button"
            onClick={() => setQueueTab('active')}
            className={`flex-1 py-1.5 px-2 rounded-lg text-center transition-all ${
              queueTab === 'active'
                ? 'bg-white text-slate-900 font-bold shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Active ({counts.activeCount})
          </button>
          <button
            type="button"
            onClick={() => setQueueTab('unread')}
            className={`flex-1 py-1.5 px-2 rounded-lg text-center transition-all flex items-center justify-center gap-1.5 ${
              queueTab === 'unread'
                ? 'bg-white text-slate-900 font-bold shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Unread
            {counts.unreadCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-emerald-600 text-white text-[10px] font-bold">
                {counts.unreadCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setQueueTab('archived')}
            className={`flex-1 py-1.5 px-2 rounded-lg text-center transition-all ${
              queueTab === 'archived'
                ? 'bg-white text-slate-900 font-bold shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Resolved ({counts.archivedCount})
          </button>
        </div>

        {/* Add Contact / Federation Peer Input */}
        <div className="search">
          <UserPlus size={16} />
          <input
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void sendRequest()
            }}
            placeholder="@handle or remote URL"
          />
          <button className="send-button" onClick={() => void sendRequest()} aria-label="Add customer">
            <Plus size={17} />
          </button>
        </div>

        {/* Pending Requests */}
        {requests.length > 0 && (
          <div className="request-inbox">
            <p className="eyebrow">NEW CUSTOMER INQUIRIES ({requests.length})</p>
            {requests.map((request) => (
              <div className="request-item" key={request.id}>
                <div className="chat-copy">
                  <strong>@{request.sender?.username ?? 'customer'}</strong>
                  <p>{request.remote ? 'Federated customer' : 'Wants to message'}</p>
                </div>
                <div className="request-actions">
                  <button onClick={() => void respondToRequest(request.id, true)}>Accept</button>
                  <button onClick={() => void respondToRequest(request.id, false)}>Decline</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Paginated / Windowed Chat List */}
        <div className="chat-list">
          {filteredConversations.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500 flex flex-col items-center gap-2">
              <Store size={28} className="text-slate-300" />
              <p className="font-semibold text-slate-700">No conversations in {queueTab} queue</p>
              <p className="text-[11px] max-w-[200px]">
                {queueTab === 'unread'
                  ? 'All inquiries caught up!'
                  : queueTab === 'archived'
                  ? 'Resolved inquiries appear here.'
                  : 'Share your public link to start receiving customer orders.'}
              </p>
            </div>
          ) : (
            filteredConversations.map((conversation) => (
              <button
                key={conversation.id}
                className={`chat-item ${active?.id === conversation.id ? 'selected' : ''}`}
                onClick={() => void openConversation(conversation)}
              >
                <div className="avatar avatar-coral">
                  {conversation.otherUser.displayName.slice(0, 2).toUpperCase()}
                </div>
                <div className="chat-copy">
                  <div className="flex items-center justify-between">
                    <strong>{conversation.otherUser.displayName}</strong>
                    <div className="flex items-center gap-1.5">
                      {conversation.status === 'archived' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">
                          Resolved
                        </span>
                      )}
                      {conversation.unread && <span className="unread">new</span>}
                    </div>
                  </div>
                  <p className="truncate">
                    {conversation.pending
                      ? 'Waiting for acceptance'
                      : conversation.lastMessage
                      ? conversation.lastMessage.body
                      : `@${conversation.otherUser.username}`}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>

        {notice && <p className="notice">{notice}</p>}
      </section>

      {/* Chat Panel Column */}
      <section className="chat-panel">
        <header className="chat-header flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Mobile Back Button */}
            <button
              type="button"
              className="mobile-back-button md:hidden"
              onClick={() => setMobileChatOpen(false)}
              aria-label="Back to conversations"
            >
              <ArrowLeft size={21} />
            </button>

            {active ? (
              <>
                <div className="avatar avatar-coral">
                  {active.otherUser.displayName.slice(0, 2).toUpperCase()}
                </div>
                <div className="contact">
                  <div className="flex items-center gap-2">
                    <strong>{active.otherUser.displayName}</strong>
                    {active.status === 'archived' && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-semibold border border-slate-200">
                        Resolved
                      </span>
                    )}
                  </div>
                  <span>
                    <i /> @{active.otherUser.username}
                    {active.pending ? ' · Waiting for acceptance' : ''}
                  </span>
                </div>
              </>
            ) : (
              <div className="contact">
                <strong>No conversation selected</strong>
                <span>Select a conversation to begin chatting.</span>
              </div>
            )}
          </div>

          {/* Inquiry Resolve / Reopen Controls for High Volume Inbox */}
          {active && !active.pending && (
            <div className="flex items-center gap-2">
              {active.status === 'archived' ? (
                <button
                  type="button"
                  onClick={() => void toggleConversationStatus('active')}
                  className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 transition-colors cursor-pointer"
                  title="Reopen inquiry into active queue"
                >
                  <RotateCcw size={13} className="text-slate-600" />
                  <span>Reopen</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void toggleConversationStatus('archived')}
                  className="px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 flex items-center gap-1.5 transition-colors cursor-pointer shadow-2xs"
                  title="Mark inquiry as resolved to keep inbox clean"
                >
                  <CheckCircle2 size={13} className="text-emerald-700" />
                  <span>Resolve</span>
                </button>
              )}
            </div>
          )}
        </header>

        <div className="messages" ref={messagesContainerRef} onScroll={handleScroll}>
          {active &&
            messages.map((message) => (
              <div
                key={message.id}
                className={`message-row ${message.senderId === currentUserId ? 'mine' : ''}`}
              >
                <div className="bubble">
                  <p>{message.body}</p>
                  <span>
                    {new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    {message.senderId === currentUserId &&
                      (message.readAt ? <CheckCheck size={13} className="read" /> : <Check size={13} />)}
                  </span>
                </div>
              </div>
            ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Floating Scroll to Bottom Button */}
        {showScrollBottom && (
          <button
            type="button"
            className="scroll-bottom-btn"
            onClick={() => scrollToBottom(false)}
            aria-label="Scroll to bottom"
          >
            <ChevronDown size={18} />
            {hasNewUnseen && <span className="scroll-new-badge">New</span>}
          </button>
        )}

        {/* Nepal Quick Canned Responses Drawer & Message Composer */}
        {active && (!active.remote || !active.pending) && (
          <div className="border-t border-slate-200/80 bg-white">
            {/* Quick response trigger toggle */}
            <div className="px-3 pt-2 flex items-center justify-between text-xs text-slate-500">
              <button
                type="button"
                onClick={() => setShowQuickReplies(!showQuickReplies)}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-800 hover:text-emerald-950 px-2 py-0.5 rounded-md hover:bg-emerald-50 transition-colors"
              >
                <Sparkles size={12} className="text-emerald-600" />
                <span>Nepal Quick Responses {showQuickReplies ? '▲' : '▼'}</span>
              </button>
              <span className="text-[10px] text-slate-400">Kathmandu Edge • 0ms REST</span>
            </div>

            {/* Quick replies pill bar */}
            {showQuickReplies && (
              <div className="px-3 py-1.5 flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-2">
                {NEPAL_QUICK_REPLIES.map((reply, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      setText(reply.text)
                    }}
                    className="shrink-0 px-2.5 py-1 rounded-full bg-slate-100 hover:bg-emerald-50 hover:text-emerald-900 border border-slate-200 text-[11px] font-medium text-slate-700 transition-colors cursor-pointer"
                  >
                    {reply.label}
                  </button>
                ))}
              </div>
            )}

            <form className="composer border-0 pt-1" onSubmit={sendMessage}>
              <button
                type="button"
                className="icon-button"
                onClick={() => setShowQuickReplies(!showQuickReplies)}
                aria-label="Nepal Quick Responses"
                title="Nepal Quick Responses"
              >
                <Zap size={18} className={showQuickReplies ? 'text-emerald-600' : 'text-slate-400'} />
              </button>
              <input
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Write a message or choose a quick response..."
              />
              <button className="send-button" aria-label="Send message" disabled={!text.trim()}>
                <Send size={17} />
              </button>
            </form>
          </div>
        )}
      </section>
    </main>
  )
}
