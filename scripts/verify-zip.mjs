import { buildZip } from '../src/zip.js'

const entries = [
  { name: '去水印-001-测试.png', blob: new Blob([new Uint8Array([1, 2, 3, 4])]) },
  { name: '原图-002-photo.jpg', blob: new Blob([new TextEncoder().encode('jpeg-data')]) },
]
const bytes = new Uint8Array(await (await buildZip(entries)).arrayBuffer())
const view = new DataView(bytes.buffer)
const decoder = new TextDecoder()
let offset = 0
for (const expected of entries) {
  if (view.getUint32(offset, true) !== 0x04034b50) throw new Error('ZIP 本地文件头缺失')
  if ((view.getUint16(offset + 6, true) & 0x0800) === 0) throw new Error('ZIP 中文文件名缺少 UTF-8 标志')
  if (view.getUint16(offset + 8, true) !== 0) throw new Error('ZIP 应使用 STORE 方法')
  const size = view.getUint32(offset + 18, true)
  const nameLength = view.getUint16(offset + 26, true)
  const extraLength = view.getUint16(offset + 28, true)
  const name = decoder.decode(bytes.slice(offset + 30, offset + 30 + nameLength))
  if (name !== expected.name || size !== expected.blob.size) throw new Error(`ZIP 条目不匹配：${name}`)
  const dataStart = offset + 30 + nameLength + extraLength
  const actual = bytes.slice(dataStart, dataStart + size)
  const wanted = new Uint8Array(await expected.blob.arrayBuffer())
  if (actual.length !== wanted.length || actual.some((value, index) => value !== wanted[index])) {
    throw new Error(`ZIP 内容不匹配：${name}`)
  }
  offset = dataStart + size
}
if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 中央目录缺失')
if (view.getUint32(bytes.length - 22, true) !== 0x06054b50) throw new Error('ZIP 结束记录缺失')
if (view.getUint16(bytes.length - 12, true) !== entries.length) throw new Error('ZIP 条目数错误')

console.log('zip: STORE entries, UTF-8 names and payloads verified')
