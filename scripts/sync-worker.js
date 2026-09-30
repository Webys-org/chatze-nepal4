const fs = require('node:fs')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '..')
const openNextDir = path.join(rootDir, '.open-next')
const openNextAssetsDir = path.join(openNextDir, 'assets')
const workerSrc = path.join(rootDir, 'worker.js')
const workerDest = path.join(openNextDir, 'worker.js')

if (!fs.existsSync(openNextDir)) {
  fs.mkdirSync(openNextDir, { recursive: true })
}

if (!fs.existsSync(openNextAssetsDir)) {
  fs.mkdirSync(openNextAssetsDir, { recursive: true })
}

if (fs.existsSync(workerSrc)) {
  fs.copyFileSync(workerSrc, workerDest)
  console.log('[Sync Worker] Successfully synced worker.js to .open-next/worker.js')
}

// Copy static assets from public to .open-next/assets
const publicDir = path.join(rootDir, 'public')
if (fs.existsSync(publicDir)) {
  try {
    fs.cpSync(publicDir, openNextAssetsDir, { recursive: true })
    console.log('[Sync Worker] Synced public assets to .open-next/assets')
  } catch (err) {
    console.warn('[Sync Worker] Note during assets copy:', err.message)
  }
}
