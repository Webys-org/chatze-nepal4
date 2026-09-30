import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

function getOrigin(request: Request) {
  const configured = process.env.PUBLIC_APP_URL?.trim()
  if (configured) return new URL(configured).origin
  return new URL(request.url).origin
}

export async function GET(request: Request) {
  const origin = getOrigin(request)

  return NextResponse.json(
    {
      protocol: 'relay-federation',
      version: 'v1',
      origin,
      discovery: {
        user: '/api/federation/v1/users/:username',
        friendRequests: '/api/federation/v1/friend-requests',
        messages: '/api/federation/v1/messages',
      },
      capabilities: {
        transport: 'https-rest',
        browserUpdates: 'web-push-then-rest-fetch',
        forbidden: ['polling', 'sse', 'websocket', 'webrtc', 'peer-to-peer'],
      },
    },
    {
      headers: {
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    },
  )
}

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
  })
}
