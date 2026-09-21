import './style.css'
import { createRuleEngine } from './rules.js'
import { gaussianBlur, grayFromRgb, grayFromRgb8 } from './imaging.js'
import { processGemini } from './gemini.js'
import { buildZip } from './zip.js'
import { InferenceController } from './inference-controller.js'
import { preferredThreads, rememberThreadPref } from './threadPref.js'

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
// v2 起新增 results：把处理结果也落盘，刷新后能直接还原「已完成」而不必重跑。
// 用 onupgradeneeded 补建 store，老库里的 images 记录不受影响（升级是非破坏的）。
const IMAGE_DB_VERSION = 2
const RESULT_STORE = 'results'
const RESTORE_LIMIT_BYTES = 200 * 1024 * 1024
const RESTORE_LIMIT_COUNT = 40
const INFER_TIMEOUT_MS = 120000
const MODEL_CACHE_NAME = 'lama-model-v2'
const CHUNK_RETRIES = 4
// 备用镜像：GitHub 仓库经 jsDelivr CDN 分发，国内通常比 github.io 快。
// ⚠️ 必须钉在 commit hash 上，不能用 @main：jsDelivr 对分支引用只缓存 12 小时、内容会随推送变化，
// 会出现「CDN 上还是旧文件、清单却已是新的」的校验死循环；commit hash 是永久且不可变的。
// ⚠️ 模型文件更新后，这里要同步改成包含新文件的那个 commit。
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
    label: 'FP32 · 198MB',
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
  // 主界面「本地 AI 模型」那一行：只展示当前选中的模型，不做选择
  currentModelLabel: document.querySelector('#current-model-label'),
  cacheTagCurrent: document.querySelector('#cache-tag-current'),
  modelInputs: [...document.querySelectorAll('input[name="model"]')],
  downloadBar: document.querySelector('#download-bar'),
  downloadStatus: document.querySelector('#download-status'),
  downloadLabel: document.querySelector('#download-label'),
  downloadProgress: document.querySelector('#download-progress'),
}

const state = {
  items: [],
  // 条目 id 由 newItemId() 生成稳定 UUID —— 原来自增序号那套已移除，
  // 因为它刷新后会重新编号，导致恢复时与落盘的处理结果对不上。
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
/** 加载代次：只有最新一代允许写回当前 Worker，防止旧任务完成后覆盖新会话 */
let sessionGeneration = 0
let ruleEngine = null
let ruleEnginePromise = null

const assetBase = new URL(import.meta.env.BASE_URL, location.href)
const ortBase = new URL('ort/', assetBase).href

/**
 * 线程数偏好键。内存不足时把它调低并落盘，下次加载生效。
 * ⚠️ 为什么必须「下次加载生效」而不是当场生效：
 * ONNX Runtime 的 WASM 线程池在 **wasm 模块首次初始化时**建立，
 * 之后再改 `ort.env.wasm.numThreads` 并不会重建线程池 ——
 * 官方文档也要求这些环境参数在创建第一个会话之前设定。
 * 也就是说运行时改数字只是改了个显示值，实际还是原线程数（评价第 3 条）。
 *
 * 现在线程数与整个 WASM 运行环境都搬进了独立 Worker。要换线程数只有一条路：
 * terminate 掉旧 Worker、重建一个新的（见 releaseActiveSession）。
 * 这反而是好事 —— 重建是「真正的初始化」，不再有「改了数字但线程池没重建」的陷阱。
 */
/** 跨源隔离可用才有多线程（4 封顶）—— 这是本设备的上限 */
const threadCeiling = () => (crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1)

/**
 * localStorage 在 Safari 隐私模式下访问会抛错，包一层免得把推理带崩。
 * 探测只做一次，之后走缓存。
 */
let storageCache
function safeStorage() {
  if (storageCache !== undefined) return storageCache
  try {
    const probe = '__lama_storage_probe__'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    storageCache = localStorage
  } catch { storageCache = null }
  return storageCache
}

/** 当前 Worker 实际使用的线程数。线程数跟随会话，换线程数 = 重建 Worker */
let currentThreads = preferredThreads({ storage: safeStorage(), ceiling: threadCeiling() })

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
  // 没有指标可显示时整块收起来 —— 未选图时只有「识别结果 未处理」这类空信息，
  // 留着会在第一屏占掉一片位置
  elements.metrics.hidden = entries.length === 0
}

