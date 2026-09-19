import * as ort from 'onnxruntime-web/wasm'
import './style.css'
import { createRuleEngine } from './rules.js'
import { gaussianBlur, grayFromRgb, grayFromRgb8 } from './imaging.js'
import { buildZip } from './zip.js'

const APP_VERSION = __APP_VERSION__
// 部署新版后自动刷新一次：比对 dist/version.json 与本次构建注入的版本号。
// 刷新只影响页面本身，Cache Storage 里的模型缓存原样保留。
void (async () => {
  try {
    const response = await fetch(new URL('version.json', document.baseURI), { cache: 'no-store' })
    if (!response.ok) return
    const { version } = await response.json()
    if (!version || version === APP_VERSION) return
    const key = 'lama-version-reload'
    if (sessionStorage.getItem(key) === version) return // 已为本版本刷新过，防循环
    sessionStorage.setItem(key, version)
    location.reload()
  } catch { /* 网络不可用时保持现状 */ }
})()

const MODEL_SIZE = 512
const IMAGE_DB_NAME = 'lama-iphone-poc'
const IMAGE_STORE = 'images'
const RESTORE_LIMIT_BYTES = 200 * 1024 * 1024
const RESTORE_LIMIT_COUNT = 40
const INFER_TIMEOUT_MS = 120000
const MODEL_CACHE_NAME = 'lama-model-v2'
const CHUNK_RETRIES = 4
// 备用镜像：GitHub 仓库经 jsDelivr CDN 分发，国内通常比 github.io 快
const MIRROR_REPO = 'kunlun7210/lama-watermark-web@main'
const MODELS = {
  int8: {
    id: 'int8',
    label: 'INT8 62MB',
    manifest: 'models/int8/manifest.json',
    inputLayout: 'masked-rgb-mask',
    sha256: 'cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe',
  },
  fp32: {
    id: 'fp32',
    label: 'FP32 198MB',
    manifest: 'models/fp32/manifest.json',
    inputLayout: 'image-mask',
    sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6',
  },
}
const elements = {
  file: document.querySelector('#file-input'),
  selectedName: document.querySelector('#selected-name'),
  runBatch: document.querySelector('#run-batch'),
  stop: document.querySelector('#stop'),
  saveAlbum: document.querySelector('#save-album'),
  saveAll: document.querySelector('#save-all'),
  clear: document.querySelector('#clear'),
  source: document.querySelector('#source'),
  result: document.querySelector('#result'),
  status: document.querySelector('#status'),
  progress: document.querySelector('#progress'),
  progressLabel: document.querySelector('#progress-label'),
  metrics: document.querySelector('#metrics'),
  queueCard: document.querySelector('#queue-card'),
  queue: document.querySelector('#queue'),
  queueSummary: document.querySelector('#queue-summary'),
  picker: document.querySelector('.picker'),
  cacheTags: { int8: document.querySelector('#cache-tag-int8'), fp32: document.querySelector('#cache-tag-fp32') },
  modelInputs: [...document.querySelectorAll('input[name="model"]')],
  downloadBar: document.querySelector('#download-bar'),
  downloadStatus: document.querySelector('#download-status'),
  downloadLabel: document.querySelector('#download-label'),
  downloadProgress: document.querySelector('#download-progress'),
}

const state = {
  items: [],
  nextId: 1,
  currentId: null,
  running: false,
  stopRequested: false,
  lastModelLoadedMs: 0,
}

let activeSession = null
let sessionPromise = null
let sessionModelId = null
let ruleEngine = null
let ruleEnginePromise = null

const assetBase = new URL(import.meta.env.BASE_URL, location.href)
const ortBase = new URL('ort/', assetBase).href
ort.env.wasm.wasmPaths = {
  wasm: `${ortBase}ort-wasm-simd-threaded.wasm`,
  mjs: `${ortBase}ort-wasm-simd-threaded.mjs`,
}
ort.env.wasm.numThreads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1
ort.env.wasm.simd = true
ort.env.logLevel = 'warning'

const selectedModel = () => MODELS[elements.modelInputs.find(input => input.checked)?.value || 'int8']
const currentItem = () => state.items.find(item => item.id === state.currentId) || null

/**
 * 让界面有机会先画出状态文字，再去做会阻塞主线程的推理。
 * 注意：隐藏标签页里 requestAnimationFrame 永不触发，必须用定时器兜底，
 * 否则整个批量流程会静默停在这一步（线上实测踩过）。
 */
function yieldToUi() {
  return new Promise(resolve => {
    let settled = false
    const done = () => { if (!settled) { settled = true; resolve() } }
    requestAnimationFrame(() => requestAnimationFrame(done))
    setTimeout(done, 150)
  })
}

function setStatus(text, ratio = null, detail = '') {
  elements.status.textContent = text
  elements.progressLabel.textContent = detail
  if (ratio === null) elements.progress.removeAttribute('value')
  else elements.progress.value = Math.max(0, Math.min(1, ratio))
}

function setMetrics(values) {
  elements.metrics.replaceChildren(...Object.entries(values).map(([label, value]) => {
    const box = document.createElement('div')
    const dt = document.createElement('dt')
    const dd = document.createElement('dd')
    dt.textContent = label
    dd.textContent = value
    box.append(dt, dd)
    return box
  }))
}

/**
 * 下载进度条：固定在第一屏（header 下方），只在模型准备阶段出现。
 * 防御：元素可能因「旧 HTML + 新 JS」的缓存混合态而缺失（Safari 上实测发生过，
 * 4 张全部死于进度条取值），所以任一元素找不到就静默跳过——进度显示永远
 * 不允许影响处理流程本身。
 */
function setDownloadBar(visible, text, ratio = null, detail = '') {
  const bar = elements.downloadBar || document.querySelector('#download-bar')
  if (!bar) return
  const status = elements.downloadStatus || bar.querySelector('#download-status')
  const progress = elements.downloadProgress || bar.querySelector('#download-progress')
  const label = elements.downloadLabel || bar.querySelector('#download-label')
  if (!status || !progress) return
  bar.hidden = !visible
  if (!visible) return
  status.textContent = text
  label.textContent = detail
  if (ratio === null) progress.removeAttribute('value')
  else progress.value = Math.max(0, Math.min(1, ratio))
}

