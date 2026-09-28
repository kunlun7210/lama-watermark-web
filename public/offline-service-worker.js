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
    serviceWorkers.addEventListener('controllerchange', () => {
      if (serviceWorkers.controller) location.reload()
    })
    serviceWorkers.register(script).then(() => {
      serviceWorkers.controller?.postMessage({
        type: 'coepCredentialless',
        value: !(window.chrome || window.netscape),
      })
    }).catch(error => console.warn('离线页面服务注册失败', error))
  }
}