/**
 * 未选图时预览区只留两个标题条。
 * 空的 canvas 是纯黑方块：占掉大半屏、零信息量，还把页脚的使用说明推到要滚动才看得见。
 * 队列里有图就展开（选图后、恢复缓存后），清空则收回。
 */
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
/** ORT WASM 内存溢出（iPhone 13 等小内存机型在会话创建/推理时可能触发） */
function isOutOfMemory(error) {
  return /Out of memory|RangeError|no available backend/i.test(String(error?.message || error))
}
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

/**
 * 主指标区只回答两件事：识别到哪个平台、这张花了多久。
 * 删掉的那些都有替代、属于内部实现，或信息量太低：
 *   图片尺寸 —— 预览区直接看得到
 *   模型     —— 上方「本地 AI 模型」那行已经写了，重复
 *   线程数   —— 内部实现细节，移进「模型信息」折叠区
 *   本次推理 —— 与「总耗时」是两个含义相近的秒数，留一个就够
 *   区域数   —— 实际只会是 1 或 2（最多即梦两处水印），两种取值不值得占一格
 */
function displayMetrics(item) {
  if (!item) return {}
  const metrics = {
    识别结果: item.provider || (item.status === 'pending' ? '未处理' : '未识别'),
  }
  if (item.elapsed) metrics.总耗时 = item.elapsed
  return metrics
}

/**
 * 线程数不再显示在界面上 —— 它对用户没有意义（几个线程是内部实现）。
 * 只在控制台留一条：排查性能问题时需要它确认跨源隔离是否生效（4 = 生效，1 = 退回单线程）。
 */
