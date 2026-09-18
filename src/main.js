import * as ort from 'onnxruntime-web/wasm'
import './style.css'

const MODEL_SIZE = 512
const IMAGE_DB_NAME = 'lama-iphone-poc'
const IMAGE_STORE = 'images'
const MODELS = {
  int8: { id: 'int8', label: 'INT8 62MB', manifest: 'models/int8/manifest.json', inputLayout: 'masked-rgb-mask' },
  fp32: { id: 'fp32', label: 'FP32 198MB', manifest: 'models/fp32/manifest.json', inputLayout: 'image-mask' },
}
const elements = {
  file: document.querySelector('#file-input'),
  selectedName: document.querySelector('#selected-name'),
  run: document.querySelector('#run'),
  share: document.querySelector('#share'),
  download: document.querySelector('#download'),
  source: document.querySelector('#source'),
  result: document.querySelector('#result'),
  status: document.querySelector('#status'),
  progress: document.querySelector('#progress'),
  progressLabel: document.querySelector('#progress-label'),
  metrics: document.querySelector('#metrics'),
  modelInputs: [...document.querySelectorAll('input[name="model"]')],
}

let selectedFile = null
let sourceBitmap = null
let activeSession = null
let sessionPromise = null
let sessionModelId = null
let resultBlob = null
let resultUrl = null

const assetBase = new URL(import.meta.env.BASE_URL, location.href)
const ortBase = new URL('ort/', assetBase).href
ort.env.wasm.wasmPaths = {
  wasm: `${ortBase}ort-wasm-simd-threaded.wasm`,
  mjs: `${ortBase}ort-wasm-simd-threaded.mjs`,
}
ort.env.wasm.numThreads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1
ort.env.wasm.simd = true
ort.env.logLevel = 'warning'

