import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import type { WebContents } from 'electron'

type ExtractResult = {
  title: string
  content: string
  textContent: string
  length: number
}

type NavigationResult = {
  nextUrl?: string
  prevUrl?: string
}

type TocResult = {
  isTocPage: boolean
  tocUrlCandidate?: string
  entries: Array<{ title: string; url: string }>
}

type ExtractorOptions = {
  minTextLength?: number
}

const DEFAULT_MIN_TEXT_LENGTH = 200

export class WebContentExtractor {
  private readonly minTextLength: number

  constructor(options: ExtractorOptions = {}) {
    this.minTextLength = options.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH
  }

  extractCurrentPage(url: string, html: string): ExtractResult {
    const dom = new JSDOM(html, { url })
    const reader = new Readability(dom.window.document)
    const result = reader.parse()
    if (result?.content && result.textContent?.trim().length) {
      const length = result.textContent.trim().length
      if (length >= this.minTextLength) {
        return {
          title: result.title || dom.window.document.title || '',
          content: result.content,
          textContent: result.textContent,
          length
        }
      }
    }

    const fallback = this.fallbackExtract(dom)
    if (!fallback) {
      return { title: dom.window.document.title || '', content: '', textContent: '', length: 0 }
    }
    return fallback
  }

  detectNavigation(html: string, baseUrl: string): NavigationResult {
    const dom = new JSDOM(html, { url: baseUrl })
    const { document } = dom.window

    const relLinks = Array.from(document.querySelectorAll('a[rel="next"], a[rel="prev"], link[rel="next"], link[rel="prev"]'))
    let nextUrl: string | undefined
    let prevUrl: string | undefined

    for (const link of relLinks) {
      const rel = (link.getAttribute('rel') || '').toLowerCase()
      const href = link.getAttribute('href') || ''
      if (!href) continue
      const abs = this.absUrl(baseUrl, href)
      if (rel.includes('next')) nextUrl = abs
      if (rel.includes('prev')) prevUrl = abs
    }

    const anchors = Array.from(document.querySelectorAll('a[href]'))
    const scored = anchors
      .map((a) => ({
        text: (a.textContent || '').trim(),
        url: this.absUrl(baseUrl, a.getAttribute('href') || ''),
        score: this.scoreNavLink(a, baseUrl)
      }))
      .filter((x) => x.url)
      .sort((a, b) => b.score - a.score)

    for (const item of scored) {
      if (!nextUrl && item.score >= 60 && this.isNextText(item.text)) nextUrl = item.url
      if (!prevUrl && item.score >= 60 && this.isPrevText(item.text)) prevUrl = item.url
      if (nextUrl && prevUrl) break
    }

    return { nextUrl, prevUrl }
  }

  detectTOC(url: string, html: string): TocResult {
    const dom = new JSDOM(html, { url })
    const { document } = dom.window
    const entries: Array<{ title: string; url: string }> = []

    const titleText = `${document.title || ''} ${(document.querySelector('h1')?.textContent || '')}`.toLowerCase()
    const isTocTitle = /(目录|章节|列表|catalog|toc|chapters)/i.test(titleText)

    const listCandidates = Array.from(document.querySelectorAll('ul,ol'))
      .map((list) => {
        const links = Array.from(list.querySelectorAll('a[href]'))
        const linkTexts = links.map((l) => (l.textContent || '').trim()).filter(Boolean)
        const avgLen = linkTexts.length ? linkTexts.reduce((s, t) => s + t.length, 0) / linkTexts.length : 0
        return { list, links, linkTexts, avgLen }
      })
      .filter((c) => c.links.length >= 6 && c.avgLen <= 40)

    const bestList = listCandidates.sort((a, b) => b.links.length - a.links.length)[0]
    if (bestList) {
      for (const link of bestList.links) {
        const t = (link.textContent || '').trim()
        const href = link.getAttribute('href') || ''
        if (!t || !href) continue
        entries.push({ title: t, url: this.absUrl(url, href) })
      }
    }

    const tocUrlCandidate = entries.length
      ? undefined
      : this.findTocLink(document, url)

    return {
      isTocPage: Boolean(isTocTitle || entries.length >= 6),
      tocUrlCandidate,
      entries
    }
  }