function logThreadCount(reason = '') {
  const ceiling = threadCeiling()
  const degraded = currentThreads < ceiling
    ? `，受降级记忆限制（${ceiling} → ${currentThreads}，到期自动恢复）`
    : ''
  console.info(`推理线程：${currentThreads}（4 = 跨源隔离生效，1 = 退回单线程）${degraded}${reason ? ` · ${reason}` : ''}`)
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

/** jsDelivr 镜像地址。注意：它可用作整段下载源，但**不可用于 Range 续传**，见 chunkSources */
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

/** 三个源，默认顺序：jsDelivr（国内快）→ HuggingFace（模型原始出处，Cloudflare CDN）→ 同源（GitHub Pages）。
 *  rangeOffset：该源的 Range 起点参考系。镜像/同源的分段文件内偏移从 0 计；
 *  HF 是整个 onnx 文件，需用该段在整文件中的偏移（loaded），闭区间保证不下过头。
 *
 *  ⚠️ jsDelivr 必须带 noResume。实测（commit b7cb12e 的线上文件）：
 *  同一文件同一区间请求 `Range: bytes=8000000-8001023`，它返回 206，
 *  但 `Content-Range` 的总长报成 12207070（真实是 16777216），内容与原始文件不符；
 *  而该文件的**全量下载 SHA-256 与本地完全一致** —— 即「文件是对的，Range 是错的」。
 *  它照样返回 206，所以「只接受 206」这种校验挡不住它。
 *  结论：它只能整段下载（速度优势保留），一旦让它在段内续传就会污染数据。 */
function chunkSources(chunkUrl, relativePath, model, fileOffset) {
  const list = [
    { label: 'jsDelivr', url: mirrorUrl(relativePath), rangeOffset: 0, noResume: true },
    { label: 'HuggingFace', url: model.hf, rangeOffset: fileOffset },
    { label: '同源', url: chunkUrl, rangeOffset: 0 },
  ].filter(source => !!source.url)
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
 * 单段下载：断线/超时后带退避重试，并从已下载位置续传。
 * 手机上网络抖动很常见，整段重来在 0.2MB/s 的链路上代价太大 —— 所以进度保留在重试循环之外。
 * 源分两类：镜像/同源的分段文件内偏移从 0 计；HuggingFace 是整文件，rangeOffset 为该段在整文件中的偏移。
 *
 * ⚠️ 续传只在**同一个源内部**成立，两条铁律：
 *  1) 换源必须清零。不同源的同名分片不保证字节一致（jsDelivr 实测会返回错误副本），
 *     把上一个源已收的字节接到新源后面 = 「前半段错 + 后半段对」，只能等 SHA 校验失败后整段重下。
 *     （旧实现只在 status !== 206 时清零，而坏源同样返回 206，所以从来没清过 —— 这就是下载失败的根因。）
 *  2) noResume 的源（jsDelivr）连同一源内的重试也不续传，每次重试都从头下整段。
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
      // 铁律 2：不支持可靠续传的源，每次重试都重新整段下载
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
        // 一般只接受 206。但有一个必须放行的例外：**分片式源从头整段下载**。
        // 某些静态托管（实测 WorkBuddy 静态托管 / app.workbuddy.host）会忽略 Range 头，
        // 直接返回 200 + 整个文件；而分片文件本身就是我们要的那一段，所以这个 200 是可用的。
        // 判据必须同时满足两条，否则会误吞 HF 的整文件（那是 62MB/198MB）：
        //   ① rangeOffset === 0 —— 只对「分片即整段」的源放行；HF 是整文件，偏移不为 0 的段绝不接受
        //   ② have === 0 —— 只对从头下载放行；续传时对方不支持 Range，只能作废这一段
        // 后面仍会校验 have === chunk.size，多收少收都会被拦下。
        const selfContainedFromStart = rangeOffset === 0 && have === 0
        if (response.status !== 206 && !(response.status === 200 && selfContainedFromStart)) {
          throw new Error(`该源不支持断点续传（HTTP ${response.status}）`)
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
      // 每段开始前检查一次：被取消后不要再继续读缓存/下载别的段
      if (signal?.aborted) throw new Error('模型已切换，下载已取消')
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

      const sources = chunkSources(chunkUrl, relativePath, model, loaded)
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
    let text = '', cls = ''
    if (!status.supported) {
      tag.hidden = true
    } else if (status.have === status.total) {
      text = '已缓存'; cls = 'model-cache-tag cached'
    } else if (status.have === 0) {
      text = '未缓存'; cls = 'model-cache-tag missing'
    } else {
      text = `${status.have}/${status.total} 段`; cls = 'model-cache-tag partial'
    }
    if (!tag.hidden) { tag.textContent = text; tag.className = cls }
    // 主界面那一行展示的是「当前选中的模型」，缓存状态要跟着它走
    if (model.id === selected.id && elements.cacheTagCurrent) {
      const cur = elements.cacheTagCurrent
      cur.hidden = !!tag.hidden
      if (!tag.hidden) { cur.textContent = text; cur.className = cls }
    }
  }))
  if (elements.currentModelLabel) elements.currentModelLabel.textContent = selected.label
}

/**
 * 推理会话 = 一个独立 Worker。terminate 是唯一真正有效的释放手段：
 * 它同时停掉正在初始化/推理的 ORT，并回收整套 WASM 内存与线程池。
 * 旧的 session.release() 做不到 —— release 不保证中断进行中的 run，
 * 所以「超时」之后主线程照旧卡死、内存也还占着（评价第 3 条）。
 */
async function releaseActiveSession() {
  inference.terminate(new Error('推理会话已重建'))
  activeModelId = null
}

