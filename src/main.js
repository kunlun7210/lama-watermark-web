import * as ort from 'onnxruntime-web/wasm'
import './style.css'
import { createRuleEngine } from './rules.js'
import { gaussianBlur, grayFromRgb, grayFromRgb8 } from './imaging.js'
import { buildZip } from './zip.js'

const MODEL_SIZE = 512
const IMAGE_DB_NAME = 'lama-iphone-poc'
const IMAGE_STORE = 'images'
const RESTORE_LIMIT_BYTES = 200 * 1024 * 1024
const RESTORE_LIMIT_COUNT = 40
const INFER_TIMEOUT_MS = 120000
const MODELS = {
  int8: { id: 'int8', label: 'INT8 62MB', manifest: 'models/int8/manifest.json', inputLayout: 'masked-rgb-mask' },
  fp32: { id: 'fp32', label: 'FP32 198MB', manifest: 'models/fp32/manifest.json', inputLayout: 'image-mask' },
}
const elements = {
  file: document.querySelector('#file-input'),
  selectedName: document.querySelector('#selected-name'),
  run: document.querySelector('#run'),
  runBatch: document.querySelector('#run-batch'),
  stop: document.querySelector('#stop'),
  saveAll: document.querySelector('#save-all'),
  shareAll: document.querySelector('#share-all'),
  clear: document.querySelector('#clear'),
  share: document.querySelector('#share'),
  download: document.querySelector('#download'),
  source: document.querySelector('#source'),
  result: document.querySelector('#result'),
  status: document.querySelector('#status'),
  progress: document.querySelector('#progress'),
  progressLabel: document.querySelector('#progress-label'),
  metrics: document.querySelector('#metrics'),
  queueCard: document.querySelector('#queue-card'),
  queue: document.querySelector('#queue'),
  queueSummary: document.querySelector('#queue-summary'),
  modelInputs: [...document.querySelectorAll('input[name="model"]')],
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

function baseMetrics() {
  const item = currentItem()
  return {
    图片: item?.width ? `${item.width} × ${item.height}` : '未选择',
    模型: selectedModel().label,
    线程: String(ort.env.wasm.numThreads),
    隔离模式: crossOriginIsolated ? '是' : '否',
  }
}

/* ---------------- 模型会话 ---------------- */

function progressDetail(loaded, total, index, chunkCount, started) {
  const elapsed = Math.max((performance.now() - started) / 1000, 0.1)
  const mbps = loaded / 1048576 / elapsed
  const remaining = mbps > 0 ? (total - loaded) / 1048576 / mbps : 0
  const eta = remaining >= 60 ? `${Math.ceil(remaining / 60)} 分钟` : `${Math.max(1, Math.ceil(remaining))} 秒`
  return `分段 ${index}/${chunkCount} · ${(loaded / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB · ${mbps.toFixed(1)} MB/s · 约剩 ${eta}`
}

async function fetchModel(model) {
  const manifestUrl = new URL(model.manifest, assetBase).href
  setStatus(`正在连接 ${model.label}`, 0, '首次下载后浏览器通常会缓存')
  const manifestResponse = await fetch(manifestUrl, { cache: 'no-cache' })
  if (!manifestResponse.ok) throw new Error(`模型清单读取失败：HTTP ${manifestResponse.status}`)
  const manifest = await manifestResponse.json()
  if (!Number.isSafeInteger(manifest.totalSize) || !Array.isArray(manifest.chunks)) throw new Error('模型清单格式错误')

  const bytes = new Uint8Array(manifest.totalSize)
  let loaded = 0
  const started = performance.now()
  for (let index = 0; index < manifest.chunks.length; index++) {
    const chunk = manifest.chunks[index]
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 180000)
    let partLoaded = 0
    try {
      const url = new URL(chunk.file, manifestUrl).href
      const response = await fetch(url, { cache: 'force-cache', signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(`模型分段 ${index + 1} 下载失败：HTTP ${response.status}`)
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (loaded + value.byteLength > bytes.byteLength) throw new Error('模型数据超过清单大小')
        bytes.set(value, loaded)
        loaded += value.byteLength
        partLoaded += value.byteLength
        setStatus('正在下载 LaMa 模型', loaded / manifest.totalSize, progressDetail(loaded, manifest.totalSize, index + 1, manifest.chunks.length, started))
      }
    } finally {
      clearTimeout(timeout)
    }
    if (partLoaded !== chunk.size) throw new Error(`模型分段 ${index + 1} 大小不符`)
  }
  if (loaded !== manifest.totalSize) throw new Error('模型文件不完整')
  return bytes
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
    const view = document.createElement('button')
    view.type = 'button'
    view.className = 'secondary'
    view.textContent = '预览'
    view.addEventListener('click', () => void showItem(item.id))
    actions.append(view)
    if (item.url) {
      const save = document.createElement('a')
      save.className = 'secondary link-button'
      save.href = item.url
      save.download = outputName(item)
      save.textContent = '保存'
      actions.append(save)
    }

    li.append(thumb, info, actions)
    return li
  }))

  const hasResult = zipTargets().length
  elements.saveAll.hidden = hasResult === 0
  elements.saveAll.textContent = `保存全部（ZIP · ${hasResult} 张）`
  elements.shareAll.hidden = hasResult === 0 || !navigator.share
  elements.clear.hidden = state.items.length === 0
  elements.runBatch.disabled = state.running || !state.items.some(item => needsProcessing(item))
  elements.run.disabled = state.running || !currentItem()
  elements.download.hidden = !currentItem()?.url
  elements.share.hidden = !currentItem()?.url || !navigator.share
  if (currentItem()?.url) {
    elements.download.href = currentItem().url
    elements.download.download = outputName(currentItem())
  }
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
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
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
        item.error = error.message || String(error)
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