function baseMetrics() {
  const item = currentItem()
  return {
    图片: item?.width ? `${item.width} × ${item.height}` : '未选择',
    模型: selectedModel().label,
    // 线程数同时反映跨源隔离是否生效（4 = 生效，1 = 退回单线程），不再单列「隔离模式」
    线程: String(ort.env.wasm.numThreads),
  }
}

/* ---------------- 模型会话 ---------------- */

function progressDetail(loaded, total, index, chunkCount, started, sourceLabel) {
  const elapsed = Math.max((performance.now() - started) / 1000, 0.1)
  const mbps = loaded / 1048576 / elapsed
  const remaining = mbps > 0 ? (total - loaded) / 1048576 / mbps : 0
  const eta = remaining >= 60 ? `${Math.ceil(remaining / 60)} 分钟` : `${Math.max(1, Math.ceil(remaining))} 秒`
  const source = sourceLabel ? ` · 源 ${sourceLabel}` : ''
  return `分段 ${index}/${chunkCount} · ${(loaded / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB · ${mbps.toFixed(1)} MB/s · 约剩 ${eta}${source}`
}

/** 同源（GitHub Pages）与 jsDelivr 镜像；两者都支持 Range，可续传 */
function mirrorUrl(relativePath) {
  return `https://cdn.jsdelivr.net/gh/${MIRROR_REPO}/public/${relativePath.replace(/^\.?\//, '')}`
}

/**
 * 清单里的 chunk.file 只有文件名（相对清单所在目录），拼镜像路径时要补回目录，
 * 否则 jsDelivr 上会 404。
 */
function chunkRelativePath(model, chunk) {
  if (chunk.file.includes('/')) return chunk.file.replace(/^\.?\//, '')
  const manifest = model.manifest
  const slash = manifest.lastIndexOf('/')
  const dir = slash >= 0 ? manifest.slice(0, slash + 1) : ''
  return (dir + chunk.file).replace(/^\.?\//, '')
}

function preferOrigin() {
  return new URLSearchParams(location.search).get('source') === 'origin'
}

/** 默认 jsDelivr（国内通常更快），同源（GitHub Pages）备用；`?source=origin` 可强制同源优先 */
function chunkSources(chunkUrl, relativePath) {
  const list = [
    { label: 'jsDelivr', url: mirrorUrl(relativePath) },
    { label: '同源', url: chunkUrl },
  ]
  if (preferOrigin()) list.reverse()
  return orderSources(list)
}

/** 记住本次会话里真正下得动的源，后面几段直接用它，不再逐段浪费重试 */
function orderSources(list) {
  if (!preferredSourceLabel) return list
  const hit = list.find(source => source.label === preferredSourceLabel)
  if (!hit || list[0] === hit) return list
  return [hit, ...list.filter(source => source !== hit)]
}

/** 清单本身也默认走镜像：GitHub Pages 在部分网络下会直接连不上 */
async function fetchManifest(model) {
  const sameOrigin = new URL(model.manifest, assetBase).href
  const mirror = mirrorUrl(model.manifest)
  const order = preferOrigin() ? [sameOrigin, mirror] : [mirror, sameOrigin]
  let lastError = null
  for (const url of order) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(url, { cache: 'no-cache' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json()
      } catch (error) {
        lastError = error
        await new Promise(resolve => setTimeout(resolve, 600))
      }
    }
  }
  throw new Error(`模型清单读取失败：${lastError?.message || '网络错误'}`)
}

async function openModelCache() {
  if (typeof caches === 'undefined') return null
  try {
    // v1 的缓存键与模型目录无关（INT8 / FP32 会互相污染），清掉一次即可（不存在时是空操作）
    try { await caches.delete('lama-model-v1') } catch { /* 忽略 */ }
    return await caches.open(MODEL_CACHE_NAME)
  } catch { return null }
}

/**
 * 缓存键：两个模型的分段文件名完全一样（都是 lama.part.000.bin），
 * 所以键必须带目录，否则 INT8 与 FP32 会互相覆盖（表现为「模型校验未通过」）。
 * 用一个固定合成 origin，既保证唯一，又与下载源（同源 / jsDelivr）无关。
 */
function chunkCacheKey(relativePath) {
  return `https://lama-model.cache/${relativePath.replace(/^\.?\//, '')}`
}

/** 取一段：先查持久缓存，命中就直接用（重开页面不再下载） */
async function readCachedChunk(cache, cacheKey, expectedSize) {
  if (!cache) return null
  try {
    const response = await cache.match(cacheKey)
    if (!response) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === expectedSize) return bytes
    await cache.delete(cacheKey)
  } catch (error) { console.warn('读取模型缓存失败', error) }
  return null
}

async function writeCachedChunk(cache, cacheKey, bytes) {
  if (!cache) return
  try {
    await cache.put(cacheKey, new Response(new Blob([bytes]), {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) },
    }))
  } catch (error) { console.warn('写入模型缓存失败', error) }
}

/**
 * 单段下载：断线/超时后带退避重试，并用 Range 从已下载位置续传。
 * 手机上网络抖动很常见，整段重来在 0.2MB/s 的链路上代价太大 —— 所以进度必须留在重试循环之外。
 */
