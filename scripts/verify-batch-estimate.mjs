/**
 * 「预计时间」移植的逐字节核对。
 *
 * 参考实现：kunlun7210/lama-watermark-web-next @ 82a737f2794950e0b06dea274da1cf30a2803276
 *           （src/main.js 的 timingSeconds / rememberTiming / updateBatchHint）
 * 固定装置：tests/estimate-reference.txt —— 上述三个函数的**原文**（24 行，一字未改）
 *
 * 这个脚本做两件事，缺一不可：
 *   ① 源码级：从 src/main.js 里把同名函数抽出来，与固定装置**逐字节**比较。
 *      只比对函数体 —— 文档注释写在函数之外，不参与比对，这样既能给维护者留说明，
 *      又保证了「跑的代码就是参考实现的代码」这一条可被机器验证。
 *   ② 行为级：把两份实现放进同一个沙箱（localStorage 用内存 shim），跑输入矩阵，
 *      逐条比对输出（文案 + 可见性 + 回写的历史值）。只比源码不比行为，是防不住
 *      「长得一样但语义被环境差异改掉」的。
 *
 * 只有 ① 通过，② 才有意义：① 证明是同一份代码，② 证明在真实输入下产生同样的结果。
 */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = join(repoRoot, 'tests/estimate-reference.txt')
const mainSource = await readFile(join(repoRoot, 'src/main.js'), 'utf8')

/** 固定装置自身的 SHA-256：文件被改动过就必须在这里显式更新，避免「悄悄改标准答案」 */
const FIXTURE_SHA256 = '3d6a3ab24c43113e52f85ef1780ad77114f896394753988699c3b7b049865c45'

/**
 * 基线记录（**冻结**的参考实现）。固定装置 tests/estimate-reference.txt 就是其中三个函数的原文。
 *
 * 之所以把常量取值也记下来：万一参考仓库后来改了实现，本脚本仍然对这份冻结基线负责 ——
 * 要不要跟进是人的决定，不该由一次自动比对悄悄改变。想复核「基线是否仍等于真身」，
 * 把参考仓库放在 <本仓>/../next-lama 或设 NEXT_REPO=… 再跑，脚本会直接读它的源码比对。
 */
const REFERENCE = {
  repo: 'kunlun7210/lama-watermark-web-next',
  commit: '82a737f2794950e0b06dea274da1cf30a2803276',
  file: 'src/main.js',
  functions: { timingSeconds: '135–141', rememberTiming: '143–147', updateBatchHint: '149–158' },
  prefixLine: '118',
  prefix: 'lama-next-seconds-',
  fixtureSha256: '3d6a3ab24c43113e52f85ef1780ad77114f896394753988699c3b7b049865c45',
}

let failed = 0
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failed++
}

/**
 * 从源码里抽出 `function <name>(` 起到与之配对的 `}` 为止的**原文**
 * （含函数名那一行，不含任何注释）。
 */
function extractFunction(source, name) {
  const marker = `function ${name}(`
  let start = source.indexOf(marker)
  while (start > 0 && source[start - 1] !== '\n') {
    start = source.indexOf(marker, start + 1)
  }
  if (start < 0) throw new Error(`源码里找不到 function ${name}(`)
  let i = source.indexOf('{', start)
  let depth = 0
  for (; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`function ${name} 的大括号没有配平`)
}

/** 逐字节比较，返回 null 或首个差异的描述 */
function firstDifference(a, b) {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) {
    return `字节数不同：${bufA.length} vs ${bufB.length}`
  }
  for (let i = 0; i < bufA.length; i++) {
    if (bufA[i] !== bufB[i]) {
      const line = a.slice(0, i).split('\n').length
      return `第 ${line} 行第 ${i - a.lastIndexOf('\n', i - 1)} 个字节不同：0x${bufA[i].toString(16)} vs 0x${bufB[i].toString(16)}`
    }
  }
  return null
}

/* ---------- ① 源码级：逐字节 ---------- */
console.log('=== ① 与参考实现逐字节比对（源码级）===')

const fixture = await readFile(fixturePath, 'utf8')
const fixtureSha = createHash('sha256').update(fixture).digest('hex')
check('固定装置哈希与记录一致（标准答案未被篡改）', fixtureSha === REFERENCE.fixtureSha256, fixtureSha.slice(0, 16) + '…')

const FUNCTIONS = ['timingSeconds', 'rememberTiming', 'updateBatchHint']
const referenceTexts = {}
const portedTexts = {}