function selectedModel() {
  return MODELS[elements.modelInputs.find(input => input.checked)?.value || 'int8']
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

async function decodeFile(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    const url = URL.createObjectURL(file)
    try {
      const image = new Image()
      image.src = url
      await image.decode()
      return await createImageBitmap(image)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

function drawBitmap(canvas, bitmap) {
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0)
}

function doubaoRepairRect(width, height) {
  const short = Math.min(width, height)
  const scale = short / 1600
  const markWidth = Math.max(30, Math.round(251 * scale))
  const markHeight = Math.max(8, Math.round(55 * scale))
  const x = Math.round(width - 27 * scale - markWidth)
  const y = Math.round(height - 32 * scale - markHeight)
  const padding = Math.max(8, Math.round(short * 0.006))
  return {
    x: Math.max(0, x - padding),
    y: Math.max(0, y - padding),
    w: Math.min(width, x + markWidth + padding) - Math.max(0, x - padding),
    h: Math.min(height, y + markHeight + padding) - Math.max(0, y - padding),
  }
}

function cropWindow(rect, width, height) {
  const marginX = Math.max(64, Math.round(rect.w * 0.75))
  const marginY = Math.max(64, Math.round(rect.h * 0.75))
  const rawX = Math.max(0, rect.x - marginX)
  const rawY = Math.max(0, rect.y - marginY)
  const rawWidth = Math.min(width, rect.x + rect.w + marginX) - rawX
  const rawHeight = Math.min(height, rect.y + rect.h + marginY) - rawY
  const side = Math.min(Math.max(rawWidth, rawHeight), width, height)
  const x = Math.max(0, Math.min(Math.round(rect.x + rect.w / 2 - side / 2), width - side))
  const y = Math.max(0, Math.min(Math.round(rect.y + rect.h / 2 - side / 2), height - side))
  return { x, y, w: side, h: side }
}

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

function buildInputs(sourceCanvas, crop, rect) {
  const work = document.createElement('canvas')
  work.width = work.height = MODEL_SIZE
  const context = work.getContext('2d', { willReadFrequently: true })
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(sourceCanvas, crop.x, crop.y, crop.w, crop.h, 0, 0, MODEL_SIZE, MODEL_SIZE)
  const pixels = context.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data
  const plane = MODEL_SIZE * MODEL_SIZE
  const image = new Float32Array(plane * 3)
  for (let index = 0; index < plane; index++) {
    image[index] = pixels[index * 4] / 255
    image[plane + index] = pixels[index * 4 + 1] / 255
    image[plane * 2 + index] = pixels[index * 4 + 2] / 255
  }
  const mask = new Float32Array(plane)
  const x0 = Math.max(0, Math.floor((rect.x - crop.x) / crop.w * MODEL_SIZE) - 2)
  const y0 = Math.max(0, Math.floor((rect.y - crop.y) / crop.h * MODEL_SIZE) - 2)
  const x1 = Math.min(MODEL_SIZE, Math.ceil((rect.x + rect.w - crop.x) / crop.w * MODEL_SIZE) + 2)
  const y1 = Math.min(MODEL_SIZE, Math.ceil((rect.y + rect.h - crop.y) / crop.h * MODEL_SIZE) + 2)
  for (let y = y0; y < y1; y++) mask.fill(1, y * MODEL_SIZE + x0, y * MODEL_SIZE + x1)
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

function renderOutput(sourceCanvas, output, crop, rect) {
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

  const blendedCrop = document.createElement('canvas')
  blendedCrop.width = crop.w
  blendedCrop.height = crop.h
  const blendedContext = blendedCrop.getContext('2d', { willReadFrequently: true })
  blendedContext.drawImage(sourceCanvas, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h)
  const sourcePixels = blendedContext.getImageData(0, 0, crop.w, crop.h)
  blendedContext.clearRect(0, 0, crop.w, crop.h)
  blendedContext.imageSmoothingEnabled = true
  blendedContext.imageSmoothingQuality = 'high'
  blendedContext.drawImage(patch, 0, 0, crop.w, crop.h)
  const repairedPixels = blendedContext.getImageData(0, 0, crop.w, crop.h)
  const sigma = 1.6
  const erf = value => {
    const sign = value < 0 ? -1 : 1
    const x = Math.abs(value)
    const t = 1 / (1 + 0.3275911 * x)
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
    return sign * y
  }
  const cdf = value => 0.5 * (1 + erf(value / Math.SQRT2))
  for (let y = 0; y < crop.h; y++) {
    const globalY = crop.y + y + 0.5
    const alphaY = cdf((globalY - rect.y) / sigma) * cdf((rect.y + rect.h - globalY) / sigma)
    if (alphaY < 0.001) continue
    for (let x = 0; x < crop.w; x++) {
      const globalX = crop.x + x + 0.5
      const alphaX = cdf((globalX - rect.x) / sigma) * cdf((rect.x + rect.w - globalX) / sigma)
      const alpha = alphaX * alphaY
      if (alpha < 0.001) continue
      const offset = (y * crop.w + x) * 4
      for (let channel = 0; channel < 3; channel++) sourcePixels.data[offset + channel] = Math.round(repairedPixels.data[offset + channel] * alpha + sourcePixels.data[offset + channel] * (1 - alpha))
    }
  }
  blendedContext.putImageData(sourcePixels, 0, 0)

  elements.result.width = sourceCanvas.width
  elements.result.height = sourceCanvas.height
  const result = elements.result.getContext('2d')
  result.drawImage(sourceCanvas, 0, 0)
  result.drawImage(blendedCrop, crop.x, crop.y)
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG 导出失败')), 'image/png'))
}

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

async function saveSelectedFile(file) {
  const database = await openImageDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(IMAGE_STORE, 'readwrite')
      transaction.objectStore(IMAGE_STORE).put({ id: 'last-selected-image', blob: file, name: file.name, type: file.type, lastModified: file.lastModified })
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error || new Error('图片缓存失败'))
      transaction.onabort = () => reject(transaction.error || new Error('图片缓存中止'))
    })
  } finally { database.close() }
}

async function readSelectedFile() {
  const database = await openImageDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(IMAGE_STORE, 'readonly')
      const request = transaction.objectStore(IMAGE_STORE).get('last-selected-image')
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error || new Error('图片恢复失败'))
    })
  } finally { database.close() }
}

async function loadSelectedFile(file, { persist = true, restored = false } = {}) {
  selectedFile = file
  resultBlob = null
  elements.share.hidden = true
  elements.download.hidden = true
  elements.selectedName.hidden = false
  elements.selectedName.textContent = `${restored ? '已自动恢复' : '已选择'}：${file.name}`
  setStatus('正在读取图片', null)
  try {
    sourceBitmap?.close?.()
    sourceBitmap = await decodeFile(file)
    drawBitmap(elements.source, sourceBitmap)
    elements.result.width = sourceBitmap.width
    elements.result.height = sourceBitmap.height
    elements.result.getContext('2d').clearRect(0, 0, sourceBitmap.width, sourceBitmap.height)
    if (persist) {
      try { await saveSelectedFile(file) } catch (error) { console.warn('无法缓存所选图片', error) }
    }
    elements.run.disabled = false
    setStatus(restored ? '已恢复上次图片' : '图片已就绪', 0, '切回 Safari 后无需重新选择')
    setMetrics({ 图片: `${sourceBitmap.width} × ${sourceBitmap.height}`, 模型: selectedModel().label, 线程: String(ort.env.wasm.numThreads), 隔离模式: crossOriginIsolated ? '是' : '否' })
  } catch (error) { setStatus(`图片读取失败：${error.message}`, 0) }
}