async function downloadChunk(chunk, sources, onProgress) {
  let lastError = null
  let received = []
  let have = 0
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = sources[sourceIndex]
    for (let attempt = 0; attempt < CHUNK_RETRIES; attempt++) {
      const controller = new AbortController()
      let idle
      const armIdle = () => {
        clearTimeout(idle)
        idle = setTimeout(() => controller.abort(), 45000)
      }
      try {
        armIdle()
        const headers = have > 0 ? { Range: `bytes=${have}-` } : undefined
        const response = await fetch(source.url, { headers, cache: 'no-store', signal: controller.signal })
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        // 服务端不支持断点续传时只能重来
        if (have > 0 && response.status !== 206) { have = 0; received = [] }
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          armIdle()
          received.push(value)
          have += value.byteLength
          onProgress(have, chunk.size, source.label)
          if (have >= chunk.size) break
        }
        clearTimeout(idle)
        if (have !== chunk.size) throw new Error(`分段不完整（${have}/${chunk.size} 字节）`)
        const bytes = new Uint8Array(chunk.size)
        let offset = 0
        for (const part of received) { bytes.set(part, offset); offset += part.byteLength }
        return { bytes, source, resumed: received.length > 1 || have > chunk.size }
      } catch (error) {
        clearTimeout(idle)
        lastError = error.name === 'AbortError' ? new Error('网络空闲超过 45 秒') : error
        console.info(`第 ${attempt + 1} 次尝试失败（已收到 ${(have / 1048576).toFixed(1)}MB，下次从该位置续传）：${lastError.message}`)
        if (have >= chunk.size) break
        await new Promise(resolve => setTimeout(resolve, Math.min(8000, 800 * (attempt + 1))))
      }
    }
    if (sourceIndex + 1 < sources.length) {
      console.info(`换用备用源：${sources[sourceIndex + 1].label}（已下载 ${(have / 1048576).toFixed(1)}MB 保留）`)
    }
  }
  throw lastError || new Error('模型分段下载失败')
}

async function fetchModel(model) {
  try {
    const manifestUrl = new URL(model.manifest, assetBase).href
    const manifest = await fetchManifest(model)
    if (!Number.isSafeInteger(manifest.totalSize) || !Array.isArray(manifest.chunks)) throw new Error('模型清单格式错误')

    const cache = await openModelCache()
    const bytes = new Uint8Array(manifest.totalSize)
    let loaded = 0
    let cachedCount = 0
    let currentSource = ''
    let switchedSource = false

    for (let index = 0; index < manifest.chunks.length; index++) {
      const chunk = manifest.chunks[index]
      const chunkUrl = new URL(chunk.file, manifestUrl).href
      const relativePath = chunkRelativePath(model, chunk)

      const cached = await readCachedChunk(cache, chunkCacheKey(relativePath), chunk.size)
      if (cached) {
        bytes.set(cached, loaded)
        loaded += cached.byteLength
        cachedCount++
        const text = '正在读取已缓存的模型'
        const detail = `第 ${cachedCount} 段来自本机缓存 · ${(loaded / 1048576).toFixed(0)} / ${(manifest.totalSize / 1048576).toFixed(0)} MB`
        setDownloadBar(true, text, loaded / manifest.totalSize, detail)
        // 状态卡不再重复显示下载信息，只在顶部下载条展示
        continue
      }

      const sources = chunkSources(chunkUrl, relativePath)
      const started = performance.now()
      const chunkBytes = await downloadChunk(chunk, sources, (have, size, label) => {
        currentSource = label
        const text = '正在下载 LaMa 模型'
        const ratio = (loaded + have) / manifest.totalSize
        const detail = progressDetail(loaded + have, manifest.totalSize, index + 1, manifest.chunks.length, started, label)
        setDownloadBar(true, text, ratio, detail)

      })
      bytes.set(chunkBytes.bytes, loaded)
      loaded += chunkBytes.bytes.byteLength
      currentSource = chunkBytes.source.label
      preferredSourceLabel = chunkBytes.source.label
      await writeCachedChunk(cache, chunkCacheKey(relativePath), chunkBytes.bytes)

      // 这一段太慢就下一段换源试试（只切一次，避免来回横跳）
      const seconds = Math.max(0.1, (performance.now() - started) / 1000)
      const speed = chunkBytes.bytes.byteLength / seconds
      if (speed < SLOW_SOURCE_BYTES_PER_SECOND && !switchedSource) {
        switchedSource = true
        const other = sources.find(source => source.label !== chunkBytes.source.label)
        if (other) {
          preferredSourceLabel = other.label
          console.info(`当前源 ${chunkBytes.source.label} 速度 ${(speed / 1024).toFixed(0)} KB/s，下一段改用 ${other.label}`)
          const text = '当前线路较慢，正在切换下载源'
          const detail = `已下载 ${(loaded / 1048576).toFixed(0)} MB，换源重试`
          setDownloadBar(true, text, loaded / manifest.totalSize, detail)

        }
      }
    }

    if (loaded !== manifest.totalSize) throw new Error('模型文件不完整')

    const expectedSha = manifest.sha256 || model.sha256
    if (expectedSha && crypto?.subtle) {
      const text = '正在校验模型完整性'
      setDownloadBar(true, text, 1, '只需一次')

      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
      if (hex !== expectedSha) {
        await clearModelCache(model)
        throw new Error('模型校验未通过（下载过程中被截断），已清除缓存，请重新下载')
      }
    }
    if (cachedCount) setStatus('模型已就绪', 1, `${cachedCount} 段来自本机缓存，下次打开无需再下载`)
    void refreshCacheTags()
    return bytes
  } finally {
    setDownloadBar(false)
  }
}

async function clearModelCache() {
  try {
    if (typeof caches !== 'undefined') await caches.delete(MODEL_CACHE_NAME)
  } catch (error) { console.warn('清除模型缓存失败', error) }
}

/** 已缓存多少段（用于在界面上告诉用户「这次不用再下载」） */
async function modelCacheStatus(model) {
  const cache = await openModelCache()
  if (!cache) return { supported: false }
  try {
    const manifest = await fetchManifest(model)
    let have = 0
    for (const chunk of manifest.chunks) {
      if (await readCachedChunk(cache, chunkCacheKey(chunkRelativePath(model, chunk)), chunk.size)) have++
    }
    return { supported: true, have, total: manifest.chunks.length, bytes: manifest.totalSize }
  } catch { return { supported: false } }
}

let preferredSourceLabel = null
const SLOW_SOURCE_BYTES_PER_SECOND = 120 * 1024

