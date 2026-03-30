import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import type { WebContents } from 'electron'

type ExtractResult = {
  title: string
  content: string
  textContent: string
  length: number
  source?: 'structured' | 'readability' | 'heuristic' | 'manual'
}

export type ExtractErrorCode =
  | 'AUTH_REQUIRED'
  | 'PAYWALL_BLOCKED'
  | 'ANTI_BOT_OR_BLOCKED'
  | 'TOC_PAGE_SUSPECT'
  | 'PAGINATION_DETECTED'
  | 'FONT_OBFUSCATED'
  | 'IFRAME_CROSS_ORIGIN'
  | 'SITE_NOT_FOUND'
  | 'CONTENT_REMOVED'
  | 'EXTRACTION_TIMEOUT'
  | 'DOM_TOO_LARGE'
  | 'NO_MAIN_CONTENT'

export class ExtractError extends Error {
  readonly code: ExtractErrorCode

  constructor(code: ExtractErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'ExtractError'
  }
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
  keepImages?: boolean
}

const DEFAULT_MIN_TEXT_LENGTH = 200

export class WebContentExtractor {
  private readonly minTextLength: number
  private readonly keepImages: boolean

  constructor(options: ExtractorOptions = {}) {
    this.minTextLength = options.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH
    this.keepImages = Boolean(options.keepImages ?? false)
  }

  extractCurrentPage(url: string, html: string): ExtractResult {
    const dom = new JSDOM(html, { url })
    const blocked = this.detectBlockedState(dom)
    if (blocked) throw blocked

    const structured = this.extractStructuredData(dom)
    if (structured && structured.length >= this.minTextLength) {
      this.validateExtractedContent(structured, dom, url)
      return { ...this.sanitizeExtractResult(structured), source: 'structured' }
    }

    const readability = this.extractWithReadability(dom)
    if (readability && readability.length >= this.minTextLength) {
      this.validateExtractedContent(readability, dom, url)
      return { ...this.sanitizeExtractResult(readability), source: 'readability' }
    }

    const fallback = this.fallbackExtract(dom)
    if (fallback && fallback.length >= this.minTextLength) {
      this.validateExtractedContent(fallback, dom, url)
      return { ...this.sanitizeExtractResult(fallback), source: 'heuristic' }
    }

    const blockedAfter = this.detectBlockedState(dom)
    if (blockedAfter) throw blockedAfter
    throw new ExtractError('NO_MAIN_CONTENT', '未识别到可导入正文，请切换章节页或使用手动框选。')
  }

  extractFromSelectedHtml(url: string, selectedHtml: string, title = ''): ExtractResult {
    const wrapped = `<html><head><title>${this.escapeHtml(title)}</title></head><body>${selectedHtml || ''}</body></html>`
    const dom = new JSDOM(wrapped, { url })
    const cleaned = this.cleanNodeForText(dom.window.document.body)
    const textContent = this.normalizeText(cleaned.textContent || '')
    return {
      title: title || dom.window.document.title || '',
      content: this.sanitizeHtml(cleaned.innerHTML || ''),
      textContent,
      length: textContent.length,
      source: 'manual'
    }
  }

  private sanitizeExtractResult(result: ExtractResult): ExtractResult {
    const content = this.sanitizeHtml(result.content || '')
    const textContent = this.normalizeText(this.htmlToText(content))
    return {
      ...result,
      content,
      textContent,
      length: textContent.length
    }
  }

  private sanitizeHtml(content: string): string {
    if (!content) return ''
    const dom = new JSDOM(`<div id="__root__">${content}</div>`)
    const { document } = dom.window
    const root = document.querySelector('#__root__')
    if (!root) return ''
    const all = Array.from(root.querySelectorAll('*'))
    for (const el of all) {
      el.removeAttribute('style')
      el.removeAttribute('class')
      if (!this.keepImages && el.tagName.toLowerCase() === 'img') {
        const p = document.createElement('p')
        p.textContent = '[图片]'
        el.replaceWith(p)
      }
    }
    return root.innerHTML
  }

  private htmlToText(html: string): string {
    const dom = new JSDOM(`<div>${html || ''}</div>`)
    return dom.window.document.body.textContent || ''
  }

