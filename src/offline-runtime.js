function shellCacheName(build) {
  return `lama-shell-${build}`
}

let runtimeManifestPromise
async function runtimeManifest(assetBase, build) {
  runtimeManifestPromise ||= (async () => {
    const response = await fetch(new URL('offline-runtime.json', assetBase))
    if (!response.ok) throw new Error('离线运行文件清单不可用')
    const manifest = await response.json()
    if (manifest.build !== build || !Array.isArray(manifest.lama) || !Array.isArray(manifest.ocr)) {
      throw new Error('离线运行文件清单版本不匹配')
    }
    return manifest
  })().catch(error => {
    runtimeManifestPromise = null
    throw error
  })
  return runtimeManifestPromise
}

export async function offlineRuntimeStatus(kind, assetBase, build) {
  if (!('caches' in globalThis)) return { supported: false, ready: false }
  try {
    const manifest = await runtimeManifest(assetBase, build)
    const files = manifest[kind]
    if (!Array.isArray(files)) throw new Error('离线资源类型错误')
    const cache = await caches.open(shellCacheName(build))
    const found = await Promise.all(files.map(file => cache.match(new URL(file, assetBase).href)))
    const shellFiles = [
      'index.html', `assets/app.js?v=${build}`, `assets/app.css?v=${build}`,
      'templates/doubao_logo_mask.png', 'templates/xiaohongshu_label.png',
      'models/int8/manifest.json', 'models/fp32/manifest.json',
    ]
    const shellFound = await Promise.all(shellFiles.map(file => cache.match(new URL(file, assetBase).href)))
    return { supported: true, have: found.filter(response => response?.ok).length, total: files.length,
      ready: found.every(response => response?.ok) && shellFound.every(response => response?.ok) }
  } catch {
    return { supported: false, ready: false }
  }
}

const inFlight = new Map()
export async function cacheOfflineRuntime(kind, assetBase, build) {
  if (!('caches' in globalThis)) throw new Error('此浏览器不支持离线资源缓存')
  const key = `${build}:${kind}`
  if (inFlight.has(key)) return inFlight.get(key)
  const task = (async () => {
    const manifest = await runtimeManifest(assetBase, build)
    const files = manifest[kind]
    if (!Array.isArray(files)) throw new Error('离线资源类型错误')
    const cache = await caches.open(shellCacheName(build))
    for (const file of files) {
      const url = new URL(file, assetBase).href
      if (await cache.match(url)) continue
      const response = await fetch(url)
      if (!response.ok) throw new Error(`离线运行文件下载失败：${file}`)
      await cache.put(url, response)
    }
  })()
  inFlight.set(key, task)
  try { return await task } finally { inFlight.delete(key) }
}