/** 把每个模型的缓存状态直接标在模型名后面（不再单独占一行指标） */
async function refreshCacheTags() {
  await Promise.all(Object.values(MODELS).map(async model => {
    const tag = elements.cacheTags[model.id]
    if (!tag) return
    const status = await modelCacheStatus(model)
    if (!status.supported) {
      tag.hidden = true
      return
    }
    tag.hidden = false
    if (status.have === status.total) {
      tag.textContent = '已缓存'
      tag.className = 'model-cache-tag cached'
    } else if (status.have === 0) {
      tag.textContent = '未缓存'
      tag.className = 'model-cache-tag missing'
    } else {
      tag.textContent = `${status.have}/${status.total} 段`
      tag.className = 'model-cache-tag partial'
    }
  }))
}

async function releaseActiveSession() {
  if (!activeSession) return
  try { await activeSession.session.release?.() } catch (error) { console.warn('模型释放失败', error) }
  activeSession = null
}

function getSession(model) {
  if (activeSession?.model.id === model.id) return Promise.resolve({ ...activeSession, loadMs: 0, reused: true })
  if (sessionPromise && sessionModelId === model.id) return sessionPromise
  sessionModelId = model.id
  sessionPromise = (async () => {
    await releaseActiveSession()
    const started = performance.now()
    let bytes = await fetchModel(model)
    setStatus(`正在初始化 ${model.label}`, null, '请保持 Safari 在前台')
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
      enableMemPattern: true,
    })
    bytes = null
    activeSession = { session, model }
    return { session, model, loadMs: performance.now() - started, reused: false }
  })().catch(error => {
    sessionModelId = null
    throw error
  }).finally(() => { sessionPromise = null })
  return sessionPromise
}

function getRuleEngine() {
  if (ruleEngine) return Promise.resolve(ruleEngine)
  if (!ruleEnginePromise) {
    ruleEnginePromise = createRuleEngine(assetBase).then(engine => {
      ruleEngine = engine
      return engine
    })
  }
  return ruleEnginePromise
}

/* ---------------- 图像与识别 ---------------- */

async function decodeFile(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    try {
      const url = URL.createObjectURL(file)
      try {
        const image = new Image()
        image.src = url
        await image.decode()
        return await createImageBitmap(image)
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch {
      throw new Error('浏览器的图像解码器打不开这个文件；若它是 HEIC（有些文件名仍写成 .JPG），请先在相册里导出成 PNG/JPG')
    }
  }
}

/** 单张处理时的报错文案：区分「格式不支持」和「来自上次缓存、数据已失效」 */
function friendlyError(item, error) {
  const text = String(error?.message || error || '')
  if (item.restored && /解码|打不开|decode|Load failed|TypeError/i.test(text)) {
    return '这张图片来自上次缓存，数据已失效，请重新选择图片'
  }
  return text
}

function drawBitmap(canvas, bitmap) {
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0)
}

/** 识别水印：读完像素立即释放大数组，只返回区域 */
async function detectRegions(canvas) {
  const width = canvas.width
  const height = canvas.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const imageData = context.getImageData(0, 0, width, height)
  const rgba = imageData.data
  const gray = grayFromRgb(rgba, width, height)
  const gray8 = grayFromRgb8(rgba, width, height)
  const engine = await getRuleEngine()
  return engine.detect({ rgba, gray, gray8, width, height })
}

/**
 * 与 server.py 一致：没有形状掩膜的区域按 repair_padding 向外扩一圈。
 * 紧贴水印的矩形会让 LaMa 照着水印笔画继续画（出现文字状鬼影）。
 */
function expandRepairPadding(region, width, height) {
  const padding = Math.max(0, Math.round(region.repairPadding || 0))
  if (region.mask || padding === 0) return region
  const x = Math.max(0, region.x - padding)
  const y = Math.max(0, region.y - padding)
  return {
    ...region,
    x,
    y,
    width: Math.min(width, region.x + region.width + padding) - x,
    height: Math.min(height, region.y + region.height + padding) - y,
  }
}

function regionMaskInWindow(region, window_) {
  const mask = new Float32Array(window_.width * window_.height)
  const regionMaskWidth = region.maskWidth || region.width
  const regionMaskHeight = region.maskHeight || region.height
  for (let y = 0; y < regionMaskHeight; y++) {
    const windowY = region.y + y - window_.y
    if (windowY < 0 || windowY >= window_.height) continue
    for (let x = 0; x < regionMaskWidth; x++) {
      const windowX = region.x + x - window_.x
      if (windowX < 0 || windowX >= window_.width) continue
      const value = region.mask ? region.mask[y * regionMaskWidth + x] : 255
      mask[windowY * window_.width + windowX] = value > 0 ? 1 : 0
    }
  }
  return mask
}

function regionWindow(region, width, height) {
  const context = Math.max(48, region.context || 64)
  const longEdge = Math.max(region.width, region.height)
  let side = Math.round(longEdge + context * 2)
  side = Math.max(32, Math.min(side, Math.min(width, height)))
  const centerX = region.x + region.width / 2
  const centerY = region.y + region.height / 2
  const x = Math.max(0, Math.min(Math.round(centerX - side / 2), width - side))
  const y = Math.max(0, Math.min(Math.round(centerY - side / 2), height - side))
  return { x, y, width: side, height: side }
}

function buildInputs(sourceCanvas, window_, maskInWindow) {
  const work = document.createElement('canvas')
  work.width = work.height = MODEL_SIZE
  const context = work.getContext('2d', { willReadFrequently: true })
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(sourceCanvas, window_.x, window_.y, window_.width, window_.height, 0, 0, MODEL_SIZE, MODEL_SIZE)
  const pixels = context.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data
  const plane = MODEL_SIZE * MODEL_SIZE
  const image = new Float32Array(plane * 3)
  for (let index = 0; index < plane; index++) {
    image[index] = pixels[index * 4] / 255
    image[plane + index] = pixels[index * 4 + 1] / 255
    image[plane * 2 + index] = pixels[index * 4 + 2] / 255
  }
  const mask = new Float32Array(plane)
  const scaleX = window_.width / MODEL_SIZE
  const scaleY = window_.height / MODEL_SIZE
  for (let y = 0; y < MODEL_SIZE; y++) {
    const sourceY = Math.min(window_.height - 1, Math.floor((y + 0.5) * scaleY))
    for (let x = 0; x < MODEL_SIZE; x++) {
      const sourceX = Math.min(window_.width - 1, Math.floor((x + 0.5) * scaleX))
      if (maskInWindow[sourceY * window_.width + sourceX]) mask[y * MODEL_SIZE + x] = 1
    }
  }
  return { image, mask }
}

