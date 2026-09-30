'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'

export default function SignInPage() {
  const router = useRouter(); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState('')
  async function submit(event: FormEvent) { event.preventDefault(); const result = await authClient.signIn.email({ email, password }); if (result.error) setError('Sign-in failed. Check your email and password.'); else { router.push('/'); router.refresh() } }
  return <main className="auth-page"><form className="auth-card" onSubmit={submit}><p className="eyebrow">RELAY</p><h1>Welcome back</h1><p>Sign in to your private API-based inbox.</p><label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label><label>Password<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>{error && <p className="notice">{error}</p>}<button className="primary">Sign in</button><a href="/sign-up">Create an account</a></form></main>
}
