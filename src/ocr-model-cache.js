const CACHE_NAME = 'lama-ocr-v6-small-v1'

export const OCR_MODEL_FILES = [
  'ocr/PP-OCRv6_small_det_onnx_infer.tar',
  'ocr/PP-OCRv6_small_rec_onnx_infer.tar',
]

function modelUrls(assetBase) {
  return OCR_MODEL_FILES.map(file => new URL(file, assetBase).href)
}

export async function ocrModelCacheStatus(assetBase) {
  if (!('caches' in globalThis)) return { supported: false, have: 0, total: OCR_MODEL_FILES.length }
  try {
    const cache = await caches.open(CACHE_NAME)
    const found = await Promise.all(modelUrls(assetBase).map(url => cache.match(url)))
    return { supported: true, have: found.filter(response => response?.ok).length, total: found.length }
  } catch {
    return { supported: false, have: 0, total: OCR_MODEL_FILES.length }
  }
}

// Cache Storage survives page reloads. The normal HTTP cache alone cannot
// promise that a user's explicit preload will still be available later.
export async function cacheOcrModels(assetBase, onProgress = () => {}) {
  if (!('caches' in globalThis)) throw new Error('此浏览器不支持持久模型缓存')
  const cache = await caches.open(CACHE_NAME)
  const urls = modelUrls(assetBase)
  for (let index = 0; index < urls.length; index++) {
    const url = urls[index]
    if (!(await cache.match(url))) {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`OCR 模型下载失败：HTTP ${response.status}`)
      await cache.put(url, response)
    }
    onProgress(index + 1, urls.length)
  }
}

// PaddleOCR's worker fetches its asset URLs itself. Blob URLs let it consume
// the persistent Cache Storage copy without relying on the browser HTTP cache.
export async function ocrModelAssetUrls(assetBase) {
  const urls = modelUrls(assetBase)
  if (!('caches' in globalThis)) return { urls, release() {} }
  try {
    await cacheOcrModels(assetBase)
    const cache = await caches.open(CACHE_NAME)
    const objectUrls = []
    try {
      for (const url of urls) {
        const response = await cache.match(url)
        if (!response?.ok) throw new Error('OCR 模型缓存不完整')
        objectUrls.push(URL.createObjectURL(await response.blob()))
      }
      return { urls: objectUrls, release() { objectUrls.forEach(url => URL.revokeObjectURL(url)) } }
    } catch (error) {
      objectUrls.forEach(url => URL.revokeObjectURL(url))
      throw error
    }
  } catch {
    // Storage denial must not disable OCR; direct same-origin download remains available.
    return { urls, release() {} }
  }
}