function createFeeds(session, model, image, mask) {
  if (model.inputLayout === 'masked-rgb-mask') {
    const plane = MODEL_SIZE * MODEL_SIZE
    const combined = new Float32Array(plane * 4)
    for (let channel = 0; channel < 3; channel++) {
      for (let index = 0; index < plane; index++) combined[channel * plane + index] = image[channel * plane + index] * (1 - mask[index])
    }
    combined.set(mask, plane * 3)
    const tensor = new ort.Tensor('float32', combined, [1, 4, MODEL_SIZE, MODEL_SIZE])
    return { feeds: { [session.inputNames[0]]: tensor }, tensors: [tensor] }
  }
  const imageTensor = new ort.Tensor('float32', image, [1, 3, MODEL_SIZE, MODEL_SIZE])
  const maskTensor = new ort.Tensor('float32', mask, [1, 1, MODEL_SIZE, MODEL_SIZE])
  return { feeds: { [session.inputNames[0]]: imageTensor, [session.inputNames[1]]: maskTensor }, tensors: [imageTensor, maskTensor] }
}

function compositeRegion(target, output, window_, maskInWindow) {
  const patch = document.createElement('canvas')
  patch.width = patch.height = MODEL_SIZE
  const patchContext = patch.getContext('2d')
  const image = patchContext.createImageData(MODEL_SIZE, MODEL_SIZE)
  const plane = MODEL_SIZE * MODEL_SIZE
  let maxValue = -Infinity
  for (let index = 0; index < output.length; index++) maxValue = Math.max(maxValue, output[index])
  const outputScale = maxValue <= 1.5 ? 255 : 1
  for (let index = 0; index < plane; index++) {
    image.data[index * 4] = Math.max(0, Math.min(255, Math.round(output[index] * outputScale)))
    image.data[index * 4 + 1] = Math.max(0, Math.min(255, Math.round(output[plane + index] * outputScale)))
    image.data[index * 4 + 2] = Math.max(0, Math.min(255, Math.round(output[plane * 2 + index] * outputScale)))
    image.data[index * 4 + 3] = 255
  }
  patchContext.putImageData(image, 0, 0)

  const windowCanvas = document.createElement('canvas')
  windowCanvas.width = window_.width
  windowCanvas.height = window_.height
  const windowContext = windowCanvas.getContext('2d', { willReadFrequently: true })
  windowContext.drawImage(target, window_.x, window_.y, window_.width, window_.height, 0, 0, window_.width, window_.height)
  const sourcePixels = windowContext.getImageData(0, 0, window_.width, window_.height)

  const generated = document.createElement('canvas')
  generated.width = window_.width
  generated.height = window_.height
  const generatedContext = generated.getContext('2d', { willReadFrequently: true })
  generatedContext.imageSmoothingEnabled = true
  generatedContext.imageSmoothingQuality = 'high'
  generatedContext.drawImage(patch, 0, 0, window_.width, window_.height)
  const generatedPixels = generatedContext.getImageData(0, 0, window_.width, window_.height)

  const blurred = gaussianBlur(maskInWindow, window_.width, window_.height, 1.6)
  for (let index = 0; index < blurred.length; index++) {
    const alpha = Math.max(0, Math.min(1, blurred[index]))
    if (alpha <= 0.002) continue
    const offset = index * 4
    for (let channel = 0; channel < 3; channel++) {
      sourcePixels.data[offset + channel] = Math.round(
        generatedPixels.data[offset + channel] * alpha + sourcePixels.data[offset + channel] * (1 - alpha),
      )
    }
  }
  windowContext.putImageData(sourcePixels, 0, 0)
  target.getContext('2d').drawImage(windowCanvas, window_.x, window_.y)
}

function canvasBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('导出失败')), type, quality))
}

/** 与 App 的 save_image 一致：JPG 源按高质量 JPEG 输出，其余保持 PNG */
function outputFormat(item) {
  const ext = (String(item.name).match(/\.[^.]+$/) || [''])[0].toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return { mime: 'image/jpeg', quality: 0.95, ext: '.jpg' }
  return { mime: 'image/png', quality: undefined, ext: '.png' }
}

function makeThumbnail(canvas) {
  const width = 132
  const height = Math.max(1, Math.round(canvas.height * (width / canvas.width)))
  const thumb = document.createElement('canvas')
  thumb.width = width
  thumb.height = height
  thumb.getContext('2d').drawImage(canvas, 0, 0, width, height)
  return canvasBlob(thumb, 'image/jpeg')
}

/* ---------------- 队列 ---------------- */

function revokeItem(item) {
  if (item.url) { URL.revokeObjectURL(item.url); item.url = null }
  if (item.thumbUrl) { URL.revokeObjectURL(item.thumbUrl); item.thumbUrl = null }
}

function itemStateText(item) {
  if (item.status === 'pending') return '等待处理'
  if (item.status === 'running') return item.progressText || '处理中'
  if (item.status === 'done') return `已去除 · ${item.provider || ''} · ${item.regions || 1} 处 · ${item.elapsed || ''}`
  if (item.status === 'unchanged') return '未识别水印 · 保持原图'
  return `失败：${item.error || '未知原因'}`
}

