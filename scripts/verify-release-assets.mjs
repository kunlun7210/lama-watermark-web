import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'

const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8')
const version = JSON.parse(await readFile(new URL('../dist/version.json', import.meta.url), 'utf8')).version

assert.match(version, /^\d{14}$/)
assert.match(html, new RegExp(`\\./assets/app\\.js\\?v=${version}`))
assert.match(html, new RegExp(`\\./assets/app\\.css\\?v=${version}`))
assert.doesNotMatch(html, /assets\/index-[A-Za-z0-9_-]+\.(?:js|css)/)
await access(new URL('../dist/assets/app.js', import.meta.url))
await access(new URL('../dist/assets/app.css', import.meta.url))
const migrationBridge = await readFile(new URL('../dist/assets/index-LGdPcOC7.js', import.meta.url), 'utf8')
assert.match(migrationBridge, /assets\/app\.js/)
assert.match(migrationBridge, /app-build/)
const previousBridge = await readFile(new URL('../dist/assets/index-BR3uS04e.js', import.meta.url), 'utf8')
assert.match(previousBridge, /index-LGdPcOC7\.js/)
const originalSiteBridge = await readFile(new URL('../dist/assets/index-DiAJy31j.js', import.meta.url), 'utf8')
assert.match(originalSiteBridge, /assets\/app\.js/)
assert.match(originalSiteBridge, /app-build/)
await access(new URL('../dist/assets/index-BlVSS6-9.css', import.meta.url))

console.log('stable release assets and original Pages migration bridge verified')
