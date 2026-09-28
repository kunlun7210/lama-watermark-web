/*
 * Offline shell and cross-origin isolation for Xiaolin 去水印.
 * COOP/COEP behavior follows coi-serviceworker v0.1.7 (MIT license).
 * __OFFLINE_BUILD__ is replaced with the 14-digit build stamp by Vite.
 */
const OFFLINE_BUILD = '__OFFLINE_BUILD__'

if (typeof window === 'undefined') {
  const SHELL_CACHE = `lama-shell-${OFFLINE_BUILD}`
  const SHELL_PREFIX = 'lama-shell-'
  const scope = self.registration.scope
  const shell = path => new URL(path, scope).href
  let credentialless = false

  self.addEventListener('install', event => {
    event.waitUntil((async () => {
      if (/^\d{14}$/.test(OFFLINE_BUILD)) {
        const cache = await caches.open(SHELL_CACHE)
        const resources = [
          ['index.html', `index.html?offline-build=${OFFLINE_BUILD}`],
          [`assets/app.js?v=${OFFLINE_BUILD}`, `assets/app.js?v=${OFFLINE_BUILD}`],
          [`assets/app.css?v=${OFFLINE_BUILD}`, `assets/app.css?v=${OFFLINE_BUILD}`],
          ['assets/ocr-shared.js', 'assets/ocr-shared.js'],
          ['assets/ort-shared.js', 'assets/ort-shared.js'],
          ['assets/rolldown-runtime.js', 'assets/rolldown-runtime.js'],
          ['version.json', `version.json?offline-build=${OFFLINE_BUILD}`],
          ['offline-runtime.json', `offline-runtime.json?offline-build=${OFFLINE_BUILD}`],
          ['offline-service-worker.js', `offline-service-worker.js?offline-build=${OFFLINE_BUILD}`],
          ['templates/doubao_logo_mask.png', 'templates/doubao_logo_mask.png'],
          ['templates/xiaohongshu_label.png', 'templates/xiaohongshu_label.png'],
          ['models/int8/manifest.json', 'models/int8/manifest.json'],
          ['models/fp32/manifest.json', 'models/fp32/manifest.json'],
        ]
        for (const [key, fetchPath] of resources) {
          const response = await fetch(shell(fetchPath), { cache: 'reload' })
          if (!response.ok) throw new Error(`离线页面预缓存失败：${fetchPath}`)
          await cache.put(shell(key), response)
        }
      }
      await self.skipWaiting()
    })())
  })

  self.addEventListener('activate', event => {
    event.waitUntil((async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE) await caches.delete(name)
      }
      await self.clients.claim()
    })())
  })

  self.addEventListener('message', event => {
    if (event.data?.type === 'coepCredentialless') credentialless = !!event.data.value
  })

  function isolated(response) {
    if (response.status === 0) return response
    const headers = new Headers(response.headers)
    // Cache Storage exposes decoded bodies while retaining transport headers.
    // Reusing Content-Encoding would make script/style loaders decode twice.
    headers.delete('Content-Encoding')
    headers.delete('Content-Length')
    headers.delete('Transfer-Encoding')
    headers.set('Cross-Origin-Embedder-Policy', credentialless ? 'credentialless' : 'require-corp')
    if (!credentialless) headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
    headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }

  function shouldStore(url) {
    if (!url.pathname.startsWith(new URL(scope).pathname)) return false
    // LaMa parts and OCR tar files live in their own verified model caches.
    return !/\/models\/.*\.bin$|\/ocr\/.*\.tar$/.test(url.pathname)
  }

  self.addEventListener('fetch', event => {
    const request = event.request
    if (request.method !== 'GET') return
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return
    const url = new URL(request.url)
    const local = url.origin === self.location.origin && url.href.startsWith(scope)
    const fetchRequest = credentialless && request.mode === 'no-cors'
      ? new Request(request, { credentials: 'omit' }) : request
    event.respondWith((async () => {
      if (local && request.mode !== 'navigate' && !url.pathname.endsWith('/version.json') && shouldStore(url)) {
        const cached = await (await caches.open(SHELL_CACHE)).match(request, { ignoreVary: true })
        if (cached) return isolated(cached)
      }
      try {
        const response = await fetch(fetchRequest)
        if (local && response.ok && shouldStore(url)) {
          event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.put(request, response.clone())).catch(() => {}))
        }
        return isolated(response)
      } catch (error) {
        if (local) {
          const cache = await caches.open(SHELL_CACHE)
          const cached = await cache.match(request, { ignoreVary: true })
            || await cache.match(request, { ignoreSearch: true, ignoreVary: true })
            || (request.mode === 'navigate' ? await cache.match(shell('index.html')) : null)
          if (cached) return isolated(cached)
        }
        throw error
      }
    })())
  })
} else {
  const serviceWorkers = navigator.serviceWorker
  if (serviceWorkers && window.isSecureContext) {
    const script = document.currentScript?.src
    const firstControlPending = !serviceWorkers.controller
    const bootstrapReloadKey = 'lama-sw-bootstrap-reload'
    if (!firstControlPending) {
      try { sessionStorage.removeItem(bootstrapReloadKey) } catch { /* Safari 隐私模式可能禁用存储 */ }
    }
    let bootFallback = null
    const revealPage = () => {
      if (bootFallback) clearTimeout(bootFallback)
      bootFallback = null
      if (!serviceWorkers.controller) {
        try { sessionStorage.removeItem(bootstrapReloadKey) } catch { /* 忽略 */ }
      }
      const wasBooting = document.documentElement.classList.contains('sw-booting')
      document.documentElement.classList.remove('sw-booting')
      if (wasBooting) window.dispatchEvent(new Event('lama-sw-boot-ready'))
    }
    const reloadOnce = (force = false) => {
      if ((!serviceWorkers.controller && !force) || window.__lamaNavigationPending) return
      window.__lamaNavigationPending = true
      if (firstControlPending) {
        try { sessionStorage.setItem(bootstrapReloadKey, '1') } catch { /* 忽略 */ }
      }
      if (bootFallback) clearTimeout(bootFallback)
      location.reload()
    }
    if (firstControlPending) {
      // GitHub Pages 需要由 Service Worker 补 COOP/COEP，首开必然接管并刷新一次。
      // 刷新前先隐藏尚未可用的页面，避免用户看到 UI 绘制后又整体跳回顶部。
      document.documentElement.classList.add('sw-booting')
      // 注册被浏览器拦截时仍要能使用基础页面，不能永久停在启动画面。
      bootFallback = setTimeout(revealPage, 6000)
    }
    serviceWorkers.addEventListener('controllerchange', () => {
      reloadOnce()
    })
    serviceWorkers.register(script).then(registration => {
      let alreadyRetried = false
      try { alreadyRetried = sessionStorage.getItem(bootstrapReloadKey) === '1' } catch { /* 忽略 */ }
      // 极少数浏览器已有 active worker 却没有给当前页 controller。只补刷一次，
      // 防止隐私模式或异常 Service Worker 状态下形成刷新循环。
      if (firstControlPending && registration.active && !serviceWorkers.controller && !alreadyRetried) reloadOnce(true)
      serviceWorkers.controller?.postMessage({
        type: 'coepCredentialless',
        // 服从 index.html 的显式配置。Safari/WebKit 重开后使用 credentialless
        // 会丢失 crossOriginIsolated，进而让 ORT 多线程不可用；require-corp 最稳。
        value: window.coi?.coepCredentialless?.() ?? false,
      })
    }).catch(error => {
      revealPage()
      console.warn('离线页面服务注册失败', error)
    })
  }
}