function getSession(model) {
  if (activeModelId === model.id && inference.worker) return Promise.resolve({ model, loadMs: 0, reused: true })
  if (sessionPromise && sessionModelId === model.id) return sessionPromise

  // 换模型：先把上一次仍在进行的加载掐掉。
  // 否则 62MB 与 198MB 会同时下载、同时校验、同时初始化，iPhone 上内存峰值直接翻倍，
  // 而且两个任务会争抢同一个 Worker（评价第 3 条）。
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
    let bytes = await fetchModel(model, controller.signal)
    if (generation !== sessionGeneration) throw new Error('模型已切换，本次加载作废')
    setStatus(`正在初始化 ${model.label}`, null, '请保持 Safari 在前台')
    currentThreads = preferredThreads({ storage: safeStorage(), ceiling: threadCeiling() })
    await inference.initialise({ model, modelBytes: bytes, threads: currentThreads, ortBase })
    bytes = null
    // 初始化期间用户可能已经切到了别的模型。此时绝不能把自己认成当前会话 ——
    // 否则界面显示的是新模型，实际跑推理的却是这个旧 Worker（结果对不上）。
    // 这里不必再 terminate：新一代加载在开头已经把它掐掉了。
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

/**
 * 识别水印：Gemini 走专用模板匹配，其余平台仍走规则引擎。
 *
 * 两条线必须同时跑 —— 一张图可能同时有 Gemini 和其他平台的水印，
 * 识别到 Gemini 不能跳过豆包/即梦等规则（反之亦然）。
 * Gemini 的返回分三种：not-found（不认识）、cleaned（反向 Alpha 直接还原成功）、
 * needs-inpaint（识别到了但质量不足，改用异形蒙版交 LaMa）。
 */
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

/**
 * 把 Gemini 反向 Alpha 还原出的像素块写回结果画布。
 * patch 是 Float→sRGB 还原后的 RGBA（Alpha 通道沿用原图），尺寸恰为 size×size，
 * 落点就是检测出的 (x, y)。写完即把 patch 置空释放，整块只占 size²×4 字节。
 */
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
  // 反向 Alpha 直接还原的结果不算"待修复区域"，但水印类型仍要计入 Gemini 这一处
  const geminiDirect = detected.gemini.status === 'cleaned'
  item.regions = detected.regions.length + (geminiDirect ? 1 : 0)
  const providers = detected.regions.map(region => region.provider)
  if (geminiDirect) providers.push('Gemini')
  item.provider = providers.length ? [...new Set(providers)].join('、') : ''

  let inferMs = 0
  if (!item.regions) {
    item.status = 'unchanged'
  } else {
    // 路径一：反向 Alpha 质量达标，直接还原，不需要 LaMa 推理
    if (geminiDirect) {
      item.progressText = '正在还原 Gemini 水印'
      renderQueue()
      await yieldToUi()
      applyGeminiPatch(targetContext, detected.gemini)
      detected.gemini.patch = null
    }
    // 路径二：其余区域（含 Gemini 质量不足时生成的异形蒙版）走 LaMa 局部修复。
    // 用独立 if 而非 else —— 同一张图上两种路径可能同时存在。
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
        // 推理交给独立 Worker：主线程不再被阻塞，超时能真正 terminate 掉推理。
        // 返回的就是结果张量的裸数据（Float32Array），直接拿去合成。
        const output = await inference.run(image, mask, INFER_TIMEOUT_MS)
        inferMs += performance.now() - started
        compositeRegion(targetContext.canvas, output, window_, maskInWindow)
      }
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
  item.metrics = displayMetrics(item)
  // 结果落盘：刷新/重开后这一张直接还原成「已完成」，不必重跑。
  // 「未识别 · 保持原图」同样落盘 —— 它的结论是"这张不用改"，重跑也只是再得出同样结论，
  // 一并恢复才不会让用户以为那一张没处理过。
  // 这里 await 是有意的：批量处理本来就在等，多花一次写盘换「刷新不白跑」很划算。
  try {
    const stored = await saveResultRecord(item)
    item.persisted = stored.saved
    item.persistReason = stored.reason
  } catch (error) {
    item.persisted = false
    item.persistReason = ''
    console.warn('处理结果未能写入本机存储', error)
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
  try {
    for (let loopIndex = 0; loopIndex < items.length; loopIndex++) {
      const item = items[loopIndex]
      if (state.stopRequested) break
      index++
      const fraction = (index - 1) / items.length
      setStatus(`第 ${index}/${items.length} 张 · ${item.name}`, fraction, '逐张处理中，请保持 Safari 在前台')
      let oomDowngrades = 0
      // 用内层循环重试当前张：OOM 时不需要刷新页面、也不需要退回外层重排，
      // 当场重建一个低线程 Worker 再跑一遍就行（旧版必须刷新才生效）。
      while (true) {
        try {
          // 结局未定，先把旧结果清掉：pending 的条目不该挂着一份结果。
          // 重试若成功会重新写盘，所以这里不会丢东西。
          await deleteResultRecord(item.id)
          await processItem(item)
          item.progressText = ''
          break
        } catch (error) {
          console.error(error)
          // iPhone 13 等小内存机型：ORT WASM 分配失败（多线程下峰值内存超 iOS 单页配额）。
          // Worker 是会话的生命周期边界：terminate 掉它，WASM 内存与线程池一并归还，
          // 再以 2/1 线程重建，当场重试 —— 无需刷新页面。
          // 这次降级会被记下来（带 24 小时有效期）：期间不再重复撞 OOM，
          // 到期若无新的 OOM 就自动恢复自动线程数，全程不需要用户操作。
          if (isOutOfMemory(error) && currentThreads > 1 && oomDowngrades < 2) {
            oomDowngrades++
            currentThreads = currentThreads > 2 ? 2 : 1
            rememberThreadPref(safeStorage(), currentThreads)
            await releaseActiveSession()
            item.status = 'pending'
            item.error = null
            item.progressText = `内存不足，已重建为 ${currentThreads} 线程并重试`
            logThreadCount('因内存不足自动降级')
            renderQueue()
            continue
          }
          item.status = 'failed'
          item.error = isOutOfMemory(error)
            ? '设备内存不足；建议切到 INT8 模型、关闭其他 Safari 标签页后重试'
            : friendlyError(item, error)
          failed++
          await deleteResultRecord(item.id)
          if (/120 秒|内存不足|推理超时|推理线程/.test(item.error)) await releaseActiveSession()
          break
        }
      }
      renderQueue()
      setMetrics(item.metrics || displayMetrics(item))
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
    void releaseWakeLock()
    const done = state.items.filter(entry => entry.status === 'done').length
    const unchanged = state.items.filter(entry => entry.status === 'unchanged').length
    // 结果没写进本机存储的那些：用户会默认「关掉页面再打开结果还在」，
    // 所以这件事必须说出来，不能只写在控制台（同 addFiles 里那条提示的理由）。
    const unsaved = state.items.filter(entry => entry.blob && entry.persisted === false).length
    const totalSeconds = ((performance.now() - started) / 1000).toFixed(1)
    setStatus(
      state.stopRequested ? '已停止' : '批量处理完成',
      1,
      `完成 ${done} · 未识别 ${unchanged}${failed ? ` · 失败 ${failed}` : ''} · 用时 ${totalSeconds} 秒`
        + (unsaved ? ` · ${unsaved} 张结果未能保存，刷新后需重跑` : ''),
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

/**
 * 稳定的条目 id。
 * ⚠️ 不能用原来那套会话内自增序号（state.nextId++）：刷新后条目会重新编号，
 * 结果记录就对不上了。改用随机 UUID，并随批记录一起落盘，恢复时原样传回。
 */
function newItemId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** 从结果 blob 重建队列缩略图。objectURL 无法持久化，只能恢复时重算 */
async function makeThumbnailFromBlob(blob) {
  const bitmap = await createImageBitmap(blob)
  try {
    const width = 132
    const height = Math.max(1, Math.round(bitmap.height * (width / bitmap.width)))
    const thumb = document.createElement('canvas')
    thumb.width = width
    thumb.height = height
    thumb.getContext('2d').drawImage(bitmap, 0, 0, width, height)
    return await canvasBlob(thumb, 'image/jpeg')
  } finally {
    bitmap.close?.()
  }
}

function openImageDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('浏览器不支持 IndexedDB'))
    const request = indexedDB.open(IMAGE_DB_NAME, IMAGE_DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(IMAGE_STORE)) database.createObjectStore(IMAGE_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(RESULT_STORE)) database.createObjectStore(RESULT_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('无法打开图片缓存'))
  })
}

async function saveSelectedFiles(files, ids) {
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (files.length > RESTORE_LIMIT_COUNT || total > RESTORE_LIMIT_BYTES) return false
  const database = await openImageDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(IMAGE_STORE, 'readwrite')
      transaction.objectStore(IMAGE_STORE).put({
        id: 'batch',
        savedAt: Date.now(),
        // ids 与 files 一一对应，且是稳定 UUID。结果记录靠它关联，所以必须一起存 ——
        // 只存文件的话，刷新后无从反查「这张图的结果是哪条」。
        ids,
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
    if (!record?.files?.length) return { files: [], ids: [] }
    return {
      files: record.files.map(entry => new File([entry.blob], entry.name, {
        type: entry.type || entry.blob.type,
        lastModified: entry.lastModified || Date.now(),
      })),
      // v1 的老记录没有 ids（那时还没做结果恢复）。返回空数组让调用方回退到新生成的 id：
      // 这类条目只是丢掉「结果恢复」，原图照常恢复、重跑即可，不该整体拒绝恢复。
      ids: Array.isArray(record.ids) && record.ids.length === record.files.length ? record.ids : [],
    }
  } finally { database.close() }
}

/**
 * 删除持久化的任务与结果（清空列表、恢复失败时调用），否则下次打开会再次恢复。
 * 两个 store 一起清：只清原图而留下结果，下次恢复的条目树与结果树就对不上了。
 */
async function deleteStoredFiles() {
  try {
    const database = await openImageDatabase()
    await new Promise((resolve, reject) => {
      const transaction = database.transaction([IMAGE_STORE, RESULT_STORE], 'readwrite')
      transaction.objectStore(IMAGE_STORE).delete('batch')
      transaction.objectStore(RESULT_STORE).clear()
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error || new Error('清除图片缓存失败'))
      transaction.onabort = () => reject(transaction.error || new Error('清除图片缓存中止'))
    })
    database.close()
  } catch (error) { console.warn('清除图片缓存失败', error) }
}

/* ---------------- 处理结果的持久化 ---------------- */

/**
 * 结果写盘的空间检查。
 * 不用"结果总量不超过 N MB"这种静态阈值：配额是整个源共享的（模型缓存那 62MB 也算在里面），
 * 静态阈值既可能过早放弃、也可能在配额已被别的东西吃掉时依然放行。
 * 直接问浏览器还剩多少，留 10% 余量给浏览器自己的操作空间。
 */
async function hasRoomForResult(bytes) {
  if (!navigator.storage?.estimate) return true
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    if (!quota) return true
    if (usage + bytes < quota * 0.9) return true
    console.warn(`本机存储余量不足（已用 ${(usage / 1048576).toFixed(0)}MB / 配额 ${(quota / 1048576).toFixed(0)}MB），本次不保留处理结果`)
    return false
  } catch { return true } // 问不到就当作有空间，不要因为探测失败而放弃恢复能力
}

