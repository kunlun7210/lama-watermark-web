import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const expected = {
  'ocr/PP-OCRv5_mobile_det_onnx_infer.tar': '781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30',
  'ocr/PP-OCRv5_mobile_rec_onnx_infer.tar': 'f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c',
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