function renderQueue() {
  elements.queueCard.hidden = state.items.length === 0
  const done = state.items.filter(item => item.status === 'done')
  const unchanged = state.items.filter(item => item.status === 'unchanged')
  const failed = state.items.filter(item => item.status === 'failed')
  const pending = state.items.filter(item => item.status === 'pending')
  const stale = state.items.filter(item => item.modelId && item.modelId !== selectedModel().id && item.status !== 'pending')
  elements.queueSummary.textContent = state.items.length
    ? `共 ${state.items.length} 张 · 已完成 ${done.length} · 未识别 ${unchanged.length} · 待处理 ${pending.length + stale.length}${failed.length ? ` · 失败 ${failed.length}` : ''}`
    : ''

  elements.queue.replaceChildren(...state.items.map(item => {
    const li = document.createElement('li')
    li.className = item.status === 'running' ? 'current' : item.status === 'done' ? 'done' : item.status === 'failed' ? 'failed' : ''
    if (item.id === state.currentId) li.classList.add('current')

    const thumb = document.createElement('img')
    thumb.alt = item.name
    if (item.thumbUrl) thumb.src = item.thumbUrl

    const info = document.createElement('div')
    const name = document.createElement('div')
    name.className = 'q-name'
    name.textContent = item.name
    const sub = document.createElement('div')
    sub.className = 'q-state'
    sub.textContent = itemStateText(item)
    sub.style.color = item.status === 'failed' ? '#ef9a9a' : item.status === 'done' ? '#8fe0bd' : '#99a6bb'
    info.append(name, sub)

    const actions = document.createElement('div')
    actions.className = 'q-actions'
    if (item.url) {
      // 单张「存图」：iOS 上走系统分享面板才能存进相册
      const save = document.createElement('button')
      save.type = 'button'
      save.className = 'secondary'
      save.textContent = '存图'
      save.addEventListener('click', (event) => {
        event.stopPropagation()
        void saveToAlbum([item])
      })
      actions.append(save)
      if (!canShareFiles()) {
        const link = document.createElement('a')
        link.className = 'secondary link-button'
        link.href = item.url
        link.download = outputName(item)
        link.textContent = '下载'
        link.addEventListener('click', (event) => event.stopPropagation())
        actions.append(link)
      }
    }

    li.addEventListener('click', () => { void showItem(item.id) })
    li.append(thumb, info, actions)
    return li
  }))

  const ready = albumTargets()
  elements.saveAlbum.hidden = ready.length === 0 || !canShareFiles()
  elements.saveAlbum.textContent = ready.length ? `存入相册（${ready.length} 张）` : '存入相册'
  elements.saveAll.hidden = ready.length === 0
  elements.saveAll.textContent = `打包下载（ZIP · ${ready.length} 张）`
  elements.clear.hidden = state.items.length === 0
  elements.runBatch.disabled = state.running || !state.items.some(item => needsProcessing(item))
}

function needsProcessing(item) {
  if (item.status === 'pending' || item.status === 'running' || item.status === 'failed') return true
  return item.modelId !== selectedModel().id
}

function outputName(item) {
  const stem = item.name.replace(/\.[^.]+$/, '')
  const ext = item.outputExt || outputFormat(item).ext
  return item.status === 'done' ? `去水印-${stem}${ext}` : `原图-${stem}${ext}`
}

/* ---------------- 预览 ---------------- */

async function showItem(id) {
  const item = state.items.find(entry => entry.id === id)
  if (!item || state.running) return
  state.currentId = id
  setStatus(`正在显示 ${item.name}`, null)
  try {
    const bitmap = await decodeFile(item.file)
    item.width = bitmap.width
    item.height = bitmap.height
    drawBitmap(elements.source, bitmap)
    bitmap.close?.()
    elements.result.width = item.width
    elements.result.height = item.height
    const resultContext = elements.result.getContext('2d')
    if (item.blob) {
      const resultBitmap = await createImageBitmap(item.blob)
      resultContext.drawImage(resultBitmap, 0, 0)
      resultBitmap.close?.()
    } else {
      resultContext.clearRect(0, 0, item.width, item.height)
    }
    setStatus(`${item.name} · ${itemStateText(item)}`, 0, '点「只处理当前这张」可单独重跑')
    setMetrics({
      ...baseMetrics(),
      识别结果: item.provider || (item.status === 'pending' ? '未处理' : '未识别'),
      区域数: String(item.regions || 0),
      本次推理: item.elapsed || '-',
    })
    renderQueue()
  } catch (error) {
    setStatus(`图片读取失败：${error.message}`, 0)
  }
}

/* ---------------- 单张处理 ---------------- */

async function processItem(item) {
  const model = selectedModel()
  const totalStarted = performance.now()
  item.status = 'running'
  item.error = null
  item.progressText = '正在读取图片'
  renderQueue()
  setStatus(`正在读取 ${item.name}`, null)

  const bitmap = await decodeFile(item.file)
  item.width = bitmap.width
  item.height = bitmap.height
  drawBitmap(elements.source, bitmap)
  bitmap.close?.()
  elements.result.width = item.width
  elements.result.height = item.height
  const targetContext = elements.result.getContext('2d')
  targetContext.drawImage(elements.source, 0, 0)

  item.progressText = '正在识别水印'
  renderQueue()
  const detected = await detectRegions(elements.source)
  item.regions = detected.length
  item.provider = detected.length ? [...new Set(detected.map(region => region.provider))].join('、') : ''

  let inferMs = 0
  if (!detected.length) {
    item.status = 'unchanged'
  } else {
    item.progressText = '正在准备模型'
    renderQueue()
    const { session, loadMs, reused } = await getSession(model)
    state.lastModelLoadedMs = reused ? 0 : loadMs
    const regions = detected.map(region => expandRepairPadding(region, item.width, item.height))
    for (let index = 0; index < regions.length; index++) {
      const region = regions[index]
      item.progressText = `正在修复 ${index + 1}/${regions.length} · ${region.provider}`
      renderQueue()
      setStatus(`${item.name} · 第 ${index + 1}/${regions.length} 处 · ${region.provider}`, null, '页面短暂无响应属于正常现象')
      await yieldToUi()
      const window_ = regionWindow(region, item.width, item.height)
      const maskInWindow = regionMaskInWindow(region, window_)
      const { image, mask } = buildInputs(targetContext.canvas, window_, maskInWindow)
      const { feeds, tensors } = createFeeds(session, model, image, mask)
      const started = performance.now()
      const result = await Promise.race([
        session.run(feeds),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('本张推理超过 120 秒未返回，通常是手机内存不足')),
          INFER_TIMEOUT_MS,
        )),
      ])
      inferMs += performance.now() - started
      const outputTensor = result[session.outputNames[0]]
      compositeRegion(targetContext.canvas, outputTensor.data, window_, maskInWindow)
      tensors.forEach(tensor => tensor.dispose?.())
      outputTensor.dispose?.()
    }
    item.status = 'done'
  }

  const format = outputFormat(item)
  const blob = await canvasBlob(elements.result, format.mime, format.quality)
  revokeItem(item)
  item.blob = blob
  item.url = URL.createObjectURL(blob)
  const thumb = await makeThumbnail(elements.result)
  item.thumbUrl = URL.createObjectURL(thumb)
  item.outputExt = format.ext
  item.modelId = model.id
  item.elapsed = `${((performance.now() - totalStarted) / 1000).toFixed(1)} 秒`
  item.inferSeconds = (inferMs / 1000).toFixed(1)
  item.metrics = {
    ...baseMetrics(),
    识别结果: item.provider || '未识别',
    区域数: String(item.regions || 0),
    本次推理: inferMs ? `${item.inferSeconds} 秒` : '-',
    总耗时: item.elapsed,
  }
  state.currentId = item.id
  renderQueue()
  return item
}