/**
 * 把一张的处理结果写盘，刷新后可原样还原。
 * 只返回成败、不抛异常 —— 恢复能力是锦上添花，不能因为它让本已成功的处理变成红色失败。
 */
async function saveResultRecord(item) {
  if (!item.blob) return { saved: false, reason: '' }
  if (!await hasRoomForResult(item.blob.size)) {
    return { saved: false, reason: '本机存储空间不足，本次不保留处理结果' }
  }
  const database = await openImageDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(RESULT_STORE, 'readwrite')
      transaction.objectStore(RESULT_STORE).put({
        id: item.id,
        savedAt: Date.now(),
        status: item.status,
        modelId: item.modelId,
        outputBlob: item.blob,
        outputExt: item.outputExt,
        provider: item.provider,
        regions: item.regions,
        elapsed: item.elapsed,
        inferSeconds: item.inferSeconds,
        metrics: item.metrics,
        width: item.width,
        height: item.height,
      })
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error || new Error('结果缓存失败'))
      transaction.onabort = () => reject(transaction.error || new Error('结果缓存中止'))
    })
    return { saved: true, reason: '' }
  } finally { database.close() }
}

/** 批量读回结果。没有记录的 id 自然缺席，由调用方跳过 */
async function readResultRecords(ids) {
  const wanted = ids.filter(Boolean)
  if (!wanted.length) return new Map()
  const database = await openImageDatabase()
  try {
    const transaction = database.transaction(RESULT_STORE, 'readonly')
    const store = transaction.objectStore(RESULT_STORE)
    const records = await Promise.all(wanted.map(id => new Promise((resolve, reject) => {
      const request = store.get(id)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error || new Error('结果恢复失败'))
    })))
    return new Map(records.filter(record => record?.outputBlob).map(record => [record.id, record]))
  } finally { database.close() }
}

