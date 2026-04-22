import { createSiteAdapters } from '../dist-electron/web-import/adapters/index.js'
import { detectTocCore } from '../dist-electron/web-import/core/toc-detector.js'
import { resolveNextChapterCore } from '../dist-electron/web-import/core/navigation-resolver.js'

function assert(cond, msg) {
  if (!cond) throw new Error(`SELFTEST_ASSERT_FAILED: ${msg}`)
}

function runAdapterRegistryCase() {
  const adapters = createSiteAdapters({
    isBquduChapterUrl: () => false,
    extractBquduChapterContentHtml: () => null,
    buildBquduMinimalChapterHtml: () => '',
    isWereadReaderUrl: () => false,
    extractWereadChapterContentHtml: () => null,
    buildWereadMinimalChapterHtml: () => '',
    cleanWereadReaderNoise: (text) => text,
    detectWereadReaderTOC: () => null,
    createWereadAuthRequiredError: () => new Error('auth'),
    isTaduChapterUrl: () => false,
    fetchTaduPartContentHtml: async () => null,
    buildTaduMinimalChapterHtml: () => '',
    hasTaduInjectedChapterBody: () => false,
    isJjwxcOnebookUrl: () => false,
    cleanJjwxcChapterText: (text) => text,
    isTaduUrl: () => false,
    cleanNovelReaderUiNoise: (text) => text,
    isReadnovelUrl: () => false
  })
  const ids = adapters.map((a) => a.id)
  const expected = ['bqudu-chapter', 'weread-reader', 'tadu-chapter', 'jjwxc-onebook', 'tadu-domain', 'readnovel-domain']
  assert(ids.length === expected.length, `adapter count mismatch: got=${ids.length}, expected=${expected.length}`)
  for (const id of expected) assert(ids.includes(id), `missing adapter id: ${id}`)
}

function runTocQualityCase() {
  const html = `
  <html><head><title>目录</title></head><body>
    <ul>
      <li><a href="/book/1/chapter/1">第1章 开始</a></li>
      <li><a href="/book/1/chapter/2">第2章 继续</a></li>
      <li><a href="/book/1/chapter/3">第3章 转折</a></li>
    </ul>
  </body></html>`
  const base = 'https://example.com/book/1'
  const absUrl = (b, h) => {
    try {
      return new URL(h, b).toString()
    } catch {
      return ''
    }
  }
  const fp = (u) => String(u || '').replace(/#.*$/, '')
  const toc = detectTocCore(base, html, {
    absUrl,
    urlFingerprint: fp,
    isLikelyChapterLinkText: (t) => /第\s*\d+\s*章/.test(String(t || '')),
    isLikelyChapterHref: (u) => /chapter\/\d+/.test(String(u || '')),
    findTocLink: () => undefined
  })
  assert(toc.entries.length >= 3, `toc entries too few: ${toc.entries.length}`)
  assert(toc.tocStatus === 'ready', `toc status expected ready, got=${toc.tocStatus}`)
}

function runNextDowngradeCase() {
  const resolved = resolveNextChapterCore({
    pageUrl: 'https://site.com/book/1/chapter/10',
    tocEntries: [],
    nav: {
      nextCandidates: [
        { url: 'https://site.com/book/1/chapter/11', label: '第11章', confidence: 0.62, reason: 'anchor_guess' },
        { url: 'https://site.com/book/1/chapter/12', label: '第12章', confidence: 0.58, reason: 'anchor_guess' }
      ]
    },
    urlFingerprint: (u) => String(u || '')
  })
  assert(resolved.needsConfirmation === true, 'next downgrade should require confirmation')
  assert(!resolved.nextUrl, 'next downgrade should not auto-pick nextUrl')
  assert(Array.isArray(resolved.candidates) && resolved.candidates.length >= 2, 'next downgrade candidates missing')
}

function main() {
  console.log('Running web-import core selftest...')
  runAdapterRegistryCase()
  runTocQualityCase()
  runNextDowngradeCase()
  console.log('Core selftest OK.')
}

main()