for (const name of FUNCTIONS) {
  referenceTexts[name] = extractFunction(fixture, name)
  portedTexts[name] = extractFunction(mainSource, name)
  const diff = firstDifference(referenceTexts[name], portedTexts[name])
  const sha = createHash('sha256').update(portedTexts[name]).digest('hex').slice(0, 16)
  check(`function ${name} 与参考实现逐字节相同`, diff === null, diff || `${portedTexts[name].split('\n').length} 行 · sha256 ${sha}…`)
}

/**
 * 抽取 TIMING_KEY_PREFIX 的取值。
 * 这是本次移植**唯一**允许与参考实现不同的地方（见 src/main.js 里的说明），
 * 所以它必须被显式抽出来参与行为比对 —— 否则两边各用各的键，沙箱会读不到历史值。
 */
function extractPrefix(source) {
  const matched = source.match(/const TIMING_KEY_PREFIX = '([^']*)'/)
  return matched ? matched[1] : null
}
const referencePrefix = REFERENCE.prefix
const portedPrefix = extractPrefix(mainSource)
check('本仓键前缀已按既有约定命名', portedPrefix === 'lama-seconds-', `参考 ${referencePrefix} → 本仓 ${portedPrefix}`)
check('两站不同源时不会互相污染（两处前缀必须不同）', portedPrefix !== referencePrefix)

/* 可选的「对真身复核」：参考仓库在场时，直接读它的源码再核一遍基线是否仍成立。
   CI 里没有这个仓库，会自动跳过（跳过不等于通过，因此这里只打印，不计入失败数）。 */
const nextRepo = process.env.NEXT_REPO || join(repoRoot, '..', 'next-lama')
try {
  const nextSource = await readFile(join(nextRepo, REFERENCE.file), 'utf8')
  const nextPrefix = extractPrefix(nextSource)
  const diffs = FUNCTIONS
    .map(name => [name, firstDifference(extractFunction(nextSource, name), referenceTexts[name])])
    .filter(([, diff]) => diff)
  const same = diffs.length === 0 && nextPrefix === referencePrefix
  console.log(`  ${same ? '✓' : '!'} 复核参考仓库真身（${nextRepo}）—— ${same ? '与冻结基线一致' : `不一致：${JSON.stringify(diffs)} prefix=${nextPrefix}`}`)
} catch {
  console.log(`  · 参考仓库不在本机（${nextRepo}），跳过真身复核；冻结基线仍然有效`)
}

/* ---------- 行为矩阵 ---------- */
console.log('\n=== ② 行为矩阵比对（同一沙箱，两份实现各跑一遍）===')

/** 用内存版 localStorage 建一个沙箱，把抽出来的函数源码塞进去跑 */
function makeSandbox(functionTexts, { prefix, stored = {}, initialCount = 3 } = {}) {
  const store = new Map(Object.entries(stored))
  const localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  }
  const written = []
  const hint = { textContent: '', hidden: true }
  const state = { items: Array.from({ length: initialCount }, () => ({ status: 'pending' })) }
  const elements = { batchHint: hint }

  const source = [
    functionTexts.timingSeconds,
    functionTexts.rememberTiming,
    functionTexts.updateBatchHint,
    'return { timingSeconds, rememberTiming, updateBatchHint }',
  ].join('\n')

  // ⚠️ TIMING_KEY_PREFIX 必须作为参数传进来。漏了它，函数内部的模板字符串会抛
  // ReferenceError，而两处都写了 try/catch —— 于是静默退回 fallback 值，
  // 两边"看起来一致"，实际上存储路径一次都没被跑到（这是本脚本初版踩过的坑：
  // 80 次比对全绿，却全是两条回退分支在对齐）。下面的守卫断言专门盯这件事。
  const factory = new Function(
    'localStorage', 'state', 'elements', 'needsProcessing', 'selectedModel', 'MODELS', 'TIMING_KEY_PREFIX',
    source,
  )
  const api = factory(
    {
      getItem: key => localStorage.getItem(key),
      setItem: (key, value) => { written.push([key, String(value)]); localStorage.setItem(key, value) },
      removeItem: key => localStorage.removeItem(key),
    },
    state,
    elements,
    item => item.status === 'pending',
    () => API_MODEL,
    {},
    prefix,
  )
  return { api, hint, store, written }
}

// 沙箱里 selectedModel() 要按每个用例切换，用闭包变量承接
let API_MODEL = { id: 'int8' }

