/**
 * 旧入口迁移桥的浏览器验证（第四项 4.2 / 4.3 / 4.4 的行为部分）。
 *
 * 用法：TEST_URL_PREFIX=http://127.0.0.1:4173 node scripts/browser-stale-entry-check.mjs
 *
 * 要验的是「用户手里那份**旧 HTML** 还能不能活」：
 * 旧 HTML 引用的是带内容哈希的入口（assets/index-DiAJy31j.js），而新部署里那个文件
 * 已经不存在了 —— 它必须仍能到达新版，而不是白屏 404，也不该靠 _headers（GitHub Pages 不执行）。
 *
 * 做法：拿当前 dist/index.html 复制一份临时旧 HTML，把稳定入口换回旧迁移入口，
 * 在**生产构建**（vite preview）上打开它，然后按真实用户路径验收。
 *
 * ⚠️ 临时 HTML 属于测试夹具，绝不能进 Pages：脚本在 finally 里删除，CI 另有兜底守卫。
 */
import { chromium } from 'playwright'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = (process.argv[2] || process.env.TEST_URL_PREFIX || 'http://127.0.0.1:4173').replace(/\/$/, '')
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(repoRoot, 'dist')
const fixtureName = 'stale-entry-test.html'
const fixturePath = join(distDir, fixtureName)

const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
const expectSemver = `v${pkg.version}`

let failed = 0
const checks = []
const check = (label, ok, extra = '') => {
  checks.push([label, ok, extra])
  if (!ok) failed++
}

/* ---------- 生成临时旧 HTML ---------- */
const builtHtml = await readFile(join(distDir, 'index.html'), 'utf8')
const staleHtml = builtHtml
  .replace(/\.\/assets\/app\.js\?v=\d{14}/, './assets/index-DiAJy31j.js')
  .replace(/\.\/assets\/app\.css\?v=\d{14}/, './assets/index-BlVSS6-9.css')
await writeFile(fixturePath, staleHtml)
console.log(`临时旧 HTML：dist/${fixtureName}（引用了旧迁移入口）`)

const browser = await chromium.launch(process.env.CHROME_PATH
  ? { executablePath: process.env.CHROME_PATH }
  : { channel: 'chrome' })
try {
  const context = await browser.newContext({ viewport: { width: 402, height: 874 } })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error)))

  const fixtureUrl = `${base}/${fixtureName}`
  await page.goto(fixtureUrl, { waitUntil: 'load', timeout: 180000 })
  // 迁移桥会 location.replace 一次；等 URL 上出现 app-build
  await page.waitForFunction(() => new URL(location.href).searchParams.has('app-build'), { timeout: 60000 })
  // 再等稳定入口把界面画出来
  await page.waitForFunction(() => (document.querySelector('#status')?.textContent || '').trim().length > 0, { timeout: 60000 })
  await page.waitForTimeout(2500)

  const state = await page.evaluate(() => ({
    url: location.href,
    query: new URL(location.href).searchParams.get('app-build'),
    version: (document.querySelector('#app-version')?.textContent || '').trim(),
    status: (document.querySelector('#status')?.textContent || '').trim(),
    crossOriginIsolated,
    resources: performance.getEntriesByType('resource').map(entry => entry.name),
  }))

  check('最终 URL 带 app-build=<14 位构建版本>',
    /^\d{14}$/.test(state.query || ''), state.query || '(空)')
  check('页面显示当前语义版本 ' + expectSemver,
    new RegExp(`^${expectSemver.replace(/[.]/g, '\\.')} · \\d{4}\\.\\d{2}\\.\\d{2}$`).test(state.version), state.version)
  check('状态为「等待选择图片」', state.status === '等待选择图片', state.status)
  check('迁移后仍是跨源隔离（ORT 多线程前提）', state.crossOriginIsolated === true)

  const bridgeIndex = state.resources.findIndex(name => name.includes('index-DiAJy31j.js'))
  const appIndex = state.resources.findIndex(name => /assets\/app\.js\?v=\d{14}/.test(name))
  check('性能资源里先有旧迁移入口，后有 app.js?v=…',
    bridgeIndex >= 0 && appIndex >= 0 && bridgeIndex < appIndex,
    `迁移入口 #${bridgeIndex} / 稳定入口 #${appIndex}`)
  check('迁移桥注入的稳定样式也已加载',
    state.resources.some(name => /assets\/app\.css\?v=\d{14}/.test(name)))

  /* 4.2 的另一面：迁移后的目标地址（带 app-build 的正规 HTML）必须能正常跑 */
  const realUrl = `${base}/index.html?app-build=${state.query}`
  await page.goto(realUrl, { waitUntil: 'load', timeout: 180000 })
  await page.waitForTimeout(2000)
  const realState = await page.evaluate(() => ({
    url: location.href,
    status: (document.querySelector('#status')?.textContent || '').trim(),
    version: (document.querySelector('#app-version')?.textContent || '').trim(),
    crossOriginIsolated,
  }))
  check('带 app-build 的正规地址不会触发循环刷新（URL 稳定）',
    realState.url === realUrl, realState.url)
  check('带 app-build 的正规地址正常进入应用',
    realState.status === '等待选择图片' && realState.version.startsWith(expectSemver)
      && realState.crossOriginIsolated === true,
    `${realState.version} · ${realState.status}`)

  check('浏览器异常为 0', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
  // 夹具必须删干净 —— 它绝不能被当作站点资源发布出去
  await rm(fixturePath, { force: true })
}

const stillThere = await readFile(fixturePath, 'utf8').then(() => true, () => false)
check('临时 HTML 已删除（不会上传到 Pages）', stillThere === false)

console.log('\n=== 结果 ===')
for (const [label, ok, extra] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
}
if (failed) throw new Error(`旧入口迁移检查有 ${failed} 项未通过`)
console.log('\n✅ 旧入口迁移桥可用：旧 HTML → 新版 → 稳定入口，全程无白屏、无循环刷新')