/* ---------------- 批量处理 ---------------- */

async function runBatch(items) {
  if (state.running || !items.length) return
  state.running = true
  state.stopRequested = false
  elements.stop.hidden = false
  renderQueue()
  const started = performance.now()
  let index = 0
  let failed = 0
  try {
    for (const item of items) {
      if (state.stopRequested) break
      index++
      const fraction = (index - 1) / items.length
      setStatus(`第 ${index}/${items.length} 张 · ${item.name}`, fraction, '逐张处理中，请保持 Safari 在前台')
      try {
        await processItem(item)
        item.progressText = ''
      } catch (error) {
        console.error(error)
        item.status = 'failed'
        item.error = friendlyError(item, error)
        failed++
        if (/120 秒|内存不足|推理超时/.test(item.error)) await releaseActiveSession()
      }
      renderQueue()
      setMetrics(item.metrics || baseMetrics())
      setStatus(
        `第 ${index}/${items.length} 张 · ${item.status === 'failed' ? '失败' : item.status === 'unchanged' ? '未识别' : '已完成'}`,
        index / items.length,
        item.status === 'failed' ? item.error : item.name,
      )
      // 让出主线程，避免长时间占用
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  } finally {
    state.running = false
    elements.stop.hidden = true
    const done = state.items.filter(entry => entry.status === 'done').length
    const unchanged = state.items.filter(entry => entry.status === 'unchanged').length
    const totalSeconds = ((performance.now() - started) / 1000).toFixed(1)
    setStatus(
      state.stopRequested ? '已停止' : '批量处理完成',
      1,
      `完成 ${done} · 未识别 ${unchanged}${failed ? ` · 失败 ${failed}` : ''} · 用时 ${totalSeconds} 秒`,
    )
    renderQueue()
  }
}

/** 已处理 + 未识别（保持原图）都算「有结果」，保证一张都不少 */
function albumTargets() {
  return state.items.filter(item => (item.status === 'done' || item.status === 'unchanged') && item.blob && item.url)
}

/** 探测一次：浏览器能否分享文件（iOS Safari 可以，桌面 Chrome 视平台而定） */
let shareFilesSupport = null
function canShareFiles() {
  if (shareFilesSupport !== null) return shareFilesSupport
  try {
    const probe = new File([new Uint8Array([137, 80, 78, 71])], 'probe.png', { type: 'image/png' })
    shareFilesSupport = !!(navigator.canShare && navigator.canShare({ files: [probe] }))
  } catch { shareFilesSupport = false }
  return shareFilesSupport
}

/** 存入相册：iOS 只有系统分享面板能把图片写进「照片」，分享面板里选「存储图像」 */
async function saveToAlbum(items) {
  const targets = items.filter(item => item.blob)
  if (!targets.length) return
  const files = targets.map(item => new File([item.blob], outputName(item), { type: outputFormat(item).mime }))
  if (!canShareFiles()) {
    const link = document.createElement('a')
    link.href = targets[0].url
    link.download = outputName(targets[0])
    link.click()
    setStatus('当前浏览器不支持直接分享文件', 1, '已改为下载第一张，其余可在列表里逐张保存')
    return
  }
  setStatus(`正在打开分享面板（${files.length} 张）`, null, '在面板里选「存储图像」即可存进相册')
  try {
    await navigator.share({ files, title: 'LaMa 去水印结果' })
    setStatus('已交给系统保存', 1, `${files.length} 张`)
  } catch (error) {
    if (error.name !== 'AbortError') setStatus(`保存失败：${error.message}`, 1)
    else setStatus('已取消', 0)
  }
}

async function saveAll() {
  const finished = albumTargets()
  if (!finished.length) return
  setStatus('正在打包 ZIP', null, '图片较多时需要一点时间')
  await new Promise(resolve => setTimeout(resolve, 0))
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
  const zip = await buildZip(zipEntries(finished))
  const url = URL.createObjectURL(zip)
  const link = document.createElement('a')
  link.href = url
  link.download = `去水印-${stamp}.zip`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
  setStatus('ZIP 已生成', 1, `${finished.length} 张 · ${(zip.size / 1048576).toFixed(1)} MB`)
}

function zipEntries(finished) {
  return finished.map((item, index) => {
    const stem = item.name.replace(/\.[^.]+$/, '')
    const ext = item.outputExt || outputFormat(item).ext
    const prefix = item.status === 'done' ? '去水印' : '原图'
    return {
      name: `${prefix}-${String(index + 1).padStart(3, '0')}-${stem}${ext}`,
      blob: item.blob,
    }
  })
}

/* ---------------- 文件选择与缓存 ---------------- */

function openImageDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('浏览器不支持 IndexedDB'))
    const request = indexedDB.open(IMAGE_DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IMAGE_STORE)) request.result.createObjectStore(IMAGE_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('无法打开图片缓存'))
  })
}