/**
 * 删掉一张的结果。
 * 重跑有可能变成「失败」或「未识别」—— 此时若不删旧记录，下次刷新会把它还原成重跑前的
 * 成功状态，界面与实际不符（而且用户会以为那张处理过了）。
 */
async function deleteResultRecord(id) {
  try {
    const database = await openImageDatabase()
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(RESULT_STORE, 'readwrite')
      transaction.objectStore(RESULT_STORE).delete(id)
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error || new Error('结果清除失败'))
      transaction.onabort = () => reject(transaction.error || new Error('结果清除中止'))
    })
    database.close()
  } catch (error) { console.warn('清除结果缓存失败', error) }
}

async function addFiles(files, { restored = false, ids = [] } = {}) {
  const accepted = files.filter(file => file && file.size > 0)
  if (!accepted.length) return
  for (let index = 0; index < accepted.length; index++) {
    const file = accepted[index]
    // 恢复时沿用落盘的 id，结果记录才挂得上；用户新选图则现生成一个。
    const item = { id: ids[index] || newItemId(), file, name: file.name, restored, status: 'pending', thumbUrl: null, url: null, blob: null }
    state.items.push(item)
  }
  const latest = state.items[state.items.length - 1]
  elements.selectedName.hidden = false
  elements.selectedName.textContent = restored
    ? `已恢复上次的 ${accepted.length} 张图片，列表共 ${state.items.length} 张`
    : `已选择 ${accepted.length} 张，列表共 ${state.items.length} 张`
  // 同步标记：用户主动选图 = 下次打开可以恢复（localStorage 是同步落盘，关浏览器也不丢）
  try { localStorage.setItem('lama-restore', '1') } catch { /* 忽略 */ }
  // 选完图立刻在后台准备模型（下载 / 读缓存 / 校验 / 建会话）。
  // ⚠️ 保持尽早启动、不要为了别的目的往后挪：它可能要下 62MB，
  // 挪到 saveSelectedFiles（写 IndexedDB）与 showItem（解码位图）之后，
  // 等于把这些耗时都加在下载前面 —— 实测会把预热推迟好几秒，是反向优化。
  void warmUpModel()
  try {
    const persisted = await saveSelectedFiles(state.items.map(item => item.file), state.items.map(item => item.id))
    if (!persisted) {
      // 别只写 console —— 用户会默认「关掉页面再打开一定能恢复」（评价第 7 条）。
      // 写在选图信息那一行：不占用状态文字，也不会被模型下载进度覆盖。
      elements.selectedName.textContent += ' · 图片较多，本次不启用自动恢复'
    }
  } catch (error) { console.warn('无法缓存所选图片', error) }
  await showItem(latest.id)
  renderQueue()
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
  // 同步写清空标记：即使下面的 IndexedDB 删除还没落盘、用户立刻关浏览器，下次打开也据此跳过恢复
  try { localStorage.setItem('lama-restore', '0') } catch { /* 忽略 */ }
  await deleteStoredFiles()
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
  updatePreviewVisibility()
})

