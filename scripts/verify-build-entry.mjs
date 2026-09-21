// 构建产物入口检查（第四项 4.4 的静态部分）。
//
// 入口固定成 assets/app.js / assets/app.css 是「缓存自救」的前提，而这个前提
// 很容易在后续改动里悄悄失效（比如有人恢复了默认的哈希入口、或某个插件又插回一个
// index-<hash>.js）。所以每次构建后都从 dist/ 实际产物上验一遍，而不是看配置。
import { readFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const read = path => readFile(join(dist, path), 'utf8')
const exists = path => access(join(dist, path)).then(() => true, () => false)

let failed = 0
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failed++
}

console.log('=== 构建产物入口检查 ===')
const html = await read('index.html')
const { version } = JSON.parse(await read('version.json'))

// 页面里所有本地资源引用（排除外链与内联 data:）
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1])
const assetRefs = refs.filter(href => href.includes('assets/'))

check('index.html 引用了稳定入口 assets/app.js',
  assetRefs.some(href => /assets\/app\.js(\?|"|$)/.test(href)),
  assetRefs.filter(href => href.includes('app.js')).join(', '))
check('index.html 引用了稳定入口 assets/app.css',
  assetRefs.some(href => /assets\/app\.css(\?|"|$)/.test(href)),
  assetRefs.filter(href => href.includes('app.css')).join(', '))
check('稳定入口带构建版本查询参数',
  assetRefs.every(href => /assets\/app\.(js|css)\?v=\d{14}$/.test(href)))
check('查询参数与 version.json 一致',
  assetRefs.filter(href => /assets\/app\./.test(href)).every(href => href.endsWith(`v=${version}`)),
  `version.json = ${version}`)
check('不再引用 index-<hash>.js / .css',
  !assetRefs.some(href => /assets\/index-[A-Za-z0-9_-]+\.(js|css)/.test(href)))

check('dist/assets/app.js 存在', await exists('assets/app.js'))
check('dist/assets/app.css 存在', await exists('assets/app.css'))
check('旧入口迁移 JS 存在（assets/index-DiAJy31j.js）', await exists('assets/index-DiAJy31j.js'))
check('旧入口迁移 CSS 存在（assets/index-BlVSS6-9.css）', await exists('assets/index-BlVSS6-9.css'))

// 迁移桥必须真的是「桥」：取 version.json + 换 URL + 兜底加载稳定入口
const bridge = await read('assets/index-DiAJy31j.js')
check('迁移桥会读取 version.json', bridge.includes('version.json'))
check('迁移桥会写 app-build 并 location.replace', bridge.includes('app-build') && bridge.includes('location.replace'))
check('迁移桥会兜底加载 assets/app.js', bridge.includes("'./app.js'") || bridge.includes('"./app.js"'))
check('迁移桥体积很小（不是旧程序本体）',
  (await readFile(join(dist, 'assets/index-DiAJy31j.js'))).byteLength < 8192,
  `${(await readFile(join(dist, 'assets/index-DiAJy31j.js'))).byteLength} 字节`)

console.log('')
if (failed) throw new Error(`构建产物入口检查有 ${failed} 项未通过`)
console.log('build-entry: 固定入口、构建版本参数与旧入口迁移桥均已就位')
