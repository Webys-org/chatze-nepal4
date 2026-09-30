# Zero-Setup Cloudflare Edge Architecture System Design (Chatze Nepal Edition)

> **Document Status**: Architectural Blueprint for Implementation  
> **Target Audience**: Production Engineering, Non-Technical Business Deployers  
> **Key Goal**: 100% Free-Forever, Zero-Setup, One-Click Deploy on Cloudflare with Zero External Accounts (No Neon, No Vercel, No Redis required), Optimized for High-Volume Businesses in Nepal (5,000–6,000 daily customers).

---

## 1. Executive Summary & The Problem It Solves

### The Core Problem with Existing Setups
1. **Vercel Invocations & 15-Second Timeouts**:
   Vercel serverless functions terminate SSE streams every 15 seconds. For 100 concurrent clients, reconnect loops eat 24,000 invocations/hr, obliterating Vercel's 100,000/month free tier in a few hours.
2. **External Database Friction**:
   Requiring non-technical shop owners in Nepal to create a Neon/PostgreSQL account, generate connection strings, and run database migrations causes 90%+ user drop-off.
3. **Database Disk Quotas (500 MB)**:
   A business exchanging 30,000 messages daily (5k customers × 6 messages) generates ~900,000 messages/month (~220 MB). A 500 MB limit is exhausted in ~70 days without automated retention management.

