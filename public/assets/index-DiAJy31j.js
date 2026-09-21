/**
 * 旧入口迁移桥 —— assets/index-DiAJy31j.js
 *
 * ⚠️ 这个文件不是应用本体，**不要删**。
 *
 * 背景：v0.17.1 之前，入口文件名带内容哈希（assets/index-<hash>.js）。用户浏览器里
 * 缓存的旧 HTML 会一直引用那个哈希名，而新一次部署已经把该文件删掉 ——
 * 结果就是入口 JS 直接 404，页面白屏，连「检查版本再自动刷新」的那段代码都跑不起来。
 * 入口 JS 自己没法解决「入口 JS 已经 404」这件事（见本次修复的第四项）。
 *
 * 因此从 v0.17.1 起：
 *   · 新构建的入口固定为 assets/app.js / assets/app.css（路径永久存在）；
 *   · 新旧内容靠 URL 上的 app-build=<14 位构建版本> 区分；
 *   · 本文件钉住当前线上（v0.17.0）旧 HTML 引用的那个哈希名，作为一次性跳板。
 *
 * 它的职责只有两件事：
 *   1) 取 version.json，把页面 URL 换成带 app-build=<version> 的新地址并 location.replace；
 *      新地址是新的缓存键，必然取到新 HTML。
 *   2) 若 URL 已带同一版本（说明刚跳过来），或 version.json 取不到（网络不可用），
 *      就直接加载稳定入口 assets/app.js，绝不留白页。
 *
 * 保留策略：从引入起**至少保留数个版本**再考虑删除 —— 总有用户拿着很久以前的
 * 缓存页面回来访问。删除前请先确认线上版本早已越过迁移点。
 */
const BRIDGE_URL = import.meta.url
const APP_URL = new URL('./app.js', BRIDGE_URL)
const CSS_URL = new URL('./app.css', BRIDGE_URL)
const VERSION_URL = new URL('../version.json', BRIDGE_URL)

/** 稳定入口的样式：白页最常见的成因就是样式没到、内容其实在 DOM 里 */
function injectStylesheet(version) {
  if (document.querySelector('link[data-lama-bridge-css]')) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = version ? `${CSS_URL.href}?v=${version}` : CSS_URL.href
  link.dataset.lamaBridgeCss = '1'
  document.head.append(link)
}

/** 载入稳定入口。带版本参数才能避开 CDN 上十分钟的旧缓存 */
function startApp(version) {
  injectStylesheet(version)
  return import(version ? `${APP_URL.href}?v=${version}` : APP_URL.href)
}

async function boot() {
  let version = null
  try {
    const response = await fetch(VERSION_URL.href, { cache: 'no-store' })
    if (response.ok) version = (await response.json())?.version || null
  } catch {
    // 网络不可用/被拦：不能停在这里，下面直接进稳定入口
  }

  const url = new URL(location.href)
  if (version && url.searchParams.get('app-build') !== String(version)) {
    url.searchParams.set('app-build', String(version))
    location.replace(url.toString())
    return
  }
  await startApp(version)
}

boot().catch(error => {
  console.error('旧入口迁移失败，改为直接加载应用', error)
  return startApp(null).catch(next => console.error('应用入口加载失败', next))
})