async function restoreSelectedFiles() {
  try {
    // 用户清空过（同步标记）就不恢复，即使 IndexedDB 删除因竞态没完成
    if (localStorage.getItem('lama-restore') === '0') return
    const { files, ids } = await readSelectedFiles()
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
    await addFiles(files, { restored: true, ids })
    // 还原已完成的结果：把落盘的输出直接画回来，这些图不必重跑。
    const records = await readResultRecords(state.items.map(item => item.id))
    let completed = 0
    for (const item of state.items) {
      const record = records.get(item.id)
      if (!record) continue
      item.status = record.status === 'done' ? 'done' : 'unchanged'
      item.modelId = record.modelId
      item.blob = record.outputBlob
      item.url = URL.createObjectURL(record.outputBlob)
      item.outputExt = record.outputExt
      item.provider = record.provider
      item.regions = record.regions
      item.elapsed = record.elapsed
      item.inferSeconds = record.inferSeconds
      item.metrics = record.metrics
      item.width = record.width
      item.height = record.height
      item.persisted = true
      try {
        // 缩略图是 objectURL，无法持久化，只能从结果 blob 重算。
        // 它失败不该连累结果本身 —— 缩略图只是列表里的小方块。
        const thumb = await makeThumbnailFromBlob(record.outputBlob)
        item.thumbUrl = URL.createObjectURL(thumb)
      } catch { /* 忽略 */ }
      completed++
    }
    // 显示最近一张有结果的：否则预览区停在第一张的原图上，看起来像什么都没恢复。
    const lastDone = [...state.items].reverse().find(item => item.blob)
    if (lastDone) await showItem(lastDone.id)
    // 「其中 X 张已有结果」写进选图信息那一行，而不是状态文字：
    // 状态文字紧接着就会被模型预热的「正在初始化…」覆盖掉，用户基本看不到。
    // 这和上面「不启用自动恢复」的提示是同一个理由 —— 见 addFiles 里的注释。
    if (completed) elements.selectedName.textContent += ` · 其中 ${completed} 张已有结果`
    setStatus(
      `已恢复上次的 ${files.length} 张图片`,
      completed / files.length,
      completed
        ? `其中 ${completed} 张已有结果，可直接查看或下载；剩余的可继续处理`
        : '点「开始批量处理」继续',
    )
  } catch (error) {
    console.warn('无法恢复上次图片', error)
    try { localStorage.setItem('lama-restore', '0') } catch { /* 忽略 */ }
    await deleteStoredFiles()
    setStatus('上次的图片缓存已失效，请重新选择图片', 0, '浏览器清理过本地数据，这是正常的')
  }
}

setMetrics({})
logThreadCount()
updatePreviewVisibility()
// iOS 27 的 Liquid Glass 顶部栏会浮在网页内容之上做半透明淡化 ——
// 实测 iPhone 17 Pro（iOS 27）首屏第一行「本机浏览器推理 · 图片不会上传」被压得看不清。
// 这里按**系统版本**给整页加一段上边距让开它，旧系统完全不受影响。
//
// 为什么不能按机型判断：iPhone 17 与 17 Pro 的视口尺寸与像素比完全一致（402×874、3x），
// CSS 与 JS 都区分不了这两台机器。真正引发问题的是 iOS 27，不是机型 ——
// 按版本走既等价、又不会漏掉以后升级的其它设备。
const iosMajor = Number((navigator.userAgent.match(/\bOS (\d+)[_.]/) || [])[1] || 0)
if (iosMajor >= 27) document.documentElement.classList.add('ios-liquid-glass')
// 版本号：语义版本取自 package.json，日期为构建日期（本地时区）—— 两者都由 vite define 注入，
// 页面不再硬编码，避免「改了代码却忘了改页面上的版本号」。
// 判空后再写：元素可能因「旧 HTML + 新 JS」的缓存混合态而缺失。
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
