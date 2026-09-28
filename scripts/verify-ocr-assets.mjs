import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const expected = {
  'ocr/PP-OCRv6_small_det_onnx_infer.tar': 'd218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4',
  'ocr/PP-OCRv6_small_rec_onnx_infer.tar': 'd267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1',
  'ort/ort-wasm-simd-threaded.jsep.mjs': '33949a3310b723a3ee14dc2da989e55060de26a75e2346095a150a042c9aad4e',
  'ort/ort-wasm-simd-threaded.jsep.wasm': '411b39a77bb006ce0cf17b30c978c66a130ebb2ba39c8dfdbdc9c1c5a251ae76',
}

for (const [path, digest] of Object.entries(expected)) {
  const publicBytes = await readFile(new URL(`../public/${path}`, import.meta.url))
  const distBytes = await readFile(new URL(`../dist/${path}`, import.meta.url))
  assert.equal(createHash('sha256').update(publicBytes).digest('hex'), digest, `public/${path}`)
  assert.equal(createHash('sha256').update(distBytes).digest('hex'), digest, `dist/${path}`)
}

console.log('OCR 模型和 WASM 资源哈希校验通过')