  detectNavigation(
    html: string,
    baseUrl: string,
    options?: { seenUrlFingerprints?: string[] }
  ): NavigationResult {
    const dom = new JSDOM(html, { url: baseUrl })
    const { document } = dom.window
    const seen = new Set(options?.seenUrlFingerprints ?? [])
    seen.add(this.urlFingerprint(baseUrl))

    const relLinks = Array.from(document.querySelectorAll('a[rel="next"], a[rel="prev"], link[rel="next"], link[rel="prev"]'))
    let nextUrl: string | undefined
    let prevUrl: string | undefined

    for (const link of relLinks) {
      const rel = (link.getAttribute('rel') || '').toLowerCase()
      const href = link.getAttribute('href') || ''
      if (!href) continue
      const abs = this.absUrl(baseUrl, href)
      if (!abs || seen.has(this.urlFingerprint(abs))) continue
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
      .filter((x) => x.url && !seen.has(this.urlFingerprint(x.url)))
      .sort((a, b) => b.score - a.score)

    const inferred = this.inferNextPrevByUrlPattern(
      baseUrl,
      scored.map((s) => s.url)
    )
    if (!nextUrl && inferred.nextUrl) nextUrl = inferred.nextUrl
    if (!prevUrl && inferred.prevUrl) prevUrl = inferred.prevUrl

    for (const item of scored) {
      if (!nextUrl && item.score >= 60 && this.isNextText(item.text)) nextUrl = item.url
      if (!prevUrl && item.score >= 60 && this.isPrevText(item.text)) prevUrl = item.url
      if (nextUrl && prevUrl) break
    }

    if (!nextUrl) {
      const pg = this.detectPaginationHint(document, baseUrl)
      if (pg.nextPageUrl && !seen.has(this.urlFingerprint(pg.nextPageUrl))) nextUrl = pg.nextPageUrl
    }

    if (nextUrl && seen.has(this.urlFingerprint(nextUrl))) nextUrl = undefined
    if (prevUrl && seen.has(this.urlFingerprint(prevUrl))) prevUrl = undefined

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
    const best = this.findBestDensityCandidate(dom.window.document)
    if (!best) return null
    const cleaned = this.cleanNodeForText(best)
    const textContent = this.normalizeText(cleaned.textContent || '')
    return {
      title: dom.window.document.title || '',
      content: cleaned.innerHTML,
      textContent,
      length: textContent.length
    }
  }

  private extractStructuredData(dom: JSDOM): ExtractResult | null {
    const { document } = dom.window
    const titleFromMeta =
      document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ||
      document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')?.trim() ||
      ''
    const descFromMeta =
      document.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim() ||
      document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ||
      document.querySelector('meta[name="twitter:description"]')?.getAttribute('content')?.trim() ||
      ''

    const jsonLdNodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    const bodies: string[] = []
    for (const node of jsonLdNodes) {
      const text = (node.textContent || '').trim()
      if (!text) continue
      try {
        const parsed = JSON.parse(text)
        this.collectStructuredText(parsed, bodies)
      } catch {
        // ignore malformed JSON-LD
      }
    }

    const textContent = this.normalizeText([...(bodies || []), descFromMeta].filter(Boolean).join('\n\n'))
    if (!textContent) return null

    const content = textContent
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<p>${this.escapeHtml(line)}</p>`)
      .join('')

    return {
      title: titleFromMeta || document.title || '',
      content,
      textContent,
      length: textContent.length
    }
  }

  private detectBlockedState(dom: JSDOM): ExtractError | null {
    const { document } = dom.window
    const bodyText = this.normalizeText(document.body?.textContent || '')
    const textLower = bodyText.toLowerCase()

    // Anti-bot / captcha detection first (more explicit than auth/paywall)
    if (this.isAntiBotPage(document, textLower)) {
      return new ExtractError('ANTI_BOT_OR_BLOCKED', '检测到验证码或访问限制，请在网页中完成验证后重试。')
    }

    if (this.isSiteNotFoundPage(document, textLower)) {
      return new ExtractError('SITE_NOT_FOUND', '页面不存在或站点返回 404，请检查链接是否正确。')
    }

    if (this.isContentRemovedPage(document, textLower)) {
      return new ExtractError('CONTENT_REMOVED', '内容可能因版权或下架不可访问，请更换来源页。')
    }

    if (this.isAuthRequiredPage(document, textLower)) {
      return new ExtractError('AUTH_REQUIRED', '请先在网页中登录，再点击提取。')
    }

    if (this.isPaywallBlockedPage(document, textLower)) {
      return new ExtractError('PAYWALL_BLOCKED', '本章需购买或订阅，完成购买后请点击刷新重试。')
    }
    return null
  }

  private validateExtractedContent(result: ExtractResult, dom: JSDOM, baseUrl: string): void {
    const { document } = dom.window
    const text = this.normalizeText(result.textContent || '')
    if (!text) return

    if (this.isLikelyDirectoryPage(document, text)) {
      throw new ExtractError('TOC_PAGE_SUSPECT', '提取结果疑似目录页（链接列表占比过高），请切换到章节正文页再提取。')
    }

    const pg = this.detectPaginationHint(document, baseUrl)
    if (pg.hasPagination && pg.nextPageUrl) {
      throw new ExtractError('PAGINATION_DETECTED', '检测到分页内容（如 1/2、2/2），请切换单页阅读或翻到下一分页后重试提取。')
    }

    if (this.isLikelyFontObfuscated(text)) {
      throw new ExtractError('FONT_OBFUSCATED', '检测到乱码率过高，疑似字体加密，当前版本暂无法解析。')
    }

    if (this.isCrossOriginIframeLikelyMain(document, baseUrl, text)) {
      throw new ExtractError('IFRAME_CROSS_ORIGIN', '正文可能位于跨域 iframe 中，建议在 iframe 源页面打开后再提取。')
    }
  }

  private isAuthRequiredPage(document: Document, textLower: string): boolean {
    const hasAuthForm =
      document.querySelector('input[type="password"]') !== null ||
      document.querySelector('form[action*="login" i], form[id*="login" i], form[class*="login" i]') !== null

    const authKeywords = [
      '登录',
      '注册',
      '请先登录',
      '登录后可见',
      'sign in',
      'log in',
      'login required',
      'please login'
    ]
    const hasAuthWords = authKeywords.some((k) => textLower.includes(k.toLowerCase()))
    return hasAuthForm || hasAuthWords
  }

  private isPaywallBlockedPage(document: Document, textLower: string): boolean {
    const payKeywords = [
      'vip',
      '付费',
      '购买',
      '订阅',
      '会员',
      '解锁本章',
      '本章需购买',
      'subscribe to read',
      'members only',
      'paywall'
    ]
    const hasPayWords = payKeywords.some((k) => textLower.includes(k.toLowerCase()))
    const hasPayMask =
      document.querySelector('[class*="paywall" i], [id*="paywall" i], [class*="vip" i], [class*="subscribe" i]') !== null ||
      document.querySelector('[class*="blur" i], [style*="filter: blur" i]') !== null
    return hasPayWords || hasPayMask
  }

  private isAntiBotPage(document: Document, textLower: string): boolean {
    const antiBotKeywords = [
      '验证码',
      '滑块',
      '行为验证',
      '人机验证',
      '访问受限',
      'cloudflare',
      'are you human',
      'verify you are human',
      'challenge'
    ]
    const hasKeywords = antiBotKeywords.some((k) => textLower.includes(k.toLowerCase()))
    const hasCaptchaElement =
      document.querySelector('input[name*="captcha" i], input[id*="captcha" i]') !== null ||
      document.querySelector('[class*="captcha" i], [id*="captcha" i], iframe[src*="captcha" i]') !== null ||
      document.querySelector('[class*="slider" i][class*="verify" i], [id*="slider" i][id*="verify" i]') !== null
    return hasKeywords || hasCaptchaElement
  }

  private isSiteNotFoundPage(document: Document, textLower: string): boolean {
    const t = `${document.title || ''} ${textLower}`.toLowerCase()
    return /\b404\b/.test(t) || t.includes('not found') || t.includes('页面不存在') || t.includes('请求的页面不存在')
  }

  private isContentRemovedPage(document: Document, textLower: string): boolean {
    const t = `${document.title || ''} ${textLower}`.toLowerCase()
    const keys = ['版权', '下架', '已删除', '内容不可用', '因版权原因', 'removed', 'unavailable']
    return keys.some((k) => t.includes(k.toLowerCase()))
  }

  private isLikelyDirectoryPage(document: Document, extractedText: string): boolean {
    const anchors = Array.from(document.querySelectorAll('a[href]'))
    const linkText = this.normalizeText(anchors.map((a) => a.textContent || '').join(' '))
    const linkDensity = extractedText.length > 0 ? linkText.length / extractedText.length : 1
    const paragraphCount = document.querySelectorAll('p').length
    return anchors.length >= 18 && linkDensity >= 0.55 && paragraphCount <= 5
  }

  private detectPaginationHint(document: Document, baseUrl: string): { hasPagination: boolean; nextPageUrl?: string } {
    const anchors = Array.from(document.querySelectorAll('a[href]'))
    let nextPageUrl: string | undefined
    let hasPagination = false
    for (const a of anchors) {
      const text = this.normalizeText(a.textContent || '')
      if (!text) continue
      const href = this.absUrl(baseUrl, a.getAttribute('href') || '')
      if (!href) continue
      if (/^\d+\s*\/\s*\d+$/.test(text) || /第?\s*\d+\s*页/i.test(text)) hasPagination = true
      if (/(下一页|next\s*page|next|>>|›)/i.test(text)) {
        hasPagination = true
        if (!nextPageUrl) nextPageUrl = href
      }
    }
    return { hasPagination, nextPageUrl }
  }

  private isLikelyFontObfuscated(text: string): boolean {
    if (text.length < 120) return false
    let weird = 0
    for (const ch of text) {
      const cp = ch.codePointAt(0) || 0
      const isReplacement = ch === '\uFFFD'
      const isPrivateUse = cp >= 0xe000 && cp <= 0xf8ff
      const isNormal =
        /[\u4e00-\u9fa5a-zA-Z0-9\s，。！？、,.!?;:："'“”‘’（）()【】\[\]\-—_]/.test(ch)
      if (isReplacement || isPrivateUse || !isNormal) weird += 1
    }
    return weird / Math.max(1, text.length) >= 0.35
  }

  private isCrossOriginIframeLikelyMain(document: Document, baseUrl: string, extractedText: string): boolean {
    if (extractedText.length >= this.minTextLength) return false
    const iframes = Array.from(document.querySelectorAll('iframe[src]'))
    if (!iframes.length) return false
    const base = new URL(baseUrl)
    const cross = iframes
      .map((f) => f.getAttribute('src') || '')
      .map((src) => this.absUrl(baseUrl, src))
      .filter(Boolean)
      .filter((src) => {
        try {
          const u = new URL(src)
          return u.hostname !== base.hostname
        } catch {
          return false
        }
      })
    return cross.length > 0
  }

  private extractWithReadability(dom: JSDOM): ExtractResult | null {
    const reader = new Readability(dom.window.document)
    const result = reader.parse()
    if (!result?.content || !result.textContent?.trim().length) return null
    const textContent = this.normalizeText(result.textContent)
    return {
      title: result.title || dom.window.document.title || '',
      content: result.content,
      textContent,
      length: textContent.length
    }
  }

  private findBestDensityCandidate(document: Document): Element | null {
    const candidates = Array.from(document.querySelectorAll('article, main, section, div'))
    let best: Element | null = null
    let bestScore = 0
    for (const node of candidates) {
      const text = this.normalizeText(node.textContent || '')
      if (text.length < 80) continue
      const links = Array.from(node.querySelectorAll('a'))
      const linkTextLen = this.normalizeText(links.map((a) => a.textContent || '').join(' ')).length
      const linkDensity = text.length > 0 ? linkTextLen / text.length : 1
      const paragraphCount = node.querySelectorAll('p').length
      const sentenceCount = (text.match(/[。！？.!?]/g) || []).length
      const score = text.length * (1 - Math.min(linkDensity, 0.95)) + paragraphCount * 180 + sentenceCount * 80
      if (score > bestScore && linkDensity <= 0.65) {
        best = node
        bestScore = score
      }
    }
    return best
  }

  private cleanNodeForText(node: Element): Element {
    const clone = node.cloneNode(true) as Element
    const removeSelectors = [
      'script',
      'style',
      'noscript',
      'iframe',
      'nav',
      'aside',
      'footer',
      'form',
      'button',
      'input',
      'select',
      'textarea',
      '[role="navigation"]',
      '[role="complementary"]',
      '.advertisement',
      '.ads',
      '.share',
      '.related',
      '.comment',
      '.comments'
    ]
    for (const sel of removeSelectors) {
      clone.querySelectorAll(sel).forEach((el) => el.remove())
    }
    return clone
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
    score += this.pathSimilarityScore(baseUrl, abs)
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

  private pathSimilarityScore(fromUrl: string, toUrl: string): number {
    try {
      const a = new URL(fromUrl)
      const b = new URL(toUrl)
      if (a.hostname !== b.hostname) return 0
      const fromParts = a.pathname.split('/').filter(Boolean)
      const toParts = b.pathname.split('/').filter(Boolean)
      if (!fromParts.length || !toParts.length) return 0
      const minLen = Math.min(fromParts.length, toParts.length)
      let sameCount = 0
      for (let i = 0; i < minLen; i += 1) {
        if (fromParts[i] === toParts[i]) sameCount += 1
      }
      const ratio = sameCount / Math.max(fromParts.length, toParts.length)
      let score = Math.round(ratio * 40)
      const fromNum = this.lastPathNumber(fromParts)
      const toNum = this.lastPathNumber(toParts)
      if (fromNum !== null && toNum !== null) {
        const diff = toNum - fromNum
        if (Math.abs(diff) === 1) score += 35
        else if (Math.abs(diff) <= 3) score += 15
      }
      return score
    } catch {
      return 0
    }
  }

  private inferNextPrevByUrlPattern(baseUrl: string, candidateUrls: string[]): NavigationResult {
    let nextCandidate: { url: string; score: number } | null = null
    let prevCandidate: { url: string; score: number } | null = null
    for (const url of candidateUrls) {
      const score = this.pathSimilarityScore(baseUrl, url)
      if (score < 45) continue
      const delta = this.urlNumericDelta(baseUrl, url)
      if (delta === 1) {
        if (!nextCandidate || score > nextCandidate.score) nextCandidate = { url, score }
      } else if (delta === -1) {
        if (!prevCandidate || score > prevCandidate.score) prevCandidate = { url, score }
      }
    }
    return { nextUrl: nextCandidate?.url, prevUrl: prevCandidate?.url }
  }

  private urlNumericDelta(fromUrl: string, toUrl: string): number | null {
    try {
      const a = new URL(fromUrl)
      const b = new URL(toUrl)
      const an = this.lastPathNumber(a.pathname.split('/').filter(Boolean))
      const bn = this.lastPathNumber(b.pathname.split('/').filter(Boolean))
      if (an === null || bn === null) return null
      return bn - an
    } catch {
      return null
    }
  }

  private lastPathNumber(parts: string[]): number | null {
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const m = parts[i].match(/(\d+)(?!.*\d)/)
      if (m?.[1]) return Number(m[1])
    }
    return null
  }

  private collectStructuredText(value: unknown, out: string[]): void {
    if (!value) return
    if (Array.isArray(value)) {
      value.forEach((item) => this.collectStructuredText(item, out))
      return
    }
    if (typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const preferredFields = [
      'articleBody',
      'description',
      'text',
      'headline',
      'name'
    ]
    for (const key of preferredFields) {
      const raw = record[key]
      if (typeof raw === 'string') {
        const t = this.normalizeText(raw)
        if (t.length >= 30) out.push(t)
      }
    }
    for (const v of Object.values(record)) {
      if (typeof v === 'object') this.collectStructuredText(v, out)
    }
  }

  private normalizeText(text: string): string {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  }

  private escapeHtml(text: string): string {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  private absUrl(base: string, href: string): string {
    if (!href) return ''
    try {
      return new URL(href, base).toString()
    } catch {
      return ''
    }
  }

  private urlFingerprint(url: string): string {
    try {
      const u = new URL(url)
      u.hash = ''
      const keep = Array.from(u.searchParams.entries())
        .filter(([k]) => !/^utm_|^spm$|^from$|^ref$/i.test(k))
        .sort(([a], [b]) => a.localeCompare(b))
      const query = keep.map(([k, v]) => `${k}=${v}`).join('&')
      return `${u.origin}${u.pathname}${query ? `?${query}` : ''}`
    } catch {
      return url
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

  async extractWhenReady<T>(
    extractScript: string,
    options?: {
      waitForSelector?: string
      settleAfterMs?: number
      waitForImages?: boolean
      loginGuardScript?: string
      loginWaitTimeoutMs?: number
      timeoutMs?: number
      maxDomNodes?: number
    }
  ): Promise<T> {
    await this.waitForReady(options)
    if (options?.loginGuardScript) {
      await this.waitForLoginOrVerificationResolved(options.loginGuardScript, options.loginWaitTimeoutMs ?? 120000)
    }
    const maxDomNodes = Math.max(1000, options?.maxDomNodes ?? 5000)
    const domCount = (await this.webContents.executeJavaScript(
      `document.body ? document.body.querySelectorAll('*').length : 0`,
      true
    )) as number
    if (domCount > maxDomNodes) {
      throw new ExtractError('DOM_TOO_LARGE', '页面结构过于复杂，建议使用手动框选。')
    }

    const timeoutMs = Math.max(1000, options?.timeoutMs ?? 5000)
    const extractPromise = this.webContents.executeJavaScript(extractScript, true) as Promise<T>
    const timeoutPromise = new Promise<T>((_, reject) => {
      setTimeout(() => reject(new ExtractError('EXTRACTION_TIMEOUT', '页面提取超时，请重试或使用手动框选。')), timeoutMs)
    })
    return Promise.race([extractPromise, timeoutPromise])
  }

  async triggerLazyLoad(maxSteps = 8): Promise<void> {
    await this.webContents.executeJavaScript(`(() => new Promise((resolve) => {
      let step = 0;
      const total = ${Math.max(2, Math.min(24, maxSteps))};
      const tick = () => {
        step += 1;
        window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
        if (step >= total) {
          setTimeout(() => {
            window.scrollTo(0, 0);
            resolve(true);
          }, 250);
          return;
        }
        setTimeout(tick, 180);
      };
      tick();
    }))()`, true)
  }

  private async waitForReady(options?: {
    waitForSelector?: string
    settleAfterMs?: number
    waitForImages?: boolean
  }): Promise<void> {
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

    if (options?.waitForSelector) {
      const sel = JSON.stringify(options.waitForSelector)
      await this.webContents.executeJavaScript(`(() => new Promise((resolve) => {
        const selector = ${sel};
        const start = Date.now();
        const timer = setInterval(() => {
          if (document.querySelector(selector)) {
            clearInterval(timer);
            resolve(true);
            return;
          }
          if (Date.now() - start > 15000) {
            clearInterval(timer);
            resolve(false);
          }
        }, 120);
      }))()`)
    }

    if (options?.waitForImages !== false) {
      await this.webContents.executeJavaScript(`(() => new Promise((resolve) => {
        const imgs = Array.from(document.images || []);
        if (!imgs.length) return resolve(true);
        const done = () => imgs.every((img) => img.complete);
        if (done()) return resolve(true);
        const start = Date.now();
        const timer = setInterval(() => {
          if (done() || Date.now() - start > 10000) {
            clearInterval(timer);
            resolve(true);
          }
        }, 150);
      }))()`)
    }

    const settle = Math.max(0, options?.settleAfterMs ?? 300)
    if (settle > 0) {
      await this.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, ${settle}))`)
    }
  }

  private async waitForLoginOrVerificationResolved(guardScript: string, timeoutMs: number): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const blocked = (await this.webContents.executeJavaScript(guardScript, true)) as boolean
      if (!blocked) return
      await this.webContents.executeJavaScript('new Promise((r) => setTimeout(r, 1000))')
    }
  }
}
