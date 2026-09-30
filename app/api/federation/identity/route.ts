import { NextResponse } from 'next/server'
import { getPublicOrigin } from '@/lib/federation'
import { getOrInitInstanceKeys } from '@/lib/federation-crypto'
import { ensureDatabaseSchema } from '@/lib/db/ensure-schema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  await ensureDatabaseSchema()
  const { publicKeyBase64, instanceName, createdAt } = await getOrInitInstanceKeys()
  const instanceUrl = getPublicOrigin(request)

  return NextResponse.json(
    {
      instance_url: instanceUrl,
      name: instanceName,
      public_key: publicKeyBase64,
      algorithm: 'ECDSA-P256-SHA256',
      region: 'KTM',
      created_at: createdAt,
    },
    {
      headers: {
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=43200',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    }
  )
}

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
    },
  })
}
