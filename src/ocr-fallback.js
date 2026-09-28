// Only loaded after the existing, calibrated platform detectors find nothing.
// The OCR worker is disposed before LaMa starts to keep peak iPhone memory down.
import { claheCanvas } from './clahe.js'

const MODEL_FILES = {
  textDetectionModelName: 'PP-OCRv6_small_det',
  textRecognitionModelName: 'PP-OCRv6_small_rec',
}
const PLATFORM_NAMES = ['豆包', '即梦', '千问', '清言', '元宝', '文心', 'GEMINI']

export function normalizedWatermarkText(text) {
  return String(text || '').normalize('NFKC').toUpperCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

export function watermarkKind(text) {
  const normalized = normalizedWatermarkText(text)
  if (/小红书号[0-9]{3,}/u.test(normalized)) return '小红书'
  // A short, isolated brand label in a watermark corner is useful when the
  // lighter "AI生成" suffix was lost to OCR. Do not match names inside prose.
  for (const name of PLATFORM_NAMES) {
    if (normalized === name || normalized === `${name}AI` || normalized === `${name}生成` || normalized === `${name}AI生成`) {
      return name === 'GEMINI' ? 'Gemini' : name
    }
  }
  if (/AI生成/u.test(normalized)) return 'AI生成'
  return null
}

function itemBounds(item) {
  const points = item.poly || []
  if (!points.length) return null
  const xs = points.map(point => point[0])
  const ys = points.map(point => point[1])
  if (![...xs, ...ys].every(Number.isFinite)) return null
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, right: Math.max(...xs), bottom: Math.max(...ys) }
}

function sameLine(left, right) {
  const height = Math.max(left.bottom - left.y, right.bottom - right.y)
  const centerGap = Math.abs((left.y + left.bottom - right.y - right.bottom) / 2)
  const horizontalGap = Math.max(left.x - right.right, right.x - left.right, 0)
  return centerGap <= height * 0.55 && horizontalGap <= height * 2.5
}

export function ocrItemsToRegions(items, offsetX, offsetY, imageWidth, imageHeight) {
  const lines = []
  for (const item of items || []) {
    if (!item?.text || !Number.isFinite(item.score) || item.score < 0.45) continue
    const bounds = itemBounds(item)
    if (!bounds) continue
    const line = lines.find(candidate => sameLine(candidate, bounds))
    if (line) {
      line.items.push({ text: item.text, ...bounds })
      line.x = Math.min(line.x, bounds.x)
      line.y = Math.min(line.y, bounds.y)
      line.right = Math.max(line.right, bounds.right)
      line.bottom = Math.max(line.bottom, bounds.bottom)
    } else {
      lines.push({ ...bounds, items: [{ text: item.text, ...bounds }] })
    }
  }

  const regions = []
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x)
    const text = line.items.map(item => item.text).join('')
    const kind = watermarkKind(text)
    if (!kind) continue
    let { x: lineX, y: lineY, right: lineRight, bottom: lineBottom } = line
    if (kind === '小红书') {
      // Some exports place the badge above the account-number line.
      const brand = lines.find(candidate => candidate !== line
        && normalizedWatermarkText(candidate.items.map(item => item.text).join('')) === '小红书'
        && candidate.bottom <= line.y
        && line.y - candidate.bottom <= (line.bottom - line.y) * 2
        && candidate.right >= line.x - (line.bottom - line.y) * 2)
      if (brand) {
        lineX = Math.min(lineX, brand.x)
        lineY = Math.min(lineY, brand.y)
        lineRight = Math.max(lineRight, brand.right)
        lineBottom = Math.max(lineBottom, brand.bottom)
      }
    }
    const height = Math.max(1, line.bottom - line.y)
    // If OCR only read the shared suffix, include space for a preceding platform name.
    const prefix = kind === 'AI生成' && normalizedWatermarkText(text) === 'AI生成' ? height * 3.5 : 0
    const pad = Math.max(3, Math.round(height * 0.35))
    const x = Math.max(0, Math.floor(offsetX + lineX - pad - prefix))
    const y = Math.max(0, Math.floor(offsetY + lineY - pad))
    const right = Math.min(imageWidth, Math.ceil(offsetX + lineRight + pad))
    const bottom = Math.min(imageHeight, Math.ceil(offsetY + lineBottom + pad))
    if (right <= x || bottom <= y) continue
    if ((right - x) > imageWidth * 0.5 || (bottom - y) > imageHeight * 0.2) continue
    regions.push({
      found: true,
      provider: kind,
      method: 'ocr-fallback',
      text,
      x, y, width: right - x, height: bottom - y,
      context: Math.max(64, Math.round(height * 3)),
      repairPadding: Math.max(2, Math.round(height * 0.15)),
    })
  }
  return regions
}

function cornerCrop(source, right, bottom) {
  const width = Math.min(source.width, Math.max(320, Math.round(source.width * 0.35)))
  const height = Math.min(source.height, Math.max(160, Math.round(source.height * 0.16)))
  const x = right ? source.width - width : 0
  const y = bottom ? source.height - height : 0
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d').drawImage(source, x, y, width, height, 0, 0, width, height)
  return { canvas, x, y }
}

export async function detectOcrFallback(source, assetBase, ortBase) {
  const { PaddleOCR } = await import('@paddleocr/paddleocr-js')
  const ocr = await PaddleOCR.create({
    lang: 'ch',
    ocrVersion: 'PP-OCRv6',
    worker: true,
    ...MODEL_FILES,
    textDetectionModelAsset: { url: new URL('ocr/PP-OCRv6_small_det_onnx_infer.tar', assetBase).href },
    textRecognitionModelAsset: { url: new URL('ocr/PP-OCRv6_small_rec_onnx_infer.tar', assetBase).href },
    ortOptions: { backend: 'wasm', wasmPaths: ortBase, numThreads: 1, simd: true },
  })
  try {
    const corners = [[true, true], [false, true], [true, false], [false, false]]
    // Prefer unmodified pixels. CLAHE is a second pass for faint corner text.
    for (const enhance of [false, true]) {
      for (const [right, bottom] of corners) {
        const crop = cornerCrop(source, right, bottom)
        const [result] = await ocr.predict(enhance ? claheCanvas(crop.canvas) : crop.canvas)
        const regions = ocrItemsToRegions(result.items, crop.x, crop.y, source.width, source.height)
        if (regions.length) return regions
      }
    }
    return []
  } finally {
    await ocr.dispose()
  }
}
