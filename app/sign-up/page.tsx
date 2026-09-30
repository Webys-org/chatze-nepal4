'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'

export default function SignUpPage() {
  const router = useRouter(); const [name, setName] = useState(''); const [username, setUsername] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState('')
  async function submit(event: FormEvent) { event.preventDefault(); const result = await authClient.signUp.email({ name, email, password }); if (result.error) return setError('Could not create account. Try another email or username.'); const profile = await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, displayName: name }) }); if (!profile.ok) return setError((await profile.json()).error ?? 'Could not save username.'); router.push('/'); router.refresh() }
  return <main className="auth-page"><form className="auth-card" onSubmit={submit}><p className="eyebrow">RELAY</p><h1>Create your identity</h1><p>Choose the path friends will use to find you.</p><label>Display name<input required value={name} onChange={(e) => setName(e.target.value)} /></label><label>Username<input required pattern="[a-zA-Z0-9_]{3,32}" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="alexrivera" /></label><label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label><label>Password<input type="password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} /></label>{error && <p className="notice">{error}</p>}<button className="primary">Create account</button><a href="/sign-in">Already have an account?</a></form></main>
}