elements.file.addEventListener('change', async () => {
  const file = elements.file.files?.[0]
  if (file) await loadSelectedFile(file)
})

elements.modelInputs.forEach(input => input.addEventListener('change', () => {
  resultBlob = null
  elements.share.hidden = true
  elements.download.hidden = true
  if (sourceBitmap) setStatus('模型已切换', 0, `将使用 ${selectedModel().label}`)
  setMetrics({ 图片: sourceBitmap ? `${sourceBitmap.width} × ${sourceBitmap.height}` : '未选择', 模型: selectedModel().label, 线程: String(ort.env.wasm.numThreads), 隔离模式: crossOriginIsolated ? '是' : '否' })
}))

async function restoreSelectedFile() {
  try {
    const record = await readSelectedFile()
    if (!record?.blob) return
    const file = new File([record.blob], record.name || '上次图片', { type: record.type || record.blob.type, lastModified: record.lastModified || Date.now() })
    await loadSelectedFile(file, { persist: false, restored: true })
  } catch (error) { console.warn('无法恢复上次图片', error) }
}

elements.run.addEventListener('click', async () => {
  if (!sourceBitmap || !selectedFile) return
  elements.run.disabled = true
  const totalStarted = performance.now()
  const model = selectedModel()
  try {
    setStatus(`正在准备 ${model.label}`, 0, '请保持 Safari 在前台')
    const { session, loadMs, reused } = await getSession(model)
    const rect = doubaoRepairRect(sourceBitmap.width, sourceBitmap.height)
    const crop = cropWindow(rect, sourceBitmap.width, sourceBitmap.height)
    const { image, mask } = buildInputs(elements.source, crop, rect)
    setStatus(`${model.label} 正在修复`, null, '页面短暂无响应属于正常现象')
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const inferStarted = performance.now()
    const { feeds, tensors } = createFeeds(session, model, image, mask)
    const result = await session.run(feeds)
    const inferMs = performance.now() - inferStarted
    const outputTensor = result[session.outputNames[0]]
    renderOutput(elements.source, outputTensor.data, crop, rect)
    tensors.forEach(tensor => tensor.dispose?.())
    outputTensor.dispose?.()
    resultBlob = await canvasBlob(elements.result)
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    resultUrl = URL.createObjectURL(resultBlob)
    elements.download.href = resultUrl
    elements.download.download = `${selectedFile.name.replace(/\.[^.]+$/, '')}-${model.id}.png`
    elements.download.hidden = false
    elements.share.hidden = !navigator.share
    const totalMs = performance.now() - totalStarted
    setStatus('处理完成', 1, model.label)
    setMetrics({
      图片: `${sourceBitmap.width} × ${sourceBitmap.height}`,
      模型: model.label,
      模型准备: reused ? '已复用' : `${(loadMs / 1000).toFixed(1)} 秒`,
      本次推理: `${(inferMs / 1000).toFixed(1)} 秒`,
      总耗时: `${(totalMs / 1000).toFixed(1)} 秒`,
      WASM线程: String(ort.env.wasm.numThreads),
      隔离模式: crossOriginIsolated ? '是' : '否',
    })
  } catch (error) {
    console.error(error)
    const message = error.name === 'AbortError' ? '模型分段下载超过 3 分钟，请检查网络后重试' : (error.message || String(error))
    setStatus(`处理失败：${message}`, 0, '可直接再次点击重试')
  } finally { elements.run.disabled = false }
})

elements.share.addEventListener('click', async () => {
  if (!resultBlob || !selectedFile) return
  const file = new File([resultBlob], `${selectedFile.name.replace(/\.[^.]+$/, '')}-${selectedModel().id}.png`, { type: 'image/png' })
  try { await navigator.share({ files: [file], title: 'LaMa 去水印结果' }) } catch (error) { if (error.name !== 'AbortError') setStatus(`分享失败：${error.message}`, 1) }
})

setMetrics({ 模型: selectedModel().label, 线程: String(ort.env.wasm.numThreads), 隔离模式: crossOriginIsolated ? '是' : '否', 连接: isSecureContext ? 'HTTPS' : 'HTTP' })
void restoreSelectedFile()
