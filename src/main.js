import './style.css'
import { createRuleEngine } from './rules.js'
import { gaussianBlur, grayFromRgb, grayFromRgb8 } from './imaging.js'
import { processGemini } from './gemini.js'
import { chooseThreadCount } from './thread-policy.js'
import { isOutOfMemory, runWithOomFallback } from './oom-retry.js'
import { buildZip } from './zip.js'
import { InferenceController } from './inference-controller.js'
import {
  StorageCapacityError,
  batchLimitReason,
  clearStoredJob,
  deleteResult,
  loadBatch,
  loadResult,
  saveBatch,
  saveResult,
} from './job-store.js'

const APP_VERSION = __APP_VERSION__
// 部署新版后自动刷新一次：比对 dist/version.json 与本次构建注入的版本号。
// 刷新只影响页面本身，Cache Storage 里的模型缓存原样保留。
void (async () => {
  try {
    const response = await fetch(new URL('version.json', document.baseURI), { cache: 'no-store' })
    if (!response.ok) return
    const { version } = await response.json()
    if (!version || version === APP_VERSION) return
    const url = new URL(location.href)
    if (url.searchParams.get('app-build') === version) return
    url.searchParams.set('app-build', version)
    location.replace(url.href)
  } catch { /* 网络不可用时保持现状 */ }
})()

const MODEL_SIZE = 512
const INFER_TIMEOUT_MS = 120000
const SESSION_INIT_TIMEOUT_MS = 120000
const MODEL_CACHE_NAME = 'lama-model-v2'
const CHUNK_RETRIES = 4
// 模型保留在本仓库，以原 Pages 地址提供同源兜底；jsDelivr 固定提交镜像与
// Hugging Face 固定 revision 负责跨线路备用，完整拼装后统一校验 SHA-256。
const STABLE_MODEL_BASE = 'https://kunlun7210.github.io/lama-watermark-web/'
const MIRROR_REPO = 'kunlun7210/lama-watermark-web@b7cb12e5a1b74a2cf66372f90375683e567035a3'
const MODELS = {
  int8: {
    id: 'int8',
    label: 'INT8 · 62MB',
    manifest: 'models/int8/manifest.json',
    inputLayout: 'masked-rgb-mask',
    sha256: 'cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe',
    hf: 'https://huggingface.co/g-ronimo/lama/resolve/418036c6b541e526cdbb0bead1ec3a87dabede53/lama_512_int8.onnx',
  },
  fp32: {
    id: 'fp32',
    label: 'FP32 模型 · 198MB',
    manifest: 'models/fp32/manifest.json',
    inputLayout: 'image-mask',
    sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6',
    hf: 'https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx',
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
  previewGrid: document.querySelector('#preview-grid'),
  status: document.querySelector('#status'),
  appVersion: document.querySelector('#app-version'),
  progress: document.querySelector('#progress'),
  progressLabel: document.querySelector('#progress-label'),
  metrics: document.querySelector('#metrics'),
  queueCard: document.querySelector('#queue-card'),
  queue: document.querySelector('#queue'),
  queueSummary: document.querySelector('#queue-summary'),
  picker: document.querySelector('.picker'),
  cacheTags: { int8: document.querySelector('#cache-tag-int8'), fp32: document.querySelector('#cache-tag-fp32') },
  currentModelLabel: document.querySelector('#current-model-label'),
  cacheTagCurrent: document.querySelector('#cache-tag-current'),
  modelInputs: [...document.querySelectorAll('input[name="model"]')],
  downloadBar: document.querySelector('#download-bar'),
  downloadStatus: document.querySelector('#download-status'),
  downloadLabel: document.querySelector('#download-label'),
  downloadProgress: document.querySelector('#download-progress'),
  batchHint: document.querySelector('#batch-hint'),
}

const state = {
  items: [],
  currentId: null,
  running: false,
  stopRequested: false,
  lastModelLoadedMs: 0,
}

const inference = new InferenceController()
let activeModelId = null
let sessionPromise = null
let sessionModelId = null
/** 正在进行的模型加载的中断器：换模型时用它取消旧任务（未下载完的段不再继续） */
let sessionAbort = null
/** 加载代次：只有最新一代允许写回当前 Worker，防止旧任务覆盖新会话 */
let sessionGeneration = 0
let ruleEngine = null
let ruleEnginePromise = null

const assetBase = new URL(import.meta.env.BASE_URL, location.href)
const ortBase = new URL('ort/', assetBase).href

// 沿用原 lama-watermark-web 的键，升级到 v1.0.0 后继续识别既有缓存与恢复偏好。
const LEGACY_THREAD_PREF_KEY = 'lama-threads'
const RESTORE_PREF_KEY = 'lama-restore'
const TIMING_KEY_PREFIX = 'lama-seconds-'

// 旧版会把一次偶发 OOM 永久写进 localStorage，导致设备以后一直停在 1/2 线程。
// Worker 现在可以当场重建，永久偏好已无必要；启动时清掉历史遗留值。
try { localStorage.removeItem(LEGACY_THREAD_PREF_KEY) } catch { /* 忽略 */ }

/** 仅在当前页面生命周期内生效；刷新或重新打开后自动重新评估设备能力。 */
let runtimeThreadCap = 0
function preferredThreads() {
  return chooseThreadCount(crossOriginIsolated, navigator.hardwareConcurrency, runtimeThreadCap)
}

let currentThreads = preferredThreads()

const selectedModel = () => MODELS[elements.modelInputs.find(input => input.checked)?.value || 'int8']
const currentItem = () => state.items.find(item => item.id === state.currentId) || null

function timingSeconds(modelId) {
  const fallback = modelId === 'fp32' ? 40 : 16
  try {
    const value = Number(localStorage.getItem(`${TIMING_KEY_PREFIX}${modelId}`))
    return Number.isFinite(value) && value > 0 ? value : fallback
  } catch { return fallback }
}

function rememberTiming(modelId, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return
  const smoothed = timingSeconds(modelId) * 0.65 + seconds * 0.35
  try { localStorage.setItem(`${TIMING_KEY_PREFIX}${modelId}`, smoothed.toFixed(2)) } catch { /* 忽略 */ }
}

function updateBatchHint(count = state.items.filter(item => needsProcessing(item)).length) {
  if (!elements.batchHint || count <= 0) {
    if (elements.batchHint) elements.batchHint.hidden = true
    return
  }
  const seconds = Math.max(1, Math.round(timingSeconds(selectedModel().id) * count))
  const text = seconds >= 60 ? `约 ${Math.ceil(seconds / 60)} 分钟` : `约 ${seconds} 秒`
  elements.batchHint.textContent = `${count} 张预计 ${text}；请保持页面在前台，每完成一张会立即保存。`
  elements.batchHint.hidden = false
}
/* ↑↑↑ 预计时间：移植段结束（以下为本仓其它实现） */

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
  const entries = Object.entries(values)
  elements.metrics.replaceChildren(...entries.map(([label, value]) => {
    const box = document.createElement('div')
    const dt = document.createElement('dt')
    const dd = document.createElement('dd')
    dt.textContent = label
    dd.textContent = value
    box.append(dt, dd)
    return box
  }))
  elements.metrics.hidden = entries.length === 0
}

