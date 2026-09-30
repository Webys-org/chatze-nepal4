'use client'

import { FormEvent, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { CheckCircle2, ShieldCheck, Zap, Globe, Store, ArrowRight, Lock, Sparkles } from 'lucide-react'

export default function SetupPage() {
  const router = useRouter()
  const [businessName, setBusinessName] = useState('New Road Traders')
  const [adminHandle, setAdminHandle] = useState('newroad')
  const [displayName, setDisplayName] = useState('New Road Traders (Admin)')
  const [email, setEmail] = useState('admin@newroad.np')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    // Check if instance is already configured
    fetch('/api/setup')
      .then((r) => r.json())
      .then((data) => {
        if (data.initialized) {
          router.push('/sign-in')
        } else {
          setChecking(false)
        }
      })
      .catch(() => setChecking(false))
  }, [router])

  async function handleBusinessNameChange(name: string) {
    setBusinessName(name)
    const slug = name.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'store'
    if (adminHandle === '' || adminHandle.startsWith('newroad')) {
      setAdminHandle(slug)
      setEmail(`${slug}@chatze.np`)
    }
    setDisplayName(`${name} (Admin)`)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (password.length < 8) {
      setError('Password must be at least 8 characters long.')
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName,
          adminHandle,
          displayName,
          email,
          password,
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Setup failed. Please review your details.')
        setLoading(false)
        return
      }

      // Automatically sign in the new admin
      const signInResult = await authClient.signIn.email({ email, password }).catch(() => null)
      if (signInResult?.error) {
        // Redirect to sign in page if auto-sign-in session wasn't active
        router.push('/sign-in')
      } else {
        router.push('/')
        router.refresh()
      }
    } catch {
      setError('Network error during setup. Please try again.')
      setLoading(false)
    }
  }

  if (checking) {
    return (
      <main className="auth-page">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-3 border-emerald-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm font-semibold text-slate-600">Verifying Cloudflare D1 Edge status...</p>
        </div>
      </main>
    )
  }

  return (
    <main className="auth-page">
      <div className="w-full max-w-[540px] flex flex-col gap-6">
        {/* Top Cloudflare & Nepal Badge */}
        <div className="flex items-center justify-between px-2 text-xs font-semibold text-slate-600">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Kathmandu (KTM) Edge Active
          </div>
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-sky-50 text-sky-800 border border-sky-200">
            <Zap className="w-3.5 h-3.5 text-sky-600" />
            100% Free Forever • Zero Setup
          </div>
        </div>

        <form className="auth-card" onSubmit={submit}>
          <div className="flex items-center gap-3 border-b border-slate-100 pb-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center text-white shadow-lg shadow-emerald-500/20">
              <Store className="w-6 h-6" />
            </div>
            <div>
              <p className="eyebrow text-emerald-700">60-SECOND INITIALIZATION</p>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">Setup Business Chatze</h1>
            </div>
          </div>

          <p className="text-sm text-slate-600 leading-relaxed -mt-1">
            Welcome to your self-hosted customer messaging inbox. Cloudflare D1 (5 GB SQLite) and WebCrypto Asymmetric Keys provision automatically on submission.
          </p>

          <label>
            <span>Business Name</span>
            <input
              type="text"
              required
              value={businessName}
              onChange={(e) => handleBusinessNameChange(e.target.value)}
              placeholder="e.g. New Road Electronics, Patan Boutique"
            />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label>
              <span>Admin Username</span>
              <div className="relative flex items-center">
                <span className="absolute left-3.5 text-slate-400 font-bold text-sm">@</span>
                <input
                  type="text"
                  required
                  pattern="[a-zA-Z0-9_]{3,32}"
                  value={adminHandle}
                  onChange={(e) => setAdminHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                  placeholder="admin"
                  className="pl-8"
                />
              </div>
            </label>

            <label>
              <span>Admin Display Name</span>
              <input
                type="text"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Manager Name"
              />
            </label>
          </div>

          <label>
            <span>Admin Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@yourbusiness.np"
            />
          </label>

          <label>
            <span>Admin Password</span>
            <input
              type="password"
              minLength={8}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
            />
            <span className="text-xs text-slate-500 font-normal">Must be at least 8 characters.</span>
          </label>

          {/* Cloudflare Architecture Features Highlight */}
          <div className="p-3.5 rounded-xl bg-slate-50/90 border border-slate-200/80 text-xs text-slate-600 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-slate-800 font-semibold">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>Instant Cloudflare Architecture Guarantees:</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 pt-1 text-[11px]">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                5 GB Free D1 Database
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                100,000 Free Daily Requests
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                ECDSA P-256 WebCrypto
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                Zero Neon / Vercel Lock-in
              </span>
            </div>
          </div>

          {error && (
            <p className="notice text-sm text-red-600 bg-red-50 p-3 rounded-lg border border-red-200">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="primary flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {loading ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>Provisioning Edge Database...</span>
              </>
            ) : (
              <>
                <span>Launch Business Inbox</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <p className="text-center text-xs text-slate-500">
          Already have an account configured?{' '}
          <a href="/sign-in" className="text-emerald-700 font-semibold underline underline-offset-2">
            Sign in to existing workspace
          </a>
        </p>
      </div>
    </main>
  )
}
