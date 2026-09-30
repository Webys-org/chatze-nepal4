const CACHE_NAME = 'chatze-shell-v1'
const PRECACHE_ASSETS = ['/', '/icon.svg', '/apple-icon.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS)).catch(() => undefined)
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

// Stale-while-revalidate for static app shell ONLY. NEVER cache /api/*
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') {
    return
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => undefined)
          }
          return response
        })
        .catch(() => cached)

      return cached || fetchPromise
    })
  )
})

self.addEventListener('push', (event) => {
  let data = { title: 'New message', body: 'You received a new message.', url: '/', conversationId: undefined }
  try {
    if (event.data) {
      data = { ...data, ...event.data.json() }
    }
  } catch {
    /* Ignore parse error */
  }

  const notificationOptions = {
    body: data.body,
    icon: '/apple-icon.png',
    badge: '/icon-light-32x32.png',
    data: {
      url: data.url || '/',
      conversationId: data.conversationId,
    },
    tag: data.conversationId ? `conv_${data.conversationId}` : undefined,
    renotify: true,
  }

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || 'Chatze', notificationOptions),
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: 'relay:message',
            conversationId: data.conversationId,
            title: data.title,
            body: data.body,
          })
        })
      }),
    ])
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url || '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.focus()
          client.postMessage({
            type: 'relay:message',
            conversationId: event.notification.data?.conversationId,
          })
          return
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl)
      }
    })
  )
})