/** 每个用例只描述「逻辑历史值」，写入时再按各自的前缀拼键 —— 两边才可比 */
const storedFor = (prefix, raw) => (raw === null
  ? {}
  : Object.fromEntries(Object.entries(raw).map(([model, value]) => [`${prefix}${model}`, value])))

/* 防退化守卫：存储读取一旦被环境问题破坏，两个实现都会静默走回退值，比对就会假绿。
   这里钉住「有历史时必须用历史」，让这类问题直接红掉。 */
{
  API_MODEL = { id: 'int8' }
  const raw = { int8: '12.5' }
  const ref = makeSandbox(referenceTexts, { prefix: referencePrefix, stored: storedFor(referencePrefix, raw) })
  const mine = makeSandbox(portedTexts, { prefix: portedPrefix, stored: storedFor(portedPrefix, raw) })
  check(
    '守卫：有历史值时确实读的是历史值（而不是静默回退）',
    ref.api.timingSeconds('int8') === 12.5 && mine.api.timingSeconds('int8') === 12.5,
    `参考 ${ref.api.timingSeconds('int8')} · 本仓 ${mine.api.timingSeconds('int8')}`,
  )
  check(
    '守卫：没有历史值时确实回退到 16（int8）/ 40（fp32）',
    mine.api.timingSeconds('fp32') === 40,
    `int8=${mine.api.timingSeconds('int8')} · fp32=${mine.api.timingSeconds('fp32')}（int8 上面已种 12.5）`,
  )
}

const MATRIX = [
  // 历史值：无 / 空串 / 0 / 负数 / NaN / 非数字 / 正常 / 小数 / 极大
  { label: 'int8 · 无历史', model: 'int8', raw: null, counts: [1, 2, 5, 40, 0] },
  { label: 'int8 · 历史为空串', model: 'int8', raw: { int8: '' }, counts: [2, 5] },
  { label: 'int8 · 历史为 0', model: 'int8', raw: { int8: '0' }, counts: [2, 5] },
  { label: 'int8 · 历史为负数', model: 'int8', raw: { int8: '-3' }, counts: [2] },
  { label: 'int8 · 历史为垃圾串', model: 'int8', raw: { int8: 'abc' }, counts: [2] },
  { label: 'int8 · 历史为 NaN', model: 'int8', raw: { int8: 'NaN' }, counts: [2] },
  { label: 'int8 · 8 秒（截图场景）', model: 'int8', raw: { int8: '8' }, counts: [1, 2, 5, 7, 8, 40] },
  { label: 'int8 · 24 秒（用户场景）', model: 'int8', raw: { int8: '24' }, counts: [1, 2, 5] },
  { label: 'int8 · 小数 7.5 秒', model: 'int8', raw: { int8: '7.5' }, counts: [1, 2, 3, 8] },
  { label: 'int8 · 30 秒（分钟边界）', model: 'int8', raw: { int8: '30' }, counts: [1, 2, 3] },
  { label: 'int8 · 59 秒', model: 'int8', raw: { int8: '59' }, counts: [1, 2] },
  { label: 'int8 · 60 秒', model: 'int8', raw: { int8: '60' }, counts: [1, 2] },
  { label: 'int8 · 极慢 600 秒', model: 'int8', raw: { int8: '600' }, counts: [1, 3] },
  { label: 'fp32 · 无历史（回退 40）', model: 'fp32', raw: null, counts: [1, 2, 5] },
  { label: 'fp32 · 有历史', model: 'fp32', raw: { fp32: '35' }, counts: [2, 5] },
  { label: '未知模型 id · 回退 16', model: 'weird', raw: null, counts: [2] },
  { label: '两模型各自的历史互不串台', model: 'fp32', raw: { int8: '8', fp32: '35' }, counts: [2, 5] },
]