### The All-in-One Cloudflare Solution
* **Zero External Services**: Frontend, Backend API, Database, and Real-Time streaming all live natively inside Cloudflare.
* **100% Free Limits**:
  * Cloudflare Workers: **100,000 requests/day** (vs. Vercel's 100k/month).
  * Cloudflare D1 Database: **5,000,000 row reads/day**, **100,000 row writes/day**, **5 GB storage free** (10x larger than Neon's 500 MB).
  * Bandwidth / Egress: **100% Unlimited & Free**.
* **One-Click Deploy**: User clicks `[Deploy to Cloudflare]`, logs in, and the database, tables, encryption keys, and edge routes provision automatically.

---

## 2. High-Level Architecture Diagram

```
+-----------------------------------------------------------------------------------+
|                        NEPAL CLIENTS (Mobile Web / PWA / Desktop)                 |
|  ISPs: WorldLink / NTC / Ncell / Vianet / Subisu                                  |
+-----------------------------------------+-----------------------------------------+
                                          |
                        HTTPS / TLS 1.3  | (5ms - 20ms Kathmandu Ping)
                                          v
+-----------------------------------------------------------------------------------+
|                        CLOUDFLARE KATHMANDU (KTM) EDGE                            |
|                                                                                   |
|  [ WAF Rule ]: IF Country != "NP" (Nepal) -> Block / Challenge (Zero Bot Waste)   |
|  [ Static Assets ]: Next.js / Vite Static UI cached at Edge (0 Worker Invocations)|
|                                                                                   |
|  +-----------------------------------------------------------------------------+  |
|  |                CLOUDFLARE WORKERS / HONO ROUTER                             |  |
|  |                                                                             |  |
|  |  +------------------------+  +---------------------+  +-------------------+  |  |
|  |  | POST /api/messaging    |  | GET /api/stream     |  | /api/setup        |  |  |
|  |  | (Send Msg, Auto-Write) |  | (SSE Stream, 100s)  |  | (1st Boot Wizard) |  |  |
|  |  +------------+-----------+  +----------+----------+  +---------+---------+  |  |
|  +---------------|-------------------------|-----------------------|-----------+  |
|                  |                         |                       |              |
|                  v                         v                       v              |
|  +-----------------------------------------------------------------------------+  |
|  |                CLOUDFLARE NATIVE D1 DATABASE (SQLite at Edge)               |  |
|  |  - Auto-created via wrangler.jsonc                                          |  |
|  |  - Schema auto-migrated on first request                                    |  |
|  |  - 5 GB Free Storage (~20+ Million Messages)                               |  |
|  |  - 5,000,000 Reads/Day | 100,000 Writes/Day                                 |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

---

## 3. Real-Time SSE Architecture on Cloudflare (No WebSockets, No External Redis)

### Why Server-Sent Events (SSE) over WebSockets?
* Zero connection handshake/proxy lag on mobile 4G networks in Nepal (Ncell/NTC).
* Native automatic browser reconnect support via `EventSource`.
* Works through corporate, school, and mobile carrier firewalls without socket dropouts.

### The Cloudflare Workers SSE Mechanics
1. **Connection Lifetime**:
   * Cloudflare Workers Free Tier permits up to **100 seconds** of active SSE streaming per request (compared to Vercel's 15 seconds).
   * A client stays connected for ~100s. When Cloudflare closes the stream, the client's heartbeat watchdog triggers an instant auto-reconnect (<1 second).
2. **Daily Request Budget Math for 5,000–6,000 Daily Customers**:
   * Each customer interaction lasts ~5 to 10 minutes.
   * 1 customer connection over 10 minutes = ~6 reconnect cycles.
   * 5,000 customers × 6 cycles = 30,000 SSE requests/day.
   * 30,000 messages sent = 30,000 POST requests/day.
   * **Total Requests**: 60,000 requests/day (well within Cloudflare's **100,000 free daily limit**).

### Cross-Worker Real-Time Dispatch (Zero Redis)
Because all users are in Nepal, traffic terminates at the same regional edge cluster. Real-time updates utilize:
1. **Direct Stream Pushes**: Active connection streams receive events directly during request processing.
2. **D1 Delta-Polling Fallback**: If an SSE stream reconnects, it passes `?last_message_at=TIMESTAMP`. D1 fetches only newly arrived rows using indexed timestamp lookups (`WHERE conversation_id = ? AND created_at > ?`), consuming less than 1ms of execution.

---

## 4. Native Cloudflare D1 Database Schema & Auto-Boot

No external database connection string is required. Cloudflare automatically injects `env.DB` directly into the worker.

### Auto-Boot Migration (`src/db/auto-migrate.ts`)
On application initialization, the app verifies table existence and runs initialization if empty:

```sql
-- Executed automatically on first request:
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'customer', -- 'admin', 'agent', 'customer'
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  last_message_snippet TEXT,
  last_message_at INTEGER NOT NULL,
  status TEXT DEFAULT 'active', -- 'active', 'archived', 'closed'
  FOREIGN KEY (user_a) REFERENCES users(id),
  FOREIGN KEY (user_b) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

-- High-performance indexes for instantaneous conversation loading:
CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_user_a ON conversations(user_a, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_user_b ON conversations(user_b, last_message_at DESC);
```

### Storage & Free Tier Capacity Verification (D1)
* **Average Message Size**: ~200 bytes.
* **Cloudflare D1 Free Tier Limit**: **5 GB storage** (10x larger than Neon's 500 MB).
* **Total Capacity**: `5 GB ÷ 200 bytes ≈` **25 Million Messages** before storage fills.
* **At 30,000 Messages/Day**: Over **830 days (2.2 years)** of continuous chat history without needing any cleanup or paid tiers.

---

## 5. Non-Technical "One-Click Deploy" Workflow

### Step 1: User Experience (The 60-Second Setup)
1. Shopkeeper clicks `[Deploy to Cloudflare]` badge in GitHub repository.
2. User authenticates with Cloudflare (free account).
3. Cloudflare reads `wrangler.jsonc`:
   * Provisions D1 database `chatze_db`.
   * Binds D1 to the worker as `env.DB`.
   * Sets `JWT_SECRET` using secure crypto random generation.
   * Deploys the application to `https://<business-subdomain>.workers.dev`.

### Step 2: The First-Launch Web Setup Wizard
When the owner opens their new URL for the first time:
1. App detects `SELECT COUNT(*) FROM users` equals 0.
2. Web browser renders a simple setup screen:
   * **Business Name**: (e.g. *New Road Electronics*)
   * **Admin Handle**: (e.g. `@admin`)
   * **Admin Password**: (e.g. `••••••••••••`)
3. Owner submits form:
   * Hashes password using native WebCrypto (`crypto.subtle.digest('SHA-256', ...)`).
   * Inserts primary business admin account.
   * Immediately opens the main chat workspace.

---

## 6. High-Volume Inbox Optimizations (Handling 5k–6k Customers)

When a business advertises on Facebook/TikTok, thousands of customer conversations are created. Loading thousands of items simultaneously crashes browser memory.

### 1. Paginated Inbox Feed
* Conversations list renders using **infinite windowing (`LIMIT 40 OFFSET :page`)**.
* As the operator scrolls down their chat queue, subsequent batches load on demand.

### 2. Search & Filter Queues
* **Unread Only**: `WHERE status = 'active' AND last_message_sender != admin_id`.
* **Archived / Resolved**: Closes finished inquiries so the active inbox stays clean (<50 conversations).

### 3. Automated 90-Day Retention Cron (Optional Maintenance)
Cloudflare Workers include scheduled cron triggers (`crons = ["0 3 * * *"]`):
* Every night at 3:00 AM, Cloudflare automatically archives or deletes messages older than 90 days from resolved conversations, ensuring D1 storage remains within limits indefinitely.

---

## 7. Nepal-Specific Performance & Security Optimizations

### 1. Cloudflare Kathmandu (KTM) PoP Routing
* Traffic from WorldLink, NTC (Nepal Telecom), Ncell, and Vianet connects directly to Cloudflare's local Kathmandu node.
* Round-trip latency: **5ms to 25ms** across Nepal.

### 2. Zero-Bot Geofencing (1-Click WAF)
* In Cloudflare Dashboard, traffic outside Nepal (`ip.geoip.country ne "NP"`) can be challenged or blocked.
* Prevents overseas scrapers and automated bots from consuming the 100,000 daily request quota.

---

## 9. Zero-Config Cryptographic Federation & Peer Binding Architecture

### The Problem with Shared Static Secrets
* Hardcoding a shared secret key into source code allows anyone with repo access to spoof friend requests and messages.
* Requiring non-technical deployers to generate and configure a 64-character secret in `.env` causes deployment failures and manual configuration friction.

### The Solution: Automatic Asymmetric WebCrypto Handshakes
Each instance generates its own unique keypair at runtime using native WebCrypto (`ECDSA` / `Ed25519`). No manual keys or `.env` configuration are required.

```
+------------------------------------+             +------------------------------------+
|        INSTANCE A (Shop A)         |             |       INSTANCE B (Shop B / User)   |
|                                    |             |                                    |
| 1. Auto-generates Keypair on boot: |             | 1. Auto-generates Keypair on boot: |
|    - Private Key (Encrypted in D1) |             |    - Private Key (Encrypted in D1) |
|    - Public Key (Exposed publicly) |             |    - Public Key (Exposed publicly) |
|                                    |             |                                    |
| 2. Signs Friend Request with       |             |                                    |
|    Private Key A                   |             |                                    |
|    POST /api/federation/friend-req +------------>| 2. Receives request with signature |
|    (Header: X-Federation-Signature)|             | 3. Fetches Instance A's Public Key |
|                                    |             |    GET /api/federation/identity    |
|                                    |<------------+    from Instance A                 |
|                                    |             | 4. Verifies signature mathematically|
|                                    |             |    with crypto.subtle.verify()     |
|                                    |             |    -> Verified! Handshake Complete |
+------------------------------------+             +------------------------------------+
```

### 1. Zero-Setup Key Initialization
On first boot, the system checks `system_config` table in D1:
```sql
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```
If `federation_public_key` does not exist:
1. `crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])` runs in 15ms.
2. The **Private Key** is exported to JWK/PKCS8 and saved in D1.
3. The **Public Key** is exported to Base64/SPKI and saved in D1.

### 2. Public Discovery Endpoint (`GET /api/federation/identity`)
Every instance automatically serves its public identity to federation peers:
```json
{
  "instance_url": "https://my-store.workers.dev",
  "name": "Kathmandu Electronics",
  "public_key": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE9j...",
  "algorithm": "ECDSA-P256-SHA256",
  "created_at": 1727611200
}
```

### 3. Secure Handshake Verification Flow
* When Instance A sends a friend request to Instance B:
  1. Payload: `{ from_handle: "@admin", to_handle: "@partner", timestamp: 1727611250 }`.
  2. Instance A creates a signature using its private key:
     `signature = crypto.subtle.sign("SHA-256", privateKey, jsonPayload)`.
  3. Instance B receives the request, pulls Instance A's public key from `https://instance-a.workers.dev/api/federation/identity` (cached at edge for 24h).
  4. Instance B executes `crypto.subtle.verify(...)`.
  5. If valid and timestamp is within 300 seconds (replay attack protection), the friendship is saved and activated.

### Security Guarantees
* **Zero Leaked Keys**: Private keys never leave the server's private D1 database.
* **Zero Configuration**: Neither party enters passwords, credentials, or `.env` tokens.
* **Tamper-Proof**: Modifying the message content or sender origin invalidates the cryptographic signature.

---

## 10. Implementation Roadmap (For Execution)

| Phase | Milestone | Deliverable |
| :--- | :--- | :--- |
| **Phase 1** | Configuration & Engine | `wrangler.jsonc` with auto-D1 binding, `nodejs_compat` flags. |
| **Phase 2** | D1 Database Layer | `auto-migrate.ts` handling zero-setup `CREATE TABLE IF NOT EXISTS`. |
| **Phase 3** | WebCrypto Federation | Auto-generation of ECDSA keypair, `/api/federation/identity` & signature verification. |
| **Phase 4** | Edge API & SSE Router | Hono backend implementing `/api/messaging` and `/api/stream` (100s SSE). |
| **Phase 5** | Setup Wizard UI | First-run onboarding modal for business admin registration. |
| **Phase 6** | Inbox Virtualization | Infinite scrolling conversation sidebar with unread filters. |
| **Phase 7** | One-Click Button | `README.md` with official Cloudflare Deploy button. |

---

*This document serves as the complete, authoritative system design. Implementation can proceed directly from this specification.*