async function saveSelectedFiles(files) {
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (files.length > RESTORE_LIMIT_COUNT || total > RESTORE_LIMIT_BYTES) return false
  const database = await openImageDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(IMAGE_STORE, 'readwrite')
      transaction.objectStore(IMAGE_STORE).put({
        id: 'batch',
        savedAt: Date.now(),
        files: files.map(file => ({ name: file.name, type: file.type, lastModified: file.lastModified, blob: file })),
      })
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error || new Error('图片缓存失败'))
      transaction.onabort = () => reject(transaction.error || new Error('图片缓存中止'))
    })
    return true
  } finally { database.close() }
}

async function readSelectedFiles() {
  const database = await openImageDatabase()
  try {
    const record = await new Promise((resolve, reject) => {
      const transaction = database.transaction(IMAGE_STORE, 'readonly')
      const request = transaction.objectStore(IMAGE_STORE).get('batch')
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error || new Error('图片恢复失败'))
    })
    if (!record?.files?.length) return []
    return record.files.map(entry => new File([entry.blob], entry.name, {
      type: entry.type || entry.blob.type,
      lastModified: entry.lastModified || Date.now(),
    }))
  } finally { database.close() }
}

/** 删除持久化的图片列表（清空列表、恢复失败时调用），否则下次打开会再次恢复 */
async function deleteStoredFiles() {
  try {
    const database = await openImageDatabase()
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(IMAGE_STORE, 'readwrite')
      transaction.objectStore(IMAGE_STORE).delete('batch')
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error || new Error('清除图片缓存失败'))
      transaction.onabort = () => reject(transaction.error || new Error('清除图片缓存中止'))
    })
    database.close()
  } catch (error) { console.warn('清除图片缓存失败', error) }
}

async function addFiles(files, { restored = false } = {}) {
  const accepted = files.filter(file => file && file.size > 0)
  if (!accepted.length) return
  for (const file of accepted) {
    const item = { id: state.nextId++, file, name: file.name, restored, status: 'pending', thumbUrl: null, url: null, blob: null }
    state.items.push(item)
  }
  const latest = state.items[state.items.length - 1]
  elements.selectedName.hidden = false
  elements.selectedName.textContent = `已选择 ${accepted.length} 张，列表共 ${state.items.length} 张`
  // 选完图立即在后台准备所选模型（下载/读缓存/校验），
  // 进度显示在第一屏的下载条里；点「开始批量处理」时模型已就绪
  void warmUpModel()
  try {
    const persisted = await saveSelectedFiles(state.items.map(item => item.file))
    if (!persisted) console.info('图片较多，未启用自动恢复缓存')
  } catch (error) { console.warn('无法缓存所选图片', error) }
  await showItem(latest.id)
  renderQueue()
}

/** 预热当前选中的模型：未缓存就开始下载（进度在顶部下载条），已缓存则直接建会话 */
let warmUpStartedFor = null
function warmUpModel() {
  const model = selectedModel()
  if (state.running || warmUpStartedFor === model.id) return
  warmUpStartedFor = model.id
  getSession(model)
    .then(() => {
      if (warmUpStartedFor === model.id) warmUpStartedFor = null
      void refreshCacheTags()
    })
    .catch(error => {
      if (warmUpStartedFor === model.id) warmUpStartedFor = null
      console.warn('模型预热失败（点「开始批量处理」会重试）', error)
    })
}

/* ---------------- 事件 ---------------- */

// label 唤起在个别 iOS 版本上不稳定：点击选择卡时由 JS 主动触发文件框
elements.picker?.addEventListener('click', () => { elements.file.click() })

elements.file.addEventListener('change', async () => {
  await addFiles([...(elements.file.files || [])])
})

elements.modelInputs.forEach(input => input.addEventListener('change', () => {
  setStatus('模型已切换', 0, '再次「开始批量处理」会用新模型重跑')
  setMetrics(baseMetrics())
  renderQueue()
  void refreshCacheTags()
  if (state.items.length) void warmUpModel() // 已选图时切模型，立刻预热新模型
}))

elements.runBatch.addEventListener('click', () => {
  const targets = state.items.filter(item => needsProcessing(item))
  void runBatch(targets)
})

elements.saveAlbum.addEventListener('click', () => { void saveToAlbum(albumTargets()) })

elements.stop.addEventListener('click', () => {
  state.stopRequested = true
  setStatus('正在停止…', null, '当前这张处理完就会停下')
})

elements.saveAll.addEventListener('click', () => { void saveAll() })

elements.clear.addEventListener('click', () => {
  if (state.running) return
  state.items.forEach(revokeItem)
  state.items = []
  state.currentId = null
  elements.file.value = ''
  elements.selectedName.hidden = true
  elements.source.width = elements.source.height = 0
  elements.result.width = elements.result.height = 0
  void deleteStoredFiles() // 清空列表同时清掉持久化缓存，否则下次打开还会恢复
  setStatus('等待选择图片', 0)
  setMetrics({ 模型: selectedModel().label, 线程: String(ort.env.wasm.numThreads) })
  renderQueue()
})

async function restoreSelectedFiles() {
  try {
    const files = await readSelectedFiles()
    if (!files.length) return
    // 上次缓存的文件可能已被系统清理成空壳：先试解码第一张，坏掉就整体丢弃，
    // 免得列表里全是「解码失败」的死条目。
    const probe = files[0]
    if (!probe.size) throw new Error('缓存文件为空')
    try {
      const bitmap = await decodeFile(probe)
      bitmap.close?.()
    } catch {
      throw new Error('缓存文件已损坏')
    }
    await addFiles(files, { restored: true })
    setStatus(`已恢复上次的 ${files.length} 张图片`, 0, '点「开始批量处理」继续')
  } catch (error) {
    console.warn('无法恢复上次图片', error)
    await deleteStoredFiles()
    setStatus('上次的图片缓存已失效，请重新选择图片', 0, '浏览器清理过本地数据，这是正常的')
  }
}

setMetrics({ 模型: selectedModel().label, 线程: String(ort.env.wasm.numThreads) })
// 尽量申请持久化存储：Safari 对「未加入主屏幕」的站点最多保留 7 天
void navigator.storage?.persist?.().catch(() => {})
void refreshCacheTags()
void getRuleEngine().catch(error => console.warn('规则引擎初始化失败', error))
void restoreSelectedFiles()
