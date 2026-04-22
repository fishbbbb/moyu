import { JSDOM } from 'jsdom'
import type { TocResult, TocSource, TocStatus } from '../types'

type TocDetectorDeps = {
  absUrl: (baseUrl: string, href: string) => string
  urlFingerprint: (url: string) => string
  isLikelyChapterLinkText: (text: string) => boolean
  isLikelyChapterHref: (url: string) => boolean
  findTocLink: (document: Document, baseUrl: string) => string | undefined
}

export function detectTocCore(url: string, html: string, deps: TocDetectorDeps): TocResult {
  const dom = new JSDOM(html, { url })
  const { document } = dom.window
  const entries: Array<{ title: string; url: string }> = []
  const seen = new Set<string>()
  const pushEntry = (title: string, href: string) => {
    const t = String(title || '').trim()
    const abs = deps.absUrl(url, href)
    if (!t || !abs) return
    const fp = deps.urlFingerprint(abs)
    if (seen.has(fp)) return
    seen.add(fp)
    entries.push({ title: t, url: abs })
  }

  const titleText = `${document.title || ''} ${(document.querySelector('h1')?.textContent || '')}`.toLowerCase()
  const isTocTitle = /(目录|章节|列表|catalog|toc|chapters)/i.test(titleText)

  const minListLinks = isTocTitle ? 3 : 6
  const listCandidates = Array.from(document.querySelectorAll('ul,ol'))
    .map((list) => {
      const links = Array.from(list.querySelectorAll('a[href]'))
      const linkTexts = links.map((l) => (l.textContent || '').trim()).filter(Boolean)
      const avgLen = linkTexts.length ? linkTexts.reduce((s, t) => s + t.length, 0) / linkTexts.length : 0
      const chapterLikeByText = linkTexts.filter((t) => deps.isLikelyChapterLinkText(t)).length
      const chapterLikeByHref = links.filter((l) => deps.isLikelyChapterHref(deps.absUrl(url, l.getAttribute('href') || ''))).length
      const qualityScore = chapterLikeByText * 3 + chapterLikeByHref * 2 + links.length
      return { list, links, avgLen, qualityScore }
    })
    .filter((c) => c.links.length >= minListLinks && c.avgLen <= 45)

  const bestList = listCandidates.sort((a, b) => b.qualityScore - a.qualityScore)[0]
  let tocSource: TocSource = 'none'
  if (bestList) {
    tocSource = 'list'
    for (const link of bestList.links) {
      const t = (link.textContent || '').trim()
      const href = link.getAttribute('href') || ''
      pushEntry(t, href)
    }
  }

  if (entries.length < 4) {
    const tableAnchors = Array.from(document.querySelectorAll('table a[href]'))
      .map((a) => ({
        t: (a.textContent || '').trim(),
        href: a.getAttribute('href') || ''
      }))
      .filter((x) => x.href && x.t && x.t.length <= 90)

    if (tableAnchors.length >= 4) {
      const before = entries.length
      for (const x of tableAnchors) pushEntry(x.t, x.href)
      if (entries.length > before) {
        if (tocSource === 'none') tocSource = 'table'
        else if (tocSource === 'list') tocSource = 'mixed'
      }
    }
  }

  if (entries.length < 4) {
    const containerSelectors = ['#chapterList', '.chapter-list', '.chapters', '.catalog', '.volume', '.mulu', 'main', 'body']
    const picked = new Set<string>()
    for (const sel of containerSelectors) {
      const root = document.querySelector(sel)
      if (!root) continue
      const anchors = Array.from(root.querySelectorAll('a[href]'))
        .map((a) => ({
          text: (a.textContent || '').trim(),
          href: a.getAttribute('href') || ''
        }))
        .filter((x) => deps.isLikelyChapterLinkText(x.text) || deps.isLikelyChapterHref(deps.absUrl(url, x.href)))
        .slice(0, 120)
      for (const a of anchors) {
        const abs = deps.absUrl(url, a.href)
        if (!abs || picked.has(deps.urlFingerprint(abs))) continue
        picked.add(deps.urlFingerprint(abs))
        pushEntry(a.text, a.href)
      }
      if (entries.length >= 6) break
    }
    if (entries.length >= 4 && tocSource === 'none') tocSource = 'mixed'
  }

  const chapterLikeEntries = entries.filter((e) => deps.isLikelyChapterHref(e.url) || deps.isLikelyChapterLinkText(e.title))
  // Prefer chapter-like candidates even when we only have a single entry.
  // Returning "all entries" when chapter-like is scarce tends to pollute nextUrl
  // inference with navigation/menu noise.
  let finalEntries = chapterLikeEntries.length >= 2 ? chapterLikeEntries : chapterLikeEntries.length === 1 ? chapterLikeEntries : entries
  const chapterLikeRatio = entries.length ? chapterLikeEntries.length / entries.length : 0

  // If we picked a noisy menu-like list first, run a global anchor rescue pass
  // and prefer chapter-like candidates to avoid locking onto nav/tool links.
  if (chapterLikeEntries.length < 2 || (entries.length >= 6 && chapterLikeRatio < 0.35)) {
    const rescued: Array<{ title: string; url: string }> = []
    const rescuedSeen = new Set<string>()
    const anchors = Array.from(document.querySelectorAll('a[href]')).slice(0, 2400)
    for (const a of anchors) {
      const title = (a.textContent || '').trim()
      const href = a.getAttribute('href') || ''
      const abs = deps.absUrl(url, href)
      if (!title || !abs) continue
      const looksChapter = deps.isLikelyChapterLinkText(title) || deps.isLikelyChapterHref(abs)
      if (!looksChapter) continue
      const fp = deps.urlFingerprint(abs)
      if (rescuedSeen.has(fp)) continue
      rescuedSeen.add(fp)
      rescued.push({ title, url: abs })
      if (rescued.length >= 120) break
    }
    if (rescued.length >= 2) {
      finalEntries = rescued
      if (tocSource === 'none') tocSource = 'mixed'
    }
  }

  const tocUrlCandidate = finalEntries.length ? undefined : deps.findTocLink(document, url)

  const tocStatus: TocStatus = finalEntries.length >= 2 ? 'ready' : finalEntries.length === 1 ? 'partial' : 'missing'

  return {
    isTocPage: Boolean(isTocTitle || finalEntries.length >= minListLinks),
    tocUrlCandidate,
    entries: finalEntries,
    tocStatus,
    tocSource
  }
}