async function saveAll() {
  const finished = zipTargets()
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

/** 已处理 + 未识别（保持原图）都入包，保证「一张都不少」 */
function zipTargets() {
  return state.items.filter(item => (item.status === 'done' || item.status === 'unchanged') && item.blob)
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

async function shareAll() {
  const finished = zipTargets()
  if (!finished.length) return
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
  const zip = await buildZip(zipEntries(finished))
  const file = new File([zip], `去水印-${stamp}.zip`, { type: 'application/zip' })
  try {
    await navigator.share({ files: [file], title: 'LaMa 去水印结果' })
  } catch (error) {
    if (error.name !== 'AbortError') setStatus(`分享失败：${error.message}`, 1)
  }
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

async function addFiles(files) {
  const accepted = files.filter(file => file && file.size > 0)
  if (!accepted.length) return
  for (const file of accepted) {
    const item = { id: state.nextId++, file, name: file.name, status: 'pending', thumbUrl: null, url: null, blob: null }
    state.items.push(item)
  }
  const latest = state.items[state.items.length - 1]
  elements.selectedName.hidden = false
  elements.selectedName.textContent = `已选择 ${accepted.length} 张，列表共 ${state.items.length} 张`
  try {
    const persisted = await saveSelectedFiles(state.items.map(item => item.file))
    if (!persisted) console.info('图片较多，未启用自动恢复缓存')
  } catch (error) { console.warn('无法缓存所选图片', error) }
  await showItem(latest.id)
  renderQueue()
}

/* ---------------- 事件 ---------------- */

elements.file.addEventListener('change', async () => {
  await addFiles([...(elements.file.files || [])])
})

elements.modelInputs.forEach(input => input.addEventListener('change', () => {
  setStatus('模型已切换', 0, '再次「开始批量处理」会用新模型重跑')
  setMetrics(baseMetrics())
  renderQueue()
}))

elements.runBatch.addEventListener('click', () => {
  const targets = state.items.filter(item => needsProcessing(item))
  void runBatch(targets)
})

elements.run.addEventListener('click', () => {
  const item = currentItem()
  if (item) void runBatch([item])
})

elements.stop.addEventListener('click', () => {
  state.stopRequested = true
  setStatus('正在停止…', null, '当前这张处理完就会停下')
})

elements.saveAll.addEventListener('click', () => { void saveAll() })
elements.shareAll.addEventListener('click', () => { void shareAll() })

elements.clear.addEventListener('click', () => {
  if (state.running) return
  state.items.forEach(revokeItem)
  state.items = []
  state.currentId = null
  elements.file.value = ''
  elements.selectedName.hidden = true
  elements.source.width = elements.source.height = 0
  elements.result.width = elements.result.height = 0
  setStatus('等待选择图片', 0)
  setMetrics({ 模型: selectedModel().label, 线程: String(ort.env.wasm.numThreads), 隔离模式: crossOriginIsolated ? '是' : '否', 连接: isSecureContext ? 'HTTPS' : 'HTTP' })
  renderQueue()
})

elements.share.addEventListener('click', async () => {
  const item = currentItem()
  if (!item?.blob) return
  const format = outputFormat(item)
  const file = new File([item.blob], outputName(item), { type: format.mime })
  try { await navigator.share({ files: [file], title: 'LaMa 去水印结果' }) } catch (error) { if (error.name !== 'AbortError') setStatus(`分享失败：${error.message}`, 1) }
})

async function restoreSelectedFiles() {
  try {
    const files = await readSelectedFiles()
    if (!files.length) return
    await addFiles(files)
    setStatus(`已恢复上次的 ${files.length} 张图片`, 0, '点「开始批量处理」继续')
  } catch (error) { console.warn('无法恢复上次图片', error) }
}

setMetrics({ 模型: selectedModel().label, 线程: String(ort.env.wasm.numThreads), 隔离模式: crossOriginIsolated ? '是' : '否', 连接: isSecureContext ? 'HTTPS' : 'HTTP' })
void getRuleEngine().catch(error => console.warn('规则引擎初始化失败', error))
void restoreSelectedFiles()
