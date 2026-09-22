// v0.4.3 -> stable entry filename migration bridge.
// The previous GitHub Pages HTML referenced this exact file. Keep this small module so a
// cached copy of that HTML can still reach the current app after later deployments.
const base = new URL('../', import.meta.url)
let version = ''
try {
  const response = await fetch(new URL('version.json', base), { cache: 'no-store' })
  if (response.ok) version = String((await response.json()).version || '')
} catch { /* Offline: fall through to the stable entry without a version query. */ }

if (version) {
  const page = new URL(location.href)
  if (page.searchParams.get('app-build') !== version) {
    page.searchParams.set('app-build', version)
    location.replace(page.href)
  } else {
    await import(new URL(`assets/app.js?v=${encodeURIComponent(version)}`, base).href)
  }
} else {
  const stylesheet = document.createElement('link')
  stylesheet.rel = 'stylesheet'
  stylesheet.href = new URL('assets/app.css', base).href
  document.head.append(stylesheet)
  await import(new URL('assets/app.js', base).href)
}