  private fallbackExtract(dom: JSDOM): ExtractResult | null {
    const { document } = dom.window
    const candidates = ['article', 'main', '#content', '.content', '.article', '.post', '.entry', '.entry-content']
    let best: Element | null = null
    let bestScore = 0

    for (const sel of candidates) {
      const nodes = Array.from(document.querySelectorAll(sel))
      for (const node of nodes) {
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim()
        if (text.length > bestScore) {
          bestScore = text.length
          best = node
        }
      }
    }

    if (!best) return null
    const textContent = (best.textContent || '').replace(/\s+/g, ' ').trim()
    return {
      title: document.title || '',
      content: best.innerHTML,
      textContent,
      length: textContent.length
    }
  }

  private scoreNavLink(link: Element, baseUrl: string): number {
    const text = (link.textContent || '').trim()
    const href = link.getAttribute('href') || ''
    const abs = this.absUrl(baseUrl, href)
    if (!abs) return 0

    let score = 0
    if (this.isNextText(text) || this.isPrevText(text)) score += 80
    if (/chapter|section|page|第\s*\d+|章|节|回/i.test(text)) score += 20
    if (this.isSamePathGroup(baseUrl, abs)) score += 25
    if (/\d+/.test(abs)) score += 10
    return score
  }

  private isNextText(text: string): boolean {
    return /(下一章|下一页|下一节|下页|下一篇|Next|Next\s*Chapter|Next\s*Page)/i.test(text)
  }

  private isPrevText(text: string): boolean {
    return /(上一章|上一页|上一节|上页|上一篇|Prev|Previous|Previous\s*Chapter)/i.test(text)
  }

  private isSamePathGroup(a: string, b: string): boolean {
    try {
      const ua = new URL(a)
      const ub = new URL(b)
      return ua.hostname === ub.hostname && ua.pathname.split('/').slice(0, -1).join('/') === ub.pathname.split('/').slice(0, -1).join('/')
    } catch {
      return false
    }
  }

  private absUrl(base: string, href: string): string {
    if (!href) return ''
    try {
      return new URL(href, base).toString()
    } catch {
      return ''
    }
  }

  private findTocLink(document: Document, baseUrl: string): string | undefined {
    const anchors = Array.from(document.querySelectorAll('a[href]'))
    for (const a of anchors) {
      const text = (a.textContent || '').trim()
      if (!text) continue
      if (/(目录|章节|章节列表|返回目录|书页|catalog|toc|chapters)/i.test(text)) {
        const href = a.getAttribute('href') || ''
        const abs = this.absUrl(baseUrl, href)
        if (abs) return abs
      }
    }
    return undefined
  }
}

export class BrowserBridge {
  constructor(private readonly webContents: WebContents) {}

  async extractWhenReady<T>(extractScript: string): Promise<T> {
    await this.waitForReady()
    return this.webContents.executeJavaScript(extractScript, true) as Promise<T>
  }

  private async waitForReady(): Promise<void> {
    if (this.webContents.isLoading()) {
      await new Promise<void>((resolve) => {
        const done = () => {
          this.webContents.removeListener('did-finish-load', done)
          resolve()
        }
        this.webContents.on('did-finish-load', done)
      })
    }
    await this.webContents.executeJavaScript(`(() => new Promise((resolve) => {
      if (document.readyState === 'complete') return resolve(true);
      const timer = setInterval(() => {
        if (document.readyState === 'complete') {
          clearInterval(timer);
          resolve(true);
        }
      }, 120);
    }))()`)
  }
}
