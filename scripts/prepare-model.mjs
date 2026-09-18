import { createHash } from 'node:crypto'
import { mkdir, open, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const source = process.argv[2] || '/private/tmp/lama_fp32.onnx'
const variant = process.argv[3] || 'fp32'
const variants = {
  fp32: {
    version: 'lama-fp32-c3c0c9e468934d62e79c329e35d82dd09ff8c444',
    source: 'https://huggingface.co/Carve/LaMa-ONNX',
    inputLayout: 'image-mask',
  },
  int8: {
    version: 'lama-512-int8-418036c6b541e526cdbb0bead1ec3a87dabede53',
    source: 'https://huggingface.co/g-ronimo/lama',
    inputLayout: 'masked-rgb-mask',
  },
}
const metadata = variants[variant]
if (!metadata) throw new Error(`Unknown model variant: ${variant}`)
const outputDir = path.resolve('public/models', variant)
const partSize = 16 * 1024 * 1024

await mkdir(outputDir, { recursive: true })
for (const name of await readdir(outputDir)) {
  if (name.startsWith('lama.part.') || name === 'manifest.json') {
    await rm(path.join(outputDir, name))
  }
}

const input = await open(source, 'r')
const hash = createHash('sha256')
const chunks = []
let totalSize = 0
let index = 0

try {
  while (true) {
    const buffer = Buffer.allocUnsafe(partSize)
    const { bytesRead } = await input.read(buffer, 0, partSize, null)
    if (!bytesRead) break
    const bytes = buffer.subarray(0, bytesRead)
    const file = `lama.part.${String(index).padStart(3, '0')}.bin`
    await writeFile(path.join(outputDir, file), bytes)
    hash.update(bytes)
    chunks.push({ file, size: bytesRead })
    totalSize += bytesRead
    index += 1
  }
} finally {
  await input.close()
}

const manifest = {
  ...metadata,
  license: 'Apache-2.0',
  totalSize,
  sha256: hash.digest('hex'),
  chunks,
}

await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Prepared ${chunks.length} chunks (${totalSize} bytes) in ${outputDir}`)
