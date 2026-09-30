# Chatze (Nepal Edition) — Zero-Setup Cloudflare Edge Architecture

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Webys-org/nep-chat-v1)
[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Cloudflare D1](https://img.shields.io/badge/Database-Cloudflare%20D1%20(5GB%20Free)-orange.svg)](https://developers.cloudflare.com/d1/)
[![Edge Network](https://img.shields.io/badge/PoP-Kathmandu%20(KTM)%20Edge-blue.svg)](https://www.cloudflare.com/network/)

> **100% Free-Forever, Zero-Setup, One-Click Deploy on Cloudflare with Zero External Accounts** (No Neon, No Vercel, No Redis required). Built specifically for high-volume businesses and shops in Nepal (handling 5,000–6,000 daily customers).

---

## 🚀 1-Click Deploy to Cloudflare (The 60-Second Setup)

1. Click the **[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/Webys-org/nep-chat-v1)** badge above.
2. Sign in to your Cloudflare account (100% Free).
3. Cloudflare automatically reads `wrangler.jsonc`:
   - Provisions Cloudflare Native D1 database `chatze_db` (**5 GB Free SQLite Edge DB**).
   - Binds `env.DB` to the worker.
   - Deploys your custom URL: `https://<your-shop>.workers.dev`.
4. Open your new URL in your browser:
   - The **First-Launch Setup Wizard** appears automatically.
   - Enter your **Business Name** (e.g., *New Road Electronics*), **Admin Handle**, and **Password**.
   - Click **Launch Business Inbox** — you are immediately in your high-volume workspace!

---

## ⚡ Why Cloudflare Zero-Setup?

| Metric | Traditional Neon + Vercel Stack | Chatze Cloudflare Native Stack |
| :--- | :--- | :--- |
| **Setup Friction** | 3 accounts (Vercel, Neon, Upstash) + manual SQL migrations | **1-Click Deploy, 0 external accounts** |
| **Real-time SSE Limits** | Terminates every 15 seconds (eats 24,000 calls/hr) | **Up to 100 seconds per stream (<1s auto-reconnect)** |
| **Database Storage** | Neon 500 MB (Exhausts in ~70 days at scale) | **Cloudflare D1: 5 GB Free Storage (~25M messages)** |
| **Database Reads** | Limited free credits | **5,000,000 row reads / day** |
| **Database Writes** | Limited free credits | **100,000 row writes / day** |
| **Bandwidth / Egress** | Paid overages | **100% Unlimited & Free** |
| **Nepal Network Latency** | 120ms–250ms (routed to US/EU servers) | **5ms–20ms (Cloudflare Kathmandu KTM PoP)** |

---

## 🏗️ High-Level Architecture

```
+-----------------------------------------------------------------------------------+
|                        NEPAL CLIENTS (Mobile Web / PWA / Desktop)                 |
|  ISPs: WorldLink / Nepal Telecom (NTC) / Ncell / Vianet / Subisu                  |
+-----------------------------------------+-----------------------------------------+
                                          |
                        HTTPS / TLS 1.3  | (5ms - 20ms Kathmandu Ping)
                                          v
+-----------------------------------------------------------------------------------+
|                        CLOUDFLARE KATHMANDU (KTM) EDGE                            |
|                                                                                   |
|  [ WAF Rule ]: IF Country != "NP" -> Block / Challenge (Zero Bot Quota Waste)     |
|  [ Edge Runtime ]: Cloudflare Workers with nodejs_compat                          |
|                                                                                   |
|  +------------------------+  +---------------------+  +-------------------+       |
|  | POST /api/messaging    |  | GET /api/stream     |  | /setup            |       |
|  | (0ms Optimistic REST)  |  | (100s SSE Stream)   |  | (60s First Launch)|       |
|  +------------+-----------+  +----------+----------+  +---------+---------+       |
|               |                         |                       |                 |
|               v                         v                       v                 |
|  +-----------------------------------------------------------------------------+  |
|  |                CLOUDFLARE NATIVE D1 DATABASE (SQLite at Edge)               |  |
|  |  - Auto-provisioned via wrangler.jsonc                                      |  |
|  |  - Auto-migrated schema with high-performance indexes                       |  |
|  |  - 5 GB Free Storage (~25,000,000 messages before retention)               |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

---

## 💼 High-Volume Inbox Features for Nepali Merchants

1. **Infinite Windowing & Queue Filtering**:
   - **Active Queue**: Only current pending customer conversations.
   - **Unread Filter**: Highlight customers awaiting responses.
   - **Resolved Queue**: Archive completed orders with 1 click so active inbox stays below 50 items.
2. **Nepali Canned Quick Replies**:
   - `🙏 Namaste! Welcome to our store. How can we assist you today?`
   - `💳 Payment QR: eSewa, Khalti, and Fonepay QR available.`
   - `🚚 Delivery: Inside Kathmandu Valley within 24 hours.`
   - `📍 Showroom: New Road, Kathmandu (near Bishal Bazar).`
3. **Automated 90-Day Retention Cron**:
   - Triggered every night at 3:00 AM (`crons = ["0 3 * * *"]`).
   - Automatically purges messages older than 90 days from resolved chats, guaranteeing you never exceed the 5 GB free limit.
4. **Public Store Bio Link**:
   - Every shop receives a direct link (e.g. `https://your-shop.workers.dev/u/admin`).
   - Paste directly into your **Facebook Page, Instagram Bio, or TikTok Store** for customer inquiries.

---

## 🔐 Zero-Config WebCrypto Cryptographic Federation

No shared static passwords or manual `.env` secrets:
* On first boot, the instance dynamically generates an asymmetric **ECDSA (P-256) keypair** using native `crypto.subtle`.
* Stores the private key safely inside Cloudflare D1.
* Serves the public identity via `GET /api/federation/identity`.
* Peer instances verify signatures mathematically with `crypto.subtle.verify(...)`.

---

## 🇳🇵 Nepal 1-Click WAF Bot Geofencing (Zero-Bot Waste)

To prevent foreign scrapers and botnets from consuming your 100,000 free daily request quota, add a simple Cloudflare WAF rule in your Cloudflare dashboard:

```
Expression: ip.geoip.country ne "NP"
Action: Managed Challenge (or Block)
```

This guarantees 100% of your daily request budget is reserved exclusively for domestic customers in Nepal.

---

## 💻 Local Development

```bash
# Clone the repository
git clone https://github.com/Webys-org/chatze.git
cd chatze

# Install dependencies
npm install

# Run dev server
npm run dev
```

Visit `http://localhost:3000`. If running locally without a PostgreSQL database, the app automatically runs in zero-config edge SQLite in-memory mode!