let comparisons = 0
let mismatches = 0
for (const row of MATRIX) {
  for (const count of row.counts) {
    API_MODEL = { id: row.model }
    const ref = makeSandbox(referenceTexts, { prefix: referencePrefix, stored: storedFor(referencePrefix, row.raw), initialCount: 3 })
    const mine = makeSandbox(portedTexts, { prefix: portedPrefix, stored: storedFor(portedPrefix, row.raw), initialCount: 3 })

    ref.api.updateBatchHint(count)
    mine.api.updateBatchHint(count)
    comparisons++

    // 写入键里各自的前缀归一化成一个占位符：本次移植**唯一**允许的差异就是这处取名，
    // 归一化之后剩下的每一个字节都必须相同（数值、toFixed 的位数、文案、可见性）。
    const normalize = (entries, prefix) => entries.map(([key, value]) => [key.split(prefix).join('<PREFIX>'), value])

    const refOut = JSON.stringify({ hidden: ref.hint.hidden, text: ref.hint.textContent, written: normalize(ref.written, referencePrefix) })
    const mineOut = JSON.stringify({ hidden: mine.hint.hidden, text: mine.hint.textContent, written: normalize(mine.written, portedPrefix) })
    if (refOut !== mineOut) {
      mismatches++
      console.log(`  ✗ ${row.label} · ${count} 张\n      参考：${refOut}\n      本仓：${mineOut}`)
    }

    // 顺带跑一次 rememberTiming：写回值也必须一致（同样归一化前缀）
    ref.api.rememberTiming(row.model, 9.31)
    mine.api.rememberTiming(row.model, 9.31)
    comparisons++
    const refTiming = JSON.stringify(normalize(ref.written, referencePrefix))
    const mineTiming = JSON.stringify(normalize(mine.written, portedPrefix))
    if (refTiming !== mineTiming) {
      mismatches++
      console.log(`  ✗ ${row.label} · rememberTiming 写回值不同\n      参考：${refTiming}\n      本仓：${mineTiming}`)
    }
  }
}
check('全部矩阵用例输出逐字节一致（前缀归一化后）', mismatches === 0, `${comparisons} 次比对，${mismatches} 处不同`)

/* 整段守卫：把 main.js 里被两个标记夹住的那一整段原文，与参考实现原文整体比对。
   ① 只证明「三个函数各自相同」，这条更进一步 —— 证明这一段里**没有多出任何东西**
   （多一个函数、多一行赋值、少一个空行，都会在这里露出来）。 */
{
  const startMarker = 'function timingSeconds('
  const endMarker = '/* ↑↑↑ 预计时间'
  const start = mainSource.indexOf(startMarker)
  const end = mainSource.indexOf(endMarker)
  const block = start >= 0 && end > start ? mainSource.slice(start, end).trimEnd() : null
  const expected = fixture.trimEnd()
  const diff = block === null ? '找不到移植段标记' : firstDifference(expected, block)
  check(
    '移植段整段原文 == 参考实现原文（无多、无少）',
    diff === null,
    diff || `${block.split('\n').length} 行逐字节一致`,
  )
}

/* ---------- ③ 验收样例（截图 / 用户消息里的原话） ---------- */
console.log('\n=== ③ 验收样例（必须与参考版显示的原话一致）===')

const sample = (model, seconds, count) => {
  API_MODEL = { id: model }
  const raw = seconds === null ? null : { [model]: String(seconds) }
  const box = makeSandbox(portedTexts, { prefix: portedPrefix, stored: storedFor(portedPrefix, raw), initialCount: 3 })
  box.api.updateBatchHint(count)
  return box.hint
}

const caseA = sample('int8', 8, 2)
check(
  '2 张 · 每张 8 秒 → 「2 张预计 约 16 秒；请保持页面在前台，每完成一张会立即保存。」',
  caseA.textContent === '2 张预计 约 16 秒；请保持页面在前台，每完成一张会立即保存。' && caseA.hidden === false,
  JSON.stringify(caseA.textContent),
)

const caseB = sample('int8', 24, 5)
check(
  '5 张 · 每张 24 秒 → 「5 张预计 约 2 分钟；请保持页面在前台，每完成一张会立即保存。」',
  caseB.textContent === '5 张预计 约 2 分钟；请保持页面在前台，每完成一张会立即保存。' && caseB.hidden === false,
  JSON.stringify(caseB.textContent),
)

const caseC = sample('int8', 8, 0)
check('0 张 → 隐藏且不改文案', caseC.hidden === true, JSON.stringify(caseC.hidden))

const caseD = sample('int8', 16, 1)
check('1 张 · 每张 16 秒（回退值）→ 「约 16 秒」', caseD.textContent.includes('1 张预计 约 16 秒；'), JSON.stringify(caseD.textContent))

/* ---------- 结果 ---------- */
console.log('')
if (failed) {
  console.error(`❌ 预计时间核对未通过：${failed} 项`)
  process.exit(1)
}
console.log('✅ 预计时间移植核对通过：三个函数与参考实现逐字节相同，行为矩阵与验收样例全部一致')