function updatePreviewVisibility() {
  if (!elements.previewGrid) return
  elements.previewGrid.dataset.empty = state.items.length ? 'false' : 'true'
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

function displayMetrics(item) {
  if (!item) return {}
  const metrics = {
    水印类型: item.provider || (item.status === 'pending' ? '未处理' : '未识别'),
  }
  if (item.elapsed) metrics.总耗时 = item.elapsed
  return metrics
}

function logThreadCount(reason = '') {
  console.info(`推理线程：${currentThreads}${reason ? `（${reason}）` : ''}`)
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

function stableModelUrl(relativePath) {
  return new URL(relativePath.replace(/^\.?\//, ''), STABLE_MODEL_BASE).href
}

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

function preferredDownloadSource() {
  return new URLSearchParams(location.search).get('source')
}

/**
 * 默认顺序：jsDelivr → HuggingFace → 同源 Pages。
 * jsDelivr 对整段内容正确且快，但它返回的 Content-Range 总长度不可靠，因此只能从头整段下载，
 * 不允许段内续传。HF 与 Pages 仍执行严格 Range 校验。
 */
function chunkSources(relativePath, model, fileOffset, manifest) {
  const list = [
    { label: 'jsDelivr', url: mirrorUrl(relativePath), rangeOffset: 0, expectedTotal: null, noResume: true },
    { label: 'HuggingFace', url: model.hf, rangeOffset: fileOffset, expectedTotal: manifest.totalSize },
    { label: '同源 Pages', url: stableModelUrl(relativePath), rangeOffset: 0, expectedTotal: null },
  ].filter(source => !!source.url)
  const preferred = preferredDownloadSource()
  if (preferred === 'hf') {
    const hf = list.find(source => source.label === 'HuggingFace')
    if (hf) return orderSources([hf, ...list.filter(source => source !== hf)])
  }
  if (preferred === 'origin') list.reverse()
  return orderSources(list)
}

/** 记住本次会话里真正下得动的源，后面几段直接用它，不再逐段浪费重试 */
function orderSources(list) {
  if (!preferredSourceLabel) return list
  const hit = list.find(source => source.label === preferredSourceLabel)
  if (!hit || list[0] === hit) return list
  return [hit, ...list.filter(source => source !== hit)]
}

async function fetchManifest(model) {
  const sameOrigin = new URL(model.manifest, assetBase).href
  const mirror = mirrorUrl(model.manifest)
  const preferred = preferredDownloadSource()
  const order = preferred === 'origin' ? [sameOrigin, mirror] : [mirror, sameOrigin]
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
 * 单段下载：断线/超时后带退避重试，并从已下载位置续传。
 * 手机上网络抖动很常见，整段重来在 0.2MB/s 的链路上代价太大 —— 所以进度保留在重试循环之外。
 * 源分两类：镜像/同源的分段文件内偏移从 0 计；HuggingFace 是整文件，rangeOffset 为该段在整文件中的偏移。
 *
 * ⚠️ 续传只在**同一个源内部**成立，两条铁律：
 *  换源必须清零。不同源的 Range 参考系和中间缓存行为可能不同，绝不跨源拼接。
 */
async function downloadChunk(chunk, sources, onProgress, externalSignal) {
  let lastError = null
  let received = []
  let have = 0
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = sources[sourceIndex]
    const rangeOffset = source.rangeOffset || 0
    // 铁律 1：换源即从零开始，绝不跨源拼接
    have = 0
    received = []
    for (let attempt = 0; attempt < CHUNK_RETRIES; attempt++) {
      // 外部取消（用户切换模型）：立刻退出，既不重试也不换源
      if (externalSignal?.aborted) throw new Error('模型已切换，下载已取消')
      if (source.noResume) { have = 0; received = [] }
      const controller = new AbortController()
      // 把外部的取消信号接到本次请求上。不用 AbortSignal.any()：
      // 它要 Safari 17.4+，手写联动在各版本上都成立。
      const onExternalAbort = () => controller.abort()
      externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
      let idle
      const armIdle = () => {
        clearTimeout(idle)
        idle = setTimeout(() => controller.abort(), 45000)
      }
      try {
        armIdle()
        // 统一闭区间：镜像/同源 rangeOffset=0；HF 用整文件偏移，闭区间保证不会下过头
        const rangeStart = rangeOffset + have
        const rangeEnd = rangeOffset + chunk.size - 1
        const response = await fetch(source.url, {
          headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        const selfContainedFromStart = rangeOffset === 0 && have === 0
        if (response.status !== 206 && !(response.status === 200 && selfContainedFromStart)) {
          throw new Error(`该源不支持断点续传（HTTP ${response.status}）`)
        }
        if (!source.noResume) {
          const contentRange = response.headers.get('content-range') || ''
          const match = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i)
          if (response.status === 206 && (!match || Number(match[1]) !== rangeStart || Number(match[2]) !== rangeEnd)) {
            throw new Error(`Range 响应不匹配：${contentRange || '无 Content-Range'}`)
          }
          if (match && source.expectedTotal && match[3] !== '*' && Number(match[3]) !== source.expectedTotal) {
            throw new Error(`模型总长度不匹配：${match[3]}/${source.expectedTotal}`)
          }
        }
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
        return { bytes, source }
      } catch (error) {
        clearTimeout(idle)
        // 被外部取消（切换模型）：不要当网络失败去重试、更不要换下一个源
        if (externalSignal?.aborted) throw new Error('模型已切换，下载已取消')
        lastError = error.name === 'AbortError' ? new Error('网络空闲超过 45 秒') : error
        console.info(`第 ${attempt + 1} 次尝试失败（已收到 ${(have / 1048576).toFixed(1)}MB，下次从该位置续传）：${lastError.message}`)
        if (have >= chunk.size) break
        await new Promise(resolve => setTimeout(resolve, Math.min(8000, 800 * (attempt + 1))))
      } finally {
        externalSignal?.removeEventListener('abort', onExternalAbort)
      }
    }
    if (sourceIndex + 1 < sources.length) {
      console.info(`换用备用源：${sources[sourceIndex + 1].label}（本段从头重下，不跨源拼接）`)
    }
  }
  throw lastError || new Error('模型分段下载失败')
}

async function fetchModel(model, signal) {
  try {
    const manifest = await fetchManifest(model)
    if (!Number.isSafeInteger(manifest.totalSize) || !Array.isArray(manifest.chunks)) throw new Error('模型清单格式错误')

    const cache = await openModelCache()
    const bytes = new Uint8Array(manifest.totalSize)
    let loaded = 0
    let cachedCount = 0
    let currentSource = ''
    let switchedSource = false

    for (let index = 0; index < manifest.chunks.length; index++) {
      // 每段开始前检查一次：被取消后不要再继续读缓存/下载别的段
      if (signal?.aborted) throw new Error('模型已切换，下载已取消')
      const chunk = manifest.chunks[index]
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

      const sources = chunkSources(relativePath, model, loaded, manifest)
      const started = performance.now()
      const chunkBytes = await downloadChunk(chunk, sources, (have, size, label) => {
        currentSource = label
        const text = '正在下载 LaMa 模型'
        const ratio = (loaded + have) / manifest.totalSize
        const detail = progressDetail(loaded + have, manifest.totalSize, index + 1, manifest.chunks.length, started, label)
        setDownloadBar(true, text, ratio, detail)
      }, signal)
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

/**
 * 只清掉指定型号的缓存。
 * 旧实现形参写了 model 却完全没用它，直接 caches.delete(整个库) ——
 * 后果是 INT8 校验失败会把已经下好的 FP32 一起删掉（反之亦然），
 * 用户只是换了个模型试，却要重新下载两百多兆。
 * 缓存键本身带模型目录（models/int8/…），据此只删该型号下的分段即可。
 * 不传 model 时保留整库清空的能力，排障时仍可用。
 */
async function clearModelCache(model) {
  if (typeof caches === 'undefined') return
  try {
    if (!model?.manifest) { await caches.delete(MODEL_CACHE_NAME); return }
    const manifest = String(model.manifest)
    const slash = manifest.lastIndexOf('/')
    const prefix = chunkCacheKey(slash >= 0 ? manifest.slice(0, slash + 1) : '')
    const cache = await caches.open(MODEL_CACHE_NAME)
    const keys = await cache.keys()
    // 只删该型号目录下的分段；清单走 fetch 不落 Cache，所以不会误删别的型号
    await Promise.all(
      keys.filter(request => request.url.startsWith(prefix)).map(request => cache.delete(request)),
    )
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
  const selected = selectedModel()
  await Promise.all(Object.values(MODELS).map(async model => {
    const tag = elements.cacheTags[model.id]
    if (!tag) return
    const status = await modelCacheStatus(model)
    let text = ''
    let className = 'model-cache-tag'
    if (!status.supported) {
      tag.hidden = true
    } else if (status.have === status.total) {
      tag.hidden = false
      text = '已缓存'
      className = 'model-cache-tag cached'
    } else if (status.have === 0) {
      tag.hidden = false
      text = '未缓存'
      className = 'model-cache-tag missing'
    } else {
      tag.hidden = false
      text = `${status.have}/${status.total} 段`
      className = 'model-cache-tag partial'
    }
    if (!tag.hidden) {
      tag.textContent = text
      tag.className = className
    }
    if (model.id === selected.id && elements.cacheTagCurrent) {
      elements.cacheTagCurrent.hidden = tag.hidden
      if (!tag.hidden) {
        elements.cacheTagCurrent.textContent = text
        elements.cacheTagCurrent.className = className
      }
    }
  }))
  if (elements.currentModelLabel) elements.currentModelLabel.textContent = selected.label
}

async function releaseActiveSession() {
  inference.terminate(new Error('推理会话已重建'))
  activeModelId = null
}

function getSession(model) {
  if (activeModelId === model.id && inference.worker) return Promise.resolve({ model, loadMs: 0, reused: true })
  if (sessionPromise && sessionModelId === model.id) return sessionPromise

  // Worker 是会话的生命周期边界：换模型、超时或 OOM 时直接 terminate，
  // 既停止正在初始化/推理的 ORT，也释放整套 WASM 内存与线程池。
  sessionAbort?.abort()
  inference.terminate(new Error('模型已切换，旧推理已终止'))
  activeModelId = null
  const controller = new AbortController()
  sessionAbort = controller
  const generation = ++sessionGeneration

  sessionModelId = model.id
  sessionPromise = (async () => {
    await releaseActiveSession()
    const started = performance.now()
    const bytes = await fetchModel(model, controller.signal)
    if (generation !== sessionGeneration) throw new Error('模型已切换，本次加载作废')
    setStatus(`正在初始化 ${model.label}`, null, '请保持 Safari 在前台')
    currentThreads = preferredThreads()
    await inference.initialise({
      model,
      modelBytes: bytes,
      threads: currentThreads,
      ortBase,
      timeoutMs: SESSION_INIT_TIMEOUT_MS,
    })
    if (generation !== sessionGeneration) throw new Error('模型已切换，本次加载作废')
    activeModelId = model.id
    logThreadCount()
    return { model, loadMs: performance.now() - started, reused: false }
  })().catch(error => {
    // 只有最新一代失败才清空，否则会把后来者的状态一起清掉
    if (generation === sessionGeneration) sessionModelId = null
    throw error
  }).finally(() => {
    if (generation === sessionGeneration) { sessionPromise = null; sessionAbort = null }
  })
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

/** 识别水印：Gemini 保留专用还原结果，其余平台返回 LaMa 待修复区域。 */
async function detectRegions(canvas) {
  const width = canvas.width
  const height = canvas.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const imageData = context.getImageData(0, 0, width, height)
  const rgba = imageData.data
  const gemini = processGemini(rgba, width, height)
  const gray = grayFromRgb(rgba, width, height)
  const gray8 = grayFromRgb8(rgba, width, height)
  const engine = await getRuleEngine()
  const regions = engine.detect({ rgba, gray, gray8, width, height })
  if (gemini.status === 'needs-inpaint') regions.push(gemini.region)
  return { regions, gemini }
}

function applyGeminiPatch(context, gemini) {
  if (gemini.status !== 'cleaned' || !gemini.patch) return
  const patch = context.createImageData(gemini.size, gemini.size)
  patch.data.set(gemini.patch)
  context.putImageData(patch, gemini.x, gemini.y)
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

function originalFormat(item) {
  const ext = (String(item.name).match(/\.[^.]+$/) || [''])[0].toLowerCase()
  if (ext) return { mime: item.file.type || 'application/octet-stream', ext }
  if (item.file.type === 'image/jpeg') return { mime: item.file.type, ext: '.jpg' }
  if (item.file.type === 'image/webp') return { mime: item.file.type, ext: '.webp' }
  if (item.file.type === 'image/heic') return { mime: item.file.type, ext: '.heic' }
  if (item.file.type === 'image/heif') return { mime: item.file.type, ext: '.heif' }
  return { mime: item.file.type || 'image/png', ext: '.png' }
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

function releasePersistedOutput(item) {
  if (item.url) URL.revokeObjectURL(item.url)
  item.url = null
  item.blob = null
}

function hasResult(item) {
  return (item.status === 'done' || item.status === 'unchanged') && !!(item.blob || item.persisted)
}

async function resultBlobFor(item) {
  if (item.blob) return item.blob
  if (item.persisted) {
    const record = await loadResult(item.id)
    if (record?.outputBlob) return record.outputBlob
  }
  throw new Error(`${item.name} 的结果已被浏览器清理，请重新处理`)
}

function itemStateText(item) {
  if (item.status === 'pending') return '等待处理'
  if (item.status === 'running') return item.progressText || '处理中'
  if (item.status === 'done') return `已去除 · ${item.provider || ''} · ${item.regions || 1} 处 · ${item.elapsed || ''}${item.persistError ? ' · 结果未落盘' : ''}`
  if (item.status === 'unchanged') return `未识别水印 · 保持原图${item.persistError ? ' · 结果未落盘' : ''}`
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
    if (hasResult(item)) {
      // 单张「存图」：iOS 上走系统分享面板才能存进相册
      const save = document.createElement('button')
      save.type = 'button'
      save.className = 'secondary'
      save.textContent = canShareFiles() ? '存图' : '下载'
      save.addEventListener('click', (event) => {
        event.stopPropagation()
        void saveToAlbum([item])
      })
      actions.append(save)
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
    if (hasResult(item)) {
      const resultBlob = await resultBlobFor(item)
      const resultBitmap = await createImageBitmap(resultBlob)
      resultContext.drawImage(resultBitmap, 0, 0)
      resultBitmap.close?.()
    } else {
      resultContext.clearRect(0, 0, item.width, item.height)
    }
    // 旧文案指向的是已经删掉的「只处理当前这张」按钮（点了没反应）。
    // 现在给的是真实存在的路径：待处理/失败的项，点「开始批量处理」会重跑。
    setStatus(
      `${item.name} · ${itemStateText(item)}`,
      0,
      item.status === 'pending' || item.status === 'failed' ? '点「开始批量处理」会重跑这张' : '',
    )
    setMetrics(displayMetrics(item))
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
  const geminiDirect = detected.gemini.status === 'cleaned'
  item.regions = detected.regions.length + (geminiDirect ? 1 : 0)
  const providers = detected.regions.map(region => region.provider)
  if (geminiDirect) providers.push('Gemini')
  item.provider = providers.length ? [...new Set(providers)].join('、') : ''

  let inferMs = 0
  if (!item.regions) {
    item.status = 'unchanged'
  } else {
    if (geminiDirect) {
      item.progressText = '正在还原 Gemini 水印'
      renderQueue()
      await yieldToUi()
      applyGeminiPatch(targetContext, detected.gemini)
      detected.gemini.patch = null
    }
    if (detected.regions.length) {
      item.progressText = '正在准备模型'
      renderQueue()
      const { loadMs, reused } = await getSession(model)
      state.lastModelLoadedMs = reused ? 0 : loadMs
      const regions = detected.regions.map(region => expandRepairPadding(region, item.width, item.height))
      for (let index = 0; index < regions.length; index++) {
        const region = regions[index]
        item.progressText = `正在修复 ${index + 1}/${regions.length} · ${region.provider}`
        renderQueue()
        setStatus(`${item.name} · 第 ${index + 1}/${regions.length} 处 · ${region.provider}`, null, '页面短暂无响应属于正常现象')
        await yieldToUi()
        const window_ = regionWindow(region, item.width, item.height)
        const maskInWindow = regionMaskInWindow(region, window_)
        const { image, mask } = buildInputs(targetContext.canvas, window_, maskInWindow)
        const started = performance.now()
        const output = await inference.run(image, mask, INFER_TIMEOUT_MS)
        inferMs += performance.now() - started
        compositeRegion(targetContext.canvas, output, window_, maskInWindow)
      }
    }
    item.status = 'done'
  }

  const format = item.status === 'unchanged' ? originalFormat(item) : outputFormat(item)
  // “未识别、保持原图”必须保持原始字节；重新走 canvas 会让 JPEG 再次有损压缩，
  // 也会丢掉元数据。缩略图仍从已解码画布生成，不影响下载内容。
  const blob = item.status === 'unchanged'
    ? item.file
    : await canvasBlob(elements.result, format.mime, format.quality)
  revokeItem(item)
  item.blob = blob
  item.url = URL.createObjectURL(blob)
  const thumb = await makeThumbnail(elements.result)
  item.thumbUrl = URL.createObjectURL(thumb)
  item.outputExt = format.ext
  item.modelId = model.id
  item.elapsed = `${((performance.now() - totalStarted) / 1000).toFixed(1)} 秒`
  item.inferSeconds = (inferMs / 1000).toFixed(1)
  item.metrics = displayMetrics(item)
  try {
    await saveResult(item)
    item.persisted = true
    item.persistError = null
    // IndexedDB 已经接管完整结果；内存里只留小缩略图和元数据。
    // 预览、分享和 ZIP 在用户真正需要时再按 id 读取 Blob。
    releasePersistedOutput(item)
  } catch (error) {
    item.persisted = false
    item.persistError = error instanceof StorageCapacityError
      ? error.message
      : `结果未能写入本机存储：${error.message}`
  }
  state.currentId = item.id
  renderQueue()
  return item
}

/* ---------------- 批量处理 ---------------- */

/**
 * 批量处理期间保持屏幕常亮。
 * iPhone 上这是刚需：处理几十张要几分钟，用户一放下手机就自动锁屏，
 * iOS 会立刻挂起 Safari 的 JS，推理直接断掉（而且不会自动续）。屏幕亮着就不会。
 * Screen Wake Lock 需要 iOS 16.4+ / 安全上下文（https 或 localhost）。拿不到就静默降级，
 * 不给用户报错 —— 这只是体验优化，不是功能依赖。
 */
let wakeLock = null
async function acquireWakeLock() {
  try {
    if (!('wakeLock' in navigator) || wakeLock) return
    wakeLock = await navigator.wakeLock.request('screen')
    // 系统可能因低电量模式等主动回收，置空以便下次能重新申请
    wakeLock.addEventListener('release', () => { wakeLock = null })
  } catch {
    wakeLock = null // 低电量模式、不支持、被拒绝 —— 都无所谓，继续跑
  }
}
async function releaseWakeLock() {
  try {
    await wakeLock?.release()
  } catch {
    /* 已释放或从未获得 */
  }
  wakeLock = null
}
// 切回前台时若还在批量处理，重新申请（切后台/锁屏会让浏览器释放锁）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running) void acquireWakeLock()
})

async function runBatch(items) {
  if (state.running || !items.length) return
  state.running = true
  state.stopRequested = false
  elements.stop.hidden = false
  renderQueue()
  void acquireWakeLock() // 别 await：拿不到锁也要照常开始处理
  const started = performance.now()
  let index = 0
  let failed = 0
  let storageWarning = ''
  try {
    for (const item of items) {
      if (state.stopRequested) break
      index++
      const fraction = (index - 1) / items.length
      setStatus(`第 ${index}/${items.length} 张 · ${item.name}`, fraction, '逐张处理中，请保持 Safari 在前台')
      const itemStarted = performance.now()
      try {
        await runWithOomFallback({
          run: async () => {
            await deleteResult(item.id).catch(() => {})
            item.persisted = false
            await processItem(item)
            item.progressText = ''
            if (item.persistError) storageWarning = item.persistError
            rememberTiming(selectedModel().id, (performance.now() - itemStarted) / 1000)
          },
          getThreads: () => currentThreads,
          setThreads: next => {
            runtimeThreadCap = next
            currentThreads = next
          },
          rebuild: () => releaseActiveSession(),
          onRetry: async next => {
            item.status = 'pending'
            item.error = null
            item.progressText = `内存不足，本次页面已重建为 ${next} 线程并重试`
            logThreadCount('因内存不足自动降级')
            renderQueue()
          },
        })
      } catch (error) {
        console.error(error)
        item.status = 'failed'
        item.error = isOutOfMemory(error)
          ? '设备内存不足；建议使用 INT8、关闭其他 Safari 标签页后重试'
          : friendlyError(item, error)
        failed++
        if (/120 秒|初始化超过|内存不足|推理超时|推理线程/.test(item.error)) await releaseActiveSession()
      }
      renderQueue()
      setMetrics(displayMetrics(item))
      setStatus(
        `第 ${index}/${items.length} 张 · ${item.status === 'failed' ? '失败' : item.status === 'unchanged' ? '未识别' : '已完成'}`,
        index / items.length,
        item.status === 'failed' ? item.error : item.name,
      )
      // 让出主线程，避免长时间占用
      await new Promise(resolve => setTimeout(resolve, 0))
      updateBatchHint(Math.max(0, items.length - index))
    }
  } finally {
    state.running = false
    elements.stop.hidden = true
    void releaseWakeLock()
    const done = state.items.filter(entry => entry.status === 'done').length
    const unchanged = state.items.filter(entry => entry.status === 'unchanged').length
    const totalSeconds = ((performance.now() - started) / 1000).toFixed(1)
    setStatus(
      state.stopRequested ? '已停止' : '批量处理完成',
      1,
      `完成 ${done} · 未识别 ${unchanged}${failed ? ` · 失败 ${failed}` : ''} · 用时 ${totalSeconds} 秒${storageWarning ? ` · ${storageWarning}` : ''}`,
    )
    updateBatchHint(0)
    renderQueue()
  }
}

/** 已处理 + 未识别（保持原图）都算「有结果」，保证一张都不少 */
function albumTargets() {
  return state.items.filter(hasResult)
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
  const targets = items.filter(hasResult)
  if (!targets.length) return
  try {
    if (!canShareFiles()) {
      const blob = await resultBlobFor(targets[0])
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = outputName(targets[0])
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
      setStatus('已开始下载', 1, targets.length > 1 ? '其余图片可在列表里逐张下载' : outputName(targets[0]))
      return
    }
    const blobs = await Promise.all(targets.map(resultBlobFor))
    const files = targets.map((item, index) => new File(
      [blobs[index]],
      outputName(item),
      { type: blobs[index].type || (item.status === 'unchanged' ? originalFormat(item).mime : outputFormat(item).mime) },
    ))
    setStatus(`正在打开分享面板（${files.length} 张）`, null, '在面板里选「存储图像」即可存进相册')
    await navigator.share({ files, title: 'Xiaolin 去水印结果' })
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
  try {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
    const zip = await buildZip(await zipEntries(finished))
    const url = URL.createObjectURL(zip)
    const link = document.createElement('a')
    link.href = url
    link.download = `去水印-${stamp}.zip`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
    setStatus('ZIP 已生成', 1, `${finished.length} 张 · ${(zip.size / 1048576).toFixed(1)} MB`)
  } catch (error) {
    setStatus(`ZIP 生成失败：${error.message}`, 1, '结果可能已被浏览器清理，请重新处理缺失图片')
  }
}

async function zipEntries(finished) {
  return Promise.all(finished.map(async (item, index) => {
    const stem = item.name.replace(/\.[^.]+$/, '')
    const ext = item.outputExt || outputFormat(item).ext
    const prefix = item.status === 'done' ? '去水印' : '原图'
    return {
      name: `${prefix}-${String(index + 1).padStart(3, '0')}-${stem}${ext}`,
      blob: await resultBlobFor(item),
    }
  }))
}

/* ---------------- 文件选择与恢复 ---------------- */

function newItemId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function makeThumbnailFromBlob(blob) {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 132
    canvas.height = Math.max(1, Math.round(bitmap.height * (132 / bitmap.width)))
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await canvasBlob(canvas, 'image/jpeg', 0.8)
  } finally {
    bitmap.close?.()
  }
}

async function addFiles(files, { restored = false, ids = [], warmup = true } = {}) {
  const accepted = files.filter(file => file && file.size > 0)
  if (!accepted.length) return
  if (!restored) {
    const candidateItems = [
      ...state.items,
      ...accepted.map(file => ({ file })),
    ]
    const limitReason = batchLimitReason(candidateItems)
    if (limitReason) {
      elements.file.value = ''
      elements.selectedName.hidden = false
      elements.selectedName.textContent = `无法追加：${limitReason}；现有 ${state.items.length} 张及结果已保留`
      setStatus('所选图片未加入列表', 0, '请减少本次选择数量或先下载并清空当前列表')
      return
    }
  }
  for (let index = 0; index < accepted.length; index++) {
    const file = accepted[index]
    const item = { id: ids[index] || newItemId(), file, name: file.name, restored, status: 'pending', thumbUrl: null, url: null, blob: null }
    state.items.push(item)
  }
  const latest = state.items[state.items.length - 1]
  elements.selectedName.hidden = false
  elements.selectedName.textContent = `已选择 ${accepted.length} 张，列表共 ${state.items.length} 张`
  // 同步标记：用户主动选图 = 下次打开可以恢复（localStorage 是同步落盘，关浏览器也不丢）
  try { localStorage.setItem(RESTORE_PREF_KEY, '1') } catch { /* 忽略 */ }
  // 先把原图任务写入 IndexedDB，再预热模型。iOS 可能在切到后台时立即回收页面，
  // 所以任务落盘优先于省下几秒模型等待。
  if (!restored) {
    try {
      const persisted = await saveBatch(state.items)
      if (!persisted.saved) elements.selectedName.textContent += ` · ${persisted.reason}`
    } catch (error) {
      const reason = error instanceof StorageCapacityError ? error.message : `无法保存任务：${error.message}`
      elements.selectedName.textContent += ` · ${reason}`
      console.warn('无法缓存所选图片', error)
    }
  }
  if (warmup) void warmUpModel()
  await showItem(latest.id)
  renderQueue()
  updateBatchHint()
  updatePreviewVisibility()
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
  // 批量处理期间不允许切换模型：这一批会变成「前几张用旧模型、后几张用新模型」，
  // 结果不可比；而且中途加载另一个模型会让内存峰值翻倍（评价第 3 条）。
  if (state.running) {
    input.checked = false
    const effective = activeModelId || sessionModelId || 'int8'
    const back = elements.modelInputs.find(item => item.value === effective)
    if (back) back.checked = true
    setStatus('处理中不能切换模型', 0, '点「停止」或等这批跑完再切换')
    return
  }
  setStatus('模型已切换', 0, '再次「开始批量处理」会用新模型重跑')
  setMetrics(displayMetrics(currentItem()))
  renderQueue()
  updateBatchHint()
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

elements.clear.addEventListener('click', async () => {
  if (state.running) return
  try { localStorage.setItem(RESTORE_PREF_KEY, '0') } catch { /* 忽略 */ }
  await clearStoredJob().catch(error => console.warn('清除任务缓存失败', error))
  state.items.forEach(revokeItem)
  state.items = []
  state.currentId = null
  elements.file.value = ''
  elements.selectedName.hidden = true
  elements.source.width = elements.source.height = 0
  elements.result.width = elements.result.height = 0
  setStatus('等待选择图片', 0)
  setMetrics({})
  renderQueue()
  updateBatchHint(0)
  updatePreviewVisibility()
})

async function restoreSelectedFiles() {
  try {
    if (localStorage.getItem(RESTORE_PREF_KEY) === '0') return
    const entries = await loadBatch()
    if (!entries.length) return
    await addFiles(entries.map(entry => entry.file), { restored: true, ids: entries.map(entry => entry.id), warmup: false })
    let completed = 0
    for (const item of state.items) {
      if (!item.file.size) {
        item.status = 'failed'
        item.error = '缓存原图为空，请重新选择这张图片'
        continue
      }
      // 逐张读取，避免恢复 20 张时把所有完整结果 Blob 同时挂在一个 Map 中。
      let result = null
      try {
        result = await loadResult(item.id)
      } catch (error) {
        item.persistError = `结果读取失败：${error.message}`
        console.warn(`无法恢复 ${item.name} 的结果`, error)
        continue
      }
      if (!result?.outputBlob) continue
      item.status = result.status === 'done' ? 'done' : 'unchanged'
      item.modelId = result.modelId
      item.blob = null
      item.url = null
      item.outputExt = result.outputExt
      item.provider = result.provider
      item.regions = result.regions
      item.elapsed = result.elapsed
      item.inferSeconds = result.inferSeconds
      item.metrics = result.metrics
      item.width = result.width
      item.height = result.height
      item.persisted = true
      try {
        const thumb = await makeThumbnailFromBlob(result.outputBlob)
        item.thumbUrl = URL.createObjectURL(thumb)
      } catch { /* 缩略图失败不影响结果恢复 */ }
      completed++
    }
    renderQueue()
    updateBatchHint()
    const lastDone = [...state.items].reverse().find(hasResult)
    if (lastDone) await showItem(lastDone.id)
    if (state.items.some(item => needsProcessing(item))) void warmUpModel()
    setStatus(`已恢复 ${entries.length} 张图片`, completed / entries.length, `其中 ${completed} 张已有结果，可继续剩余图片`)
  } catch (error) {
    console.warn('无法恢复上次图片', error)
    setStatus('暂时无法读取上次任务', 0, '请重新打开页面；如仍失败，可手动清空列表后重新选择')
  }
}

setMetrics({})
logThreadCount()
updatePreviewVisibility()
const iosMajor = Number((navigator.userAgent.match(/\bOS (\d+)[_.]/) || [])[1] || 0)
if (iosMajor >= 27) document.documentElement.classList.add('ios-liquid-glass')
if (elements.appVersion) elements.appVersion.textContent = `v${__APP_SEMVER__} · ${__BUILD_DATE__}`
// 尽量申请持久化存储：Safari 对「未加入主屏幕」的站点最多保留 7 天。
// 返回值要如实处理：被拒也不影响功能，但就不能对外承诺「缓存一定不会被清理」——
// 页脚文案已据此写成不依赖该结果的表述（评价第 8 条）。
void navigator.storage?.persist?.()
  .then(granted => {
    console.info(granted
      ? '已获得持久化存储，模型缓存不易被系统清理'
      : '未获得持久化存储：空间紧张时模型缓存可能被系统回收，重下即可')
  })
  .catch(() => { /* 不支持该 API 就静默跳过 */ })
void refreshCacheTags()
void getRuleEngine().catch(error => console.warn('规则引擎初始化失败', error))
void restoreSelectedFiles()
