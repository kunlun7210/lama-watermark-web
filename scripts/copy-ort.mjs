import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'node_modules', 'onnxruntime-web', 'dist')
const target = join(root, 'public', 'ort')
await mkdir(target, { recursive: true })
for (const name of await readdir(source)) {
  if (/^ort-wasm-simd-threaded\.(mjs|wasm)$/.test(name)) {
    await copyFile(join(source, name), join(target, name))
  }
}

await copyFile(
  join(root, 'node_modules', 'coi-serviceworker', 'coi-serviceworker.min.js'),
  join(root, 'public', 'coi-serviceworker.min.js'),
)
