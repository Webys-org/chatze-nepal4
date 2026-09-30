import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { Pool } from 'pg'

const origin = (value?: string) => value ? (value.startsWith('http') ? value : `https://${value}`) : undefined
const trustedOrigins = [
  'http://localhost:3000',
  origin(process.env.V0_RUNTIME_URL),
  origin(process.env.V0_DEV_APP_URL),
  origin(process.env.V0_BUILD_URL),
  origin(process.env.V0_SANDBOX_URL),
  origin(process.env.VERCEL_URL),
  origin(process.env.VERCEL_PROJECT_PRODUCTION_URL),
  origin(process.env.PUBLIC_APP_URL),
  origin(process.env.BETTER_AUTH_URL),
  (o: string) => Boolean(o),
].filter(Boolean) as any

const globalForAuth = globalThis as unknown as {
  __memoryAuthDb?: {
    user: any[]
    session: any[]
    account: any[]
    verification: any[]
  }
}

export const memoryAuthDb = globalForAuth.__memoryAuthDb ?? {
  user: [],
  session: [],
  account: [],
  verification: [],
}

if (process.env.NODE_ENV !== 'production') {
  globalForAuth.__memoryAuthDb = memoryAuthDb
}

export const auth = betterAuth({
  database: process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : memoryAdapter(memoryAuthDb),
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET || 'chatze-development-auth-secret-key-12345',
  baseURL: origin(process.env.BETTER_AUTH_URL) || origin(process.env.PUBLIC_APP_URL) || origin(process.env.VERCEL_PROJECT_PRODUCTION_URL) || origin(process.env.VERCEL_URL) || origin(process.env.V0_RUNTIME_URL) || 'http://localhost:3000',
  trustedOrigins,
  ...(process.env.NODE_ENV === 'development' ? { advanced: { defaultCookieAttributes: { sameSite: 'none' as const, secure: true } } } : {}),
})
