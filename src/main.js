import * as ort from 'onnxruntime-web/wasm'
import './style.css'
import { createRuleEngine } from './rules.js'
import { gaussianBlur, grayFromRgb, grayFromRgb8 } from './imaging.js'

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
let ruleEngine = null
let ruleEnginePromise = null
let detectedRegions = []
let analysis = null

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

/** 读出一张图片的像素数据（原尺寸），供规则与后续推理使用 */
function readImageData(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
  return imageData
}

/** 分析图片：调用规则引擎给出待修复区域 */
async function analyzeImage() {
  const width = elements.source.width
  const height = elements.source.height
  const imageData = readImageData(elements.source)
  const rgba = imageData.data
  const gray = grayFromRgb(rgba, width, height)
  const gray8 = grayFromRgb8(rgba, width, height)
  const engine = await getRuleEngine()
  const regions = engine.detect({ rgba, gray, gray8, width, height })
  analysis = { width, height, rgba, gray, regions }
  detectedRegions = regions
  return regions
}

/** 把某个区域的掩膜映射到窗口坐标系（1:1 像素），返回 Float32 掩膜 */
function regionMaskInWindow(region, window) {
  const mask = new Float32Array(window.width * window.height)
  const regionMaskWidth = region.maskWidth || region.width
  const regionMaskHeight = region.maskHeight || region.height
  for (let y = 0; y < regionMaskHeight; y++) {
    const imageY = region.y + y
    const windowY = imageY - window.y
    if (windowY < 0 || windowY >= window.height) continue
    for (let x = 0; x < regionMaskWidth; x++) {
      const imageX = region.x + x
      const windowX = imageX - window.x
      if (windowX < 0 || windowX >= window.width) continue
      const value = region.mask ? region.mask[y * regionMaskWidth + x] : 255
      mask[windowY * window.width + windowX] = value > 0 ? 1 : 0
    }
  }
  return mask
}

/** 计算以区域为中心的方形窗口（完全落在图内） */
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

/** 把 512×512 的模型输出按掩膜羽化回写到一个区域窗口 */
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

  // 原图窗口（用于羽化合成）
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

  const sigma = 1.6
  const blurred = gaussianBlur(maskInWindow, window_.width, window_.height, sigma)
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

  const targetContext = target.getContext('2d')
  targetContext.drawImage(windowCanvas, window_.x, window_.y)
  return targetContext
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

function baseMetrics() {
  return {
    图片: sourceBitmap ? `${sourceBitmap.width} × ${sourceBitmap.height}` : '未选择',
    模型: selectedModel().label,
    线程: String(ort.env.wasm.numThreads),
    隔离模式: crossOriginIsolated ? '是' : '否',
  }
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
    elements.run.disabled = true
    setStatus('正在识别水印', null, '本地规则，不上传图片')
    await new Promise(resolve => setTimeout(resolve, 0))
    const regions = await analyzeImage()
    elements.run.disabled = false
    setMetrics({
      ...baseMetrics(),
      识别结果: regions.length
        ? [...new Set(regions.map(region => region.provider))].join('、')
        : '未识别',
      区域数: String(regions.length),
    })
    if (restored) setStatus('已恢复上次图片', 0, '切回 Safari 后无需重新选择')
    else setStatus('图片已就绪', 0, regions.length ? '可以开始处理' : '未发现支持的水印')
  } catch (error) {
    console.error(error)
    const hint = /图片读取失败|decode|HEIC|HEIF|image/i.test(String(error.message || ''))
      ? '（若文件名为 .JPG 但实际是 HEIC，请先在相册里导出成 PNG/JPG）'
      : ''
    setStatus(`图片读取失败：${error.message}${hint}`, 0)
  }
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
  setMetrics(baseMetrics())
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
    const regions = detectedRegions.length ? detectedRegions : await analyzeImage()
    if (!regions.length) {
      elements.result.width = sourceBitmap.width
      elements.result.height = sourceBitmap.height
      elements.result.getContext('2d').drawImage(elements.source, 0, 0)
      resultBlob = await canvasBlob(elements.result)
      if (resultUrl) URL.revokeObjectURL(resultUrl)
      resultUrl = URL.createObjectURL(resultBlob)
      elements.download.href = resultUrl
      elements.download.download = `${selectedFile.name.replace(/\.[^.]+$/, '')}-原图-未识别水印.png`
      elements.download.hidden = false
      elements.share.hidden = !navigator.share
      setStatus('未识别到支持的水印，保持原图', 0, '不会猜测位置或涂抹')
      setMetrics({ ...baseMetrics(), 识别结果: '未识别', 区域数: '0', 总耗时: `${((performance.now() - totalStarted) / 1000).toFixed(1)} 秒` })
      return
    }

    setStatus(`正在准备 ${model.label}`, 0, '请保持 Safari 在前台')
    const { session, loadMs, reused } = await getSession(model)
    const target = elements.result
    target.width = sourceBitmap.width
    target.height = sourceBitmap.height
    const targetContext = target.getContext('2d')
    targetContext.drawImage(elements.source, 0, 0)

    const timings = []
    for (let index = 0; index < regions.length; index++) {
      const region = regions[index]
      const label = `第 ${index + 1}/${regions.length} 处 · ${region.provider}`
      setStatus(`${label} 正在修复`, (index) / regions.length, '页面短暂无响应属于正常现象')
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const window_ = regionWindow(region, sourceBitmap.width, sourceBitmap.height)
      const maskInWindow = regionMaskInWindow(region, window_)
      const { image, mask } = buildInputs(target, window_, maskInWindow)
      const { feeds, tensors } = createFeeds(session, model, image, mask)
      const started = performance.now()
      const result = await session.run(feeds)
      timings.push(performance.now() - started)
      const outputTensor = result[session.outputNames[0]]
      compositeRegion(target, outputTensor.data, window_, maskInWindow)
      tensors.forEach(tensor => tensor.dispose?.())
      outputTensor.dispose?.()
    }

    resultBlob = await canvasBlob(target)
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    resultUrl = URL.createObjectURL(resultBlob)
    elements.download.href = resultUrl
    elements.download.download = `${selectedFile.name.replace(/\.[^.]+$/, '')}-${model.id}.png`
    elements.download.hidden = false
    elements.share.hidden = !navigator.share
    const providers = [...new Set(regions.map(region => region.provider))]
    setStatus('处理完成', 1, providers.join('、'))
    setMetrics({
      ...baseMetrics(),
      识别结果: providers.join('、'),
      区域数: String(regions.length),
      模型准备: reused ? '已复用' : `${(loadMs / 1000).toFixed(1)} 秒`,
      本次推理: `${(timings.reduce((sum, value) => sum + value, 0) / 1000).toFixed(1)} 秒`,
      总耗时: `${((performance.now() - totalStarted) / 1000).toFixed(1)} 秒`,
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
void getRuleEngine().catch(error => console.warn('规则引擎初始化失败', error))
void restoreSelectedFile()
