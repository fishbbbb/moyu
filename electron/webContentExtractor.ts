import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import type { WebContents } from 'electron'
import { createSiteAdapters } from './web-import/adapters'
import { extractStructuredDataCore, fallbackExtractCore } from './web-import/core/content-extractor'
import { collectNavNextCandidatesCore, resolveNextChapterCore } from './web-import/core/navigation-resolver'
import { detectTocCore } from './web-import/core/toc-detector'
import type {
  ContentStrategy,
  ExtractErrorCode,
  ExtractorOptions,
  ExtractPipelineDebug,
  ExtractResult,
  NavigationResult,
  NavNextCandidate,
  ResolvedNextChapter,
  SiteAdapter,
  SitePreExtractContext,
  SitePreExtractResult,
  TocResult,
  TocSource,
  TocStatus,
  WebNextChapterCandidate
} from './web-import/types'
export type {
  ContentStrategy,
  ExtractErrorCode,
  ExtractorOptions,
  ExtractPipelineDebug,
  ExtractResult,
  NavigationResult,
  NavNextCandidate,
  ResolvedNextChapter,
  SiteAdapter,
  SitePreExtractContext,
  SitePreExtractResult,
  TocResult,
  TocSource,
  TocStatus,
  WebNextChapterCandidate
} from './web-import/types'

export class ExtractError extends Error {
  readonly code: ExtractErrorCode

  constructor(code: ExtractErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'ExtractError'
  }
}

const DEFAULT_MIN_TEXT_LENGTH = 200

export class WebContentExtractor {
  private readonly minTextLength: number
  private readonly keepImages: boolean
  private readonly siteAdapters: SiteAdapter[]

  constructor(options: ExtractorOptions = {}) {
    this.minTextLength = options.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH
    this.keepImages = Boolean(options.keepImages ?? false)
    this.siteAdapters = createSiteAdapters({
      isBquduChapterUrl: (url) => this.isBquduChapterUrl(url),
      extractBquduChapterContentHtml: (html) => this.extractBquduChapterContentHtml(html),
      buildBquduMinimalChapterHtml: (shellHtml, partHtml) => this.buildBquduMinimalChapterHtml(shellHtml, partHtml),
      isWereadReaderUrl: (url) => this.isWereadReaderUrl(url),
      extractWereadChapterContentHtml: (html) => this.extractWereadChapterContentHtml(html),
      buildWereadMinimalChapterHtml: (shellHtml, partHtml) => this.buildWereadMinimalChapterHtml(shellHtml, partHtml),
      cleanWereadReaderNoise: (text) => this.cleanWereadReaderNoise(text),
      detectWereadReaderTOC: (url, html) => this.detectWereadReaderTOC(url, html),
      createWereadAuthRequiredError: () =>
        new ExtractError('AUTH_REQUIRED', '微信读书 web reader 正文需登录或由前端加载，请在网页中登录后重试。'),
      isTaduChapterUrl: (url) => this.isTaduChapterUrl(url),
      fetchTaduPartContentHtml: (pageUrl, html) => this.fetchTaduPartContentHtml(pageUrl, html),
      buildTaduMinimalChapterHtml: (shellHtml, partHtml) => this.buildTaduMinimalChapterHtml(shellHtml, partHtml),
      hasTaduInjectedChapterBody: (document) => this.hasTaduInjectedChapterBody(document),
      isJjwxcOnebookUrl: (url) => this.isJjwxcOnebookUrl(url),
      cleanJjwxcChapterText: (text) => this.cleanJjwxcChapterText(text),
      isTaduUrl: (url) => this.isTaduUrl(url),
      cleanNovelReaderUiNoise: (text) => this.cleanNovelReaderUiNoise(text),
      isReadnovelUrl: (url) => this.isReadnovelUrl(url)
    })
  }

  extractCurrentPage(url: string, html: string): ExtractResult {
    const dom = new JSDOM(html, { url })
    const blocked = this.detectBlockedState(dom, url)
    if (blocked) throw blocked

    // Some sites (or very short chapters) render only a small amount of text.
    // If the page explicitly provides a word-count hint (e.g. "本章字数：103字"),
    // relax minTextLength so we can still extract usable content.
    const bodyTextForHint = this.normalizeText(dom.window.document.body?.textContent || '')
    const wc = bodyTextForHint.match(/本章字数\s*[:：]\s*(\d+)\s*字/i)?.[1]
    const wordCountHint = wc ? Number(wc) : NaN
    const effectiveMinTextLength =
      Number.isFinite(wordCountHint) && wordCountHint > 0 ? Math.min(this.minTextLength, Math.max(60, Math.round(wordCountHint * 0.95))) : this.minTextLength

    const structured = this.extractStructuredData(dom, url)
    const readability = this.extractWithReadability(dom)
    const heuristic = this.fallbackExtract(dom)

    type Strat = Exclude<ContentStrategy, 'manual'>
    const raw: Array<{ strategy: Strat; result: ExtractResult | null }> = [
      { strategy: 'structured', result: structured },
      { strategy: 'readability', result: readability },
      { strategy: 'heuristic', result: heuristic }
    ]

    const candidateScores: Partial<Record<Strat, number>> = {}
    const ranked: Array<{ strategy: Strat; score: number; processed: ExtractResult }> = []

    for (const { strategy, result } of raw) {
      if (!result) {
        candidateScores[strategy] = 0
        continue
      }
      const sanitized = this.sanitizeExtractResult(result)
      const processed = this.postProcessBySite(url, sanitized)
      const score = this.scoreExtractCandidate(processed, dom, effectiveMinTextLength)
      candidateScores[strategy] = score
      if (score >= 0 && processed.length >= effectiveMinTextLength) {
        ranked.push({ strategy, score, processed })
      }
    }

    ranked.sort((a, b) => b.score - a.score)
    const rankedOrder = ranked.map((r) => r.strategy)

    let lastErr: unknown
    for (const item of ranked) {
      try {
        this.validateExtractedContent(item.processed, dom, url)
        const dbg: ExtractPipelineDebug = {
          candidateScores,
          rankedOrder,
          selectedStrategy: item.strategy
        }
        return { ...item.processed, source: item.strategy, debug: dbg }
      } catch (e) {
        lastErr = e
      }
    }

    const blockedAfter = this.detectBlockedState(dom, url)
    if (blockedAfter) throw blockedAfter
    if (lastErr) throw lastErr
    throw new ExtractError('NO_MAIN_CONTENT', '未识别到可导入正文，请切换章节页或使用手动框选。')
  }

  /**
   * 与 extractCurrentPage 相同，但对塔读等「首屏 HTML 不含正文、需二次请求 JSON/HTML片段」的站点补充拉取。
   * Electron 主进程与 Node 18+ 均提供全局 fetch。
   */
  async extractCurrentPageAsync(url: string, html: string): Promise<ExtractResult> {
    const adapters = this.findSiteAdapters(url)
    for (const adapter of adapters) {
      if (!adapter.preExtract) continue
      const pre = await adapter.preExtract({ url, html })
      if (pre?.error) throw pre.error
      if (pre?.htmlForExtraction) return this.extractCurrentPage(url, pre.htmlForExtraction)
    }
    return this.extractCurrentPage(url, html)
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

  private postProcessBySite(url: string, result: ExtractResult): ExtractResult {
    const text = String(result.textContent || '')
    if (!text) return result
    const adapters = this.findSiteAdapters(url)
    if (!adapters.length) return result

    let cleaned = text
    let changed = false
    for (const adapter of adapters) {
      if (!adapter.postProcessText) continue
      const next = this.normalizeText(adapter.postProcessText(cleaned))
      if (next !== cleaned) changed = true
      cleaned = next
    }

    if (!changed) return result
    return { ...result, textContent: cleaned, length: cleaned.length }
  }

  private findSiteAdapters(url: string): SiteAdapter[] {
    return this.siteAdapters.filter((adapter) => adapter.matches(url))
  }

  private shouldIgnoreMetaDescriptionBySite(url: string): boolean {
    return this.findSiteAdapters(url).some((adapter) => Boolean(adapter.shouldIgnoreMetaDescription))
  }

  private hasInjectedChapterBodyBySite(url: string, document: Document): boolean {
    return this.findSiteAdapters(url).some((adapter) => adapter.hasInjectedChapterBody?.(document) === true)
  }

  private detectTOCBySite(url: string, html: string): TocResult | null {
    for (const adapter of this.findSiteAdapters(url)) {
      const toc = adapter.detectTOC?.({ url, html })
      if (toc) return toc
    }
    return null
  }

  private detectWereadReaderTOC(url: string, html: string): TocResult | null {
    const entries: Array<{ title: string; url: string }> = []
    const seen = new Set<string>()
    const pushEntry = (title: string, href: string) => {
      const t = String(title || '').trim()
      const abs = this.absUrl(url, href)
      if (!t || !abs) return
      const fp = this.urlFingerprint(abs)
      if (seen.has(fp)) return
      seen.add(fp)
      entries.push({ title: t, url: abs })
    }

    const meta = this.extractWereadReaderChapterInfos(url, html)
    if (!meta?.chapters?.length) return null

    const origin = (() => {
      try {
        return new URL(url).origin
      } catch {
        return 'https://weread.qq.com'
      }
    })()

    const buildTitle = (raw: string) => {
      const t = String(raw || '').trim()
      if (/^\d{1,3}$/.test(t)) return `第${Number(t)}章`
      return t
    }

    const chapters = meta.chapters
      .map((c: any) => ({
        uid: Number(c.chapterUid),
        title: buildTitle(c.title || ''),
        paid: Number(c.paid || 0),
        wordCount: Number(c.wordCount || 0)
      }))
      .filter((c) => c.uid > 0 && c.title && c.title.length <= 90)
      .sort((a, b) => a.uid - b.uid)

    for (const c of chapters) {
      // 用 query 参数合成“可指纹化”的章节链接，便于 resolveNextChapter/自测导航探测。
      pushEntry(c.title, `${origin}/web/reader/${meta.infoId}?chapterUid=${c.uid}`)
    }

    return {
      isTocPage: true,
      tocUrlCandidate: undefined,
      entries,
      tocStatus: entries.length >= 2 ? 'ready' : entries.length === 1 ? 'partial' : 'missing',
      tocSource: 'chapter_metadata'
    }
  }

  private isJjwxcOnebookUrl(url: string): boolean {
    try {
      const u = new URL(url)
      return /(^|\.)jjwxc\.net$/i.test(u.hostname) && /\/onebook\.php$/i.test(u.pathname)
    } catch {
      return false
    }
  }

  private isTaduUrl(url: string): boolean {
    try {
      return /(^|\.)tadu\.com$/i.test(new URL(url).hostname)
    } catch {
      return false
    }
  }

  private isWereadUrl(url: string): boolean {
    try {
      return /(^|\.)weread\.qq\.com$/i.test(new URL(url).hostname)
    } catch {
      return false
    }
  }

  private isWereadReaderUrl(url: string): boolean {
    try {
      const u = new URL(url)
      return this.isWereadUrl(url) && /\/web\/reader\//i.test(u.pathname)
    } catch {
      return false
    }
  }

  private isBquduChapterUrl(url: string): boolean {
    try {
      const u = new URL(url)
      if (!/(^|\.)bqudu\.com$/i.test(u.hostname)) return false
      return /^\/book\/[a-z0-9]+\/[a-z0-9]+\.html$/i.test(u.pathname)
    } catch {
      return false
    }
  }

  private extractBquduChapterContentHtml(html: string): string | null {
    try {
      const dom = new JSDOM(String(html || ''))
      const el = dom.window.document.querySelector('#chaptercontent')
      if (!el) return null
      const t = this.normalizeText(el.textContent || '')
      if (t.length < 180) return null
      return el.innerHTML || ''
    } catch {
      return null
    }
  }

  private extractTitleTag(shellHtml: string): string {
    const m = String(shellHtml || '').match(/<title[^>]*>[\s\S]*?<\/title>/i)
    return m ? m[0] : '<title></title>'
  }

  private buildBquduMinimalChapterHtml(shellHtml: string, partHtml: string): string {
    const titleTag = this.extractTitleTag(shellHtml)
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/>${titleTag}</head><body><article id="bqudu-chapter-body">${partHtml}</article></body></html>`
  }

  private decodeJsonEscapedString(raw: string): string | null {
    if (!raw) return null
    try {
      return JSON.parse(`"${raw}"`) as string
    } catch {
      return null
    }
  }

  private extractWereadChapterContentHtml(html: string): string | null {
    const src = String(html || '')
    const keys = ['chapterContentHtml', 'chapterContentTargetHtml']
    for (const key of keys) {
      const re = new RegExp(`"${key}":"((?:\\\\\\\\.|[^"\\\\])*)"`)
      const m = src.match(re)
      if (!m?.[1]) continue
      const decoded = this.decodeJsonEscapedString(m[1]) || ''
      const text = this.normalizeText(new JSDOM(`<div>${decoded}</div>`).window.document.body.textContent || '')
      if (!decoded.trim()) continue
      // 微信读书章节正文通常远大于书城头部噪声，并包含较高中文密度。
      if (text.length >= 180 && /[\u4e00-\u9fa5]{50,}/.test(text)) return decoded
    }
    return null
  }

  private extractWereadReaderChapterInfos(
    url: string,
    html: string
  ): { infoId: string; chapters: Array<{ chapterUid: number; title: string; paid?: number; wordCount?: number }> } | null {
    const src = String(html || '')
    const m = src.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;/)
    if (!m?.[1]) return null
    try {
      const state = JSON.parse(m[1]) as any
      const reader = state?.reader
      const infoId = String(reader?.infoId || '').trim()
      const chapters = Array.isArray(reader?.chapterInfos) ? reader.chapterInfos : []
      if (!chapters.length) return null

      let id = infoId
      if (!id) {
        try {
          const u = new URL(url)
          const mm = u.pathname.match(/\/web\/reader\/([^/?#]+)/i)
          if (mm?.[1]) id = mm[1]
        } catch {
          // ignore
        }
      }
      if (!id) return null
      return { infoId: id, chapters }
    } catch {
      return null
    }
  }

  private buildWereadMinimalChapterHtml(shellHtml: string, partHtml: string): string {
    const titleTag = this.extractTitleTag(shellHtml)
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/>${titleTag}</head><body><article id="weread-api-chapter-body" class="readerContent">${partHtml}</article></body></html>`
  }

  /** 章节阅读页：/book/{bookId}/{chapterId}，不含 catalogue 目录页 */
  private isTaduChapterUrl(url: string): boolean {
    try {
      const u = new URL(url)
      if (!/(^|\.)tadu\.com$/i.test(u.hostname)) return false
      return /^\/book\/\d+\/\d+\/?$/i.test(u.pathname)
    } catch {
      return false
    }
  }

  private parseTaduPartResourcePath(html: string): string | null {
    const m = String(html || '').match(/id="bookPartResourceUrl"\s+value="([^"]+)"/i)
    if (!m?.[1]) return null
    const p = m[1].trim()
    return p.startsWith('/') ? p : null
  }

  private buildTaduMinimalChapterHtml(shellHtml: string, partHtml: string): string {
    const titleTag = this.extractTitleTag(shellHtml)
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/>${titleTag}</head><body><article id="tadu-api-chapter-body" class="read_details">${partHtml}</article></body></html>`
  }

  private async fetchTaduPartContentHtml(pageUrl: string, html: string): Promise<string | null> {
    const path = this.parseTaduPartResourcePath(html)
    if (!path) return null
    let abs: string
    try {
      abs = new URL(path, pageUrl).href
    } catch {
      return null
    }
    try {
      const res = await fetch(abs, {
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9',
          referer: pageUrl,
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'x-requested-with': 'XMLHttpRequest'
        }
      })
      if (!res.ok) return null
      const json = (await res.json()) as { status?: number; data?: { content?: string } }
      const content = json?.data?.content
      if (typeof content !== 'string' || !content.trim()) return null
      return content
    } catch {
      return null
    }
  }

  /**
   * 塔读接口返回的正文多为较短 <p>，若仍用「单段 >=120 字」判断会导致整页被误判为仅登录/付费壳层。
   */
  private hasTaduInjectedChapterBody(document: Document): boolean {
    const el = document.querySelector('#tadu-api-chapter-body')
    if (!el) return false
    const t = this.normalizeText(el.textContent || '')
    return t.length >= 400 && /[\u4e00-\u9fa5]/.test(t)
  }

  private isReadnovelUrl(url: string): boolean {
    try {
      return /(^|\.)readnovel\.com$/i.test(new URL(url).hostname)
    } catch {
      return false
    }
  }

  private cleanNovelReaderUiNoise(text: string): string {
    let out = this.normalizeText(String(text || ''))
    if (!out) return out
    const lines = out
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((line) => {
        if (line.length <= 1) return false
        if (/^(目录|设置|书架|书签|投票|评论|扫码|保存|首页|退出|举报)$/i.test(line)) return false
        // 勿用裸「APP」：正文中常见「塔读小说APP」等插入语，误删会清空塔读接口段落
        if (/(我的书架|按.*键盘|下载APP|体验卡|推荐值|点评|阅读主题|字体大小|页面宽度)/i.test(line)) return false
        return true
      })
    out = lines.join('\n')

    const chapterStart = out.search(/第\s*[0-9零一二三四五六七八九十百千]+\s*[章回节卷]/)
    if (chapterStart > 0 && chapterStart < 800) out = out.slice(chapterStart)
    return this.normalizeText(out)
  }

  private cleanWereadReaderNoise(text: string): string {
    let out = this.normalizeText(String(text || ''))
    if (!out) return out
    const lines = out
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((line) => {
        if (line.length <= 1) return false
        if (
          /(微信读书书城|我的书架|推荐值|体验卡|可读字数|万人点评|推荐\(|一般\(|不行\(|电子书|出版社|版权信息|书城|首页|登录|立即阅读)/i.test(
            line
          )
        ) {
          return false
        }
        return true
      })
    out = lines.join('\n')
    // 若仅剩壳层导航词，直接视为无正文，交由主流程判 NO_MAIN_CONTENT
    if (out.length < 120) return ''
    return this.normalizeText(out)
  }

  private cleanJjwxcChapterText(text: string): string {
    let out = this.normalizeText(String(text || ''))
    if (!out) return out

    const removePhrases: RegExp[] = [
      /\[图片\]/gi,
      /\[收藏此章节\]/gi,
      /\[投诉\]/gi,
      /文章收藏/gi,
      /倒数计时/gi,
      /插入书签/gi,
      /作者有话说/gi,
      /显示所有文的作话/gi,
      /收起目录|展开目录/gi,
      /支持手机扫描二维码阅读/gi,
      /wap阅读地址/gi,
      /打开晋江App扫码即刻阅读/gi,
      /该作者现在暂无推文/gi,
      /感谢小天使们的[^。；;\n]{0,120}霸王票[^。；;\n]{0,120}营养液/gi,
      /Copyright By [^\n]{0,120}jjwxc\.net[^\n]{0,80}/gi
    ]
    for (const re of removePhrases) out = out.replace(re, ' ')

    // 从章节标题开始截断，去掉前置导航/说明文案
    const chapterStart = out.search(/第\s*[0-9零一二三四五六七八九十百千]+\s*[章回节卷]/)
    if (chapterStart > 0 && chapterStart < 800) out = out.slice(chapterStart)

    // 常见页脚起始词，后面内容整体裁掉
    const foot = out.search(/(本站作品.*版权|晋江文学城.*版权所有|举报中心|违规举报|ICP)/i)
    if (foot > 0) out = out.slice(0, foot)

    return this.normalizeText(out)
  }

  private scoreExtractCandidate(result: ExtractResult, dom: JSDOM, minTextLengthOverride?: number): number {
    const text = this.normalizeText(result.textContent || '')
    const minLen = Number.isFinite(minTextLengthOverride ?? NaN) ? (minTextLengthOverride as number) : this.minTextLength
    if (text.length < minLen) return -1

    const pCount = (result.content.match(/<p[\s>]/gi) || []).length
    const sentences = (text.match(/[。！？.!?]/g) || []).length
    const linkNoise = this.estimateUrlNoise(text)
    const shortLineRatio = this.estimateShortLineRatio(text)

    let score = Math.log10(text.length + 10) * 100
    score += Math.min(pCount, 50) * 2.5
    score += Math.min(sentences, 120) * 1.2
    score *= 1 - Math.min(0.55, linkNoise * 0.85 + shortLineRatio * 0.35)

    if (this.isLikelyDirectoryPage(dom.window.document, text)) score *= 0.35
    return score
  }

  private estimateUrlNoise(text: string): number {
    const m = text.match(/https?:\/\/|www\./gi)
    if (!m) return 0
    return Math.min(1, m.length / 22)
  }

  private estimateShortLineRatio(text: string): number {
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!lines.length) return 1
    const shortCount = lines.filter((l) => l.length < 12).length
    return shortCount / lines.length
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
    let nextConfidence: number | undefined
    let nextReason: string | undefined
    let prevConfidence: number | undefined
    let prevReason: string | undefined

    for (const link of relLinks) {
      const rel = (link.getAttribute('rel') || '').toLowerCase()
      const href = link.getAttribute('href') || ''
      if (!href) continue
      const abs = this.absUrl(baseUrl, href)
      if (!abs || seen.has(this.urlFingerprint(abs))) continue
      if (rel.includes('next')) {
        nextUrl = abs
        nextConfidence = 0.92
        nextReason = 'rel_next'
      }
      if (rel.includes('prev')) {
        prevUrl = abs
        prevConfidence = 0.92
        prevReason = 'rel_prev'
      }
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
    if (!nextUrl && inferred.nextUrl) {
      nextUrl = inferred.nextUrl
      nextConfidence = 0.58
      nextReason = 'url_numeric_delta'
    }
    if (!prevUrl && inferred.prevUrl) {
      prevUrl = inferred.prevUrl
      prevConfidence = 0.58
      prevReason = 'url_numeric_delta'
    }

    for (const item of scored) {
      if (!nextUrl && item.score >= 60 && this.isNextText(item.text)) {
        nextUrl = item.url
        nextConfidence = Math.min(0.88, 0.52 + item.score / 220)
        nextReason = 'anchor_next'
      }
      if (!prevUrl && item.score >= 60 && this.isPrevText(item.text)) {
        prevUrl = item.url
        prevConfidence = Math.min(0.88, 0.52 + item.score / 220)
        prevReason = 'anchor_prev'
      }
      if (nextUrl && prevUrl) break
    }

    if (!nextUrl) {
      const pg = this.detectPaginationHint(document, baseUrl)
      if (pg.nextPageUrl && !seen.has(this.urlFingerprint(pg.nextPageUrl))) {
        nextUrl = pg.nextPageUrl
        nextConfidence = 0.42
        nextReason = 'pagination_next'
      }
    }

    if (nextUrl && seen.has(this.urlFingerprint(nextUrl))) {
      nextUrl = undefined
      nextConfidence = undefined
      nextReason = undefined
    }
    if (prevUrl && seen.has(this.urlFingerprint(prevUrl))) {
      prevUrl = undefined
      prevConfidence = undefined
      prevReason = undefined
    }

    const nextCandidates = this.collectNavNextCandidates(scored, nextUrl, nextConfidence, nextReason, seen)

    return {
      nextUrl,
      prevUrl,
      nextConfidence: nextUrl ? nextConfidence : undefined,
      nextReason: nextUrl ? nextReason : undefined,
      prevConfidence: prevUrl ? prevConfidence : undefined,
      prevReason: prevUrl ? prevReason : undefined,
      nextCandidates: nextCandidates.length ? nextCandidates : undefined
    }
  }

  private collectNavNextCandidates(
    scored: Array<{ text: string; url: string; score: number }>,
    primaryUrl: string | undefined,
    primaryConf: number | undefined,
    primaryReason: string | undefined,
    seen: Set<string>
  ): NavNextCandidate[] {
    return collectNavNextCandidatesCore({
      scored,
      primaryUrl,
      primaryConf,
      primaryReason,
      seenFingerprints: seen,
      urlFingerprint: (url) => this.urlFingerprint(url),
      isNextText: (text) => this.isNextText(text)
    })
  }

  /** 目录邻接优先，其次导航启发式；0.45~0.75 区间不自动给出唯一 nextUrl，改为 candidates 待确认。 */
  resolveNextChapter(pageUrl: string, tocEntries: Array<{ title: string; url: string }>, nav: NavigationResult): ResolvedNextChapter {
    return resolveNextChapterCore({
      pageUrl,
      tocEntries,
      nav,
      urlFingerprint: (url) => this.urlFingerprint(url)
    })
  }

  detectTOC(url: string, html: string): TocResult {
    const tocByAdapter = this.detectTOCBySite(url, html)
    if (tocByAdapter) return tocByAdapter
    return detectTocCore(url, html, {
      absUrl: (baseUrl, href) => this.absUrl(baseUrl, href),
      urlFingerprint: (v) => this.urlFingerprint(v),
      isLikelyChapterLinkText: (v) => this.isLikelyChapterLinkText(v),
      isLikelyChapterHref: (v) => this.isLikelyChapterHref(v),
      findTocLink: (document, baseUrl) => this.findTocLink(document, baseUrl)
    })
  }

  private fallbackExtract(dom: JSDOM): ExtractResult | null {
    return fallbackExtractCore(dom, {
      findBestDensityCandidate: (document) => this.findBestDensityCandidate(document),
      cleanNodeForText: (node) => this.cleanNodeForText(node),
      normalizeText: (text) => this.normalizeText(text)
    })
  }

  private extractStructuredData(dom: JSDOM, sourceUrl = ''): ExtractResult | null {
    return extractStructuredDataCore(dom, sourceUrl, {
      normalizeText: (text) => this.normalizeText(text),
      shouldIgnoreMetaDescriptionBySite: (url) => this.shouldIgnoreMetaDescriptionBySite(url),
      collectStructuredText: (value, out) => this.collectStructuredText(value, out),
      escapeHtml: (s) => this.escapeHtml(s)
    })
  }

  private detectBlockedState(dom: JSDOM, baseUrl: string): ExtractError | null {
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

    if (this.isAuthRequiredPage(document, textLower, baseUrl)) {
      return new ExtractError('AUTH_REQUIRED', '请先在网页中登录，再点击提取。')
    }

    if (this.isPaywallBlockedPage(document, textLower, baseUrl)) {
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
    if (pg.hasPagination && pg.nextPageUrl && !this.shouldIgnorePaginationBySite(baseUrl)) {
      throw new ExtractError('PAGINATION_DETECTED', '检测到分页内容（如 1/2、2/2），请切换单页阅读或翻到下一分页后重试提取。')
    }

    if (this.isLikelyFontObfuscated(text)) {
      throw new ExtractError('FONT_OBFUSCATED', '检测到乱码率过高，疑似字体加密，当前版本暂无法解析。')
    }

    if (this.isCrossOriginIframeLikelyMain(document, baseUrl, text)) {
      throw new ExtractError('IFRAME_CROSS_ORIGIN', '正文可能位于跨域 iframe 中，建议在 iframe 源页面打开后再提取。')
    }
  }

  private isAuthRequiredPage(document: Document, textLower: string, baseUrl: string): boolean {
    if (this.hasInjectedChapterBodyBySite(baseUrl, document)) return false
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
    if (hasAuthForm) return true
    const strongAuthHints = ['您还未登录', '登录后看书更方便', '微信登录', 'qq登录', '微博登录', '手机号登录']
    const strongHintHits = strongAuthHints.filter((k) => textLower.includes(k.toLowerCase())).length
    if (!hasAuthWords) return false
    const bodyText = this.normalizeText(document.body?.textContent || '')
    const longParagraphs = Array.from(document.querySelectorAll('p'))
      .map((p) => this.normalizeText(p.textContent || ''))
      .filter((x) => x.length >= 120)
    // 强提示词 + 正文明显缺失，优先判定为登录拦截（常见于章节页仅展示登录弹层文案）。
    if (strongHintHits >= 2 && longParagraphs.length === 0) return true
    // 登录词仅在“正文明显缺失”时才判定，避免正文页页头/页脚文字误伤
    return bodyText.length < 280 && longParagraphs.length === 0
  }

  private isPaywallBlockedPage(document: Document, textLower: string, baseUrl: string): boolean {
    if (this.hasInjectedChapterBodyBySite(baseUrl, document)) return false
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
    if (hasPayMask) return true
    if (!hasPayWords) return false
    const strongPayHints = ['单章订阅', '余额不足', '立即充值', '解锁本章', '本章需购买', '投银票', '打赏本书']
    const strongHintHits = strongPayHints.filter((k) => textLower.includes(k.toLowerCase())).length
    const bodyText = this.normalizeText(document.body?.textContent || '')
    const longParagraphs = Array.from(document.querySelectorAll('p'))
      .map((p) => this.normalizeText(p.textContent || ''))
      .filter((x) => x.length >= 120)
    // 强付费提示 + 无有效长段正文，判定为付费拦截页。
    if (strongHintHits >= 2 && longParagraphs.length === 0) return true
    // 付费词仅在“正文明显缺失”时判定，避免评论区/页脚/站点导航中的关键词误判
    return bodyText.length < 280 && longParagraphs.length === 0
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
    // 常见风控壳页特征（起点/17k 等）：页面仅注入探针脚本或 acw/aliyunwaf 挑战脚本。
    const scriptText = Array.from(document.querySelectorAll('script'))
      .map((s) => s.textContent || '')
      .join('\n')
      .toLowerCase()
    const htmlLower = String(document.documentElement?.outerHTML || '').toLowerCase()
    const wafScriptHints = [
      'aliyunwaf_',
      'acw_sc__v2',
      'var arg1=',
      '/probe.js',
      'var buid = "fffffffffffffffffff"'
    ]
    const hasWafHints = wafScriptHints.some((k) => scriptText.includes(k) || htmlLower.includes(k))
    return hasKeywords || hasCaptchaElement || hasWafHints
  }

  private isSiteNotFoundPage(document: Document, textLower: string): boolean {
    const title = String(document.title || '').toLowerCase()
    const body = textLower
    if (/\b404\b/.test(title) || title.includes('not found') || title.includes('页面不存在') || title.includes('请求的页面不存在')) {
      return true
    }
    const hasBodyNotFound = body.includes('页面不存在') || body.includes('请求的页面不存在') || body.includes('not found')
    const bodyText = this.normalizeText(document.body?.textContent || '')
    // 仅在页面正文极短时才以 body 关键词判 404，避免误伤正文中出现“页面不存在”的提示块。
    return hasBodyNotFound && bodyText.length < 260
  }

  private isContentRemovedPage(document: Document, textLower: string): boolean {
    const t = `${document.title || ''} ${textLower}`.toLowerCase()
    // 注意：仅凭“版权”容易误伤正文页（很多站点页脚都会出现“版权所有”）。
    // 这里改成“强特征 + 页面正文不足”的组合，减少误判。
    const strongKeys = [
      '内容已删除',
      '章节不存在',
      '文章不存在',
      '作品不存在',
      '内容不可用',
      '页面不存在',
      '已下架',
      '已移除',
      'removed',
      'unavailable',
      'not available'
    ]
    if (strongKeys.some((k) => t.includes(k.toLowerCase()))) return true

    const weakKeys = ['因版权原因', '版权限制', '版权问题', '涉嫌侵权']
    const hasWeak = weakKeys.some((k) => t.includes(k.toLowerCase()))
    if (!hasWeak) return false

    const bodyText = this.normalizeText(document.body?.textContent || '')
    const longParagraphs = Array.from(document.querySelectorAll('p'))
      .map((p) => this.normalizeText(p.textContent || ''))
      .filter((x) => x.length >= 120)
    return bodyText.length < 280 && longParagraphs.length === 0
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

  private shouldIgnorePaginationBySite(url: string): boolean {
    return this.findSiteAdapters(url).some((adapter) => Boolean(adapter.ignorePagination))
  }

  private isLikelyFontObfuscated(text: string): boolean {
    if (text.length < 120) return false
    let weird = 0
    for (const ch of text) {
      const cp = ch.codePointAt(0) || 0
      const isReplacement = ch === '\uFFFD'
      const isPrivateUse = cp >= 0xe000 && cp <= 0xf8ff
      // 塔读等站会在正文插入 &、~、* 等分隔符防采集，勿与私用区乱码同等对待
      const isNormal =
        /[\u4e00-\u9fa5a-zA-Z0-9\s，。！？、,.!?;:："'“”‘’（）()【】\[\]\-—_&~*]/.test(ch)
      if (isReplacement || isPrivateUse || !isNormal) weird += 1
    }
    const ratio = weird / Math.max(1, text.length)
    // Short extracts often include custom-font glyphs for some characters;
    // don't be overly strict in those cases.
    const threshold = text.length < 200 ? 0.6 : 0.35
    return ratio >= threshold
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
      '.comments',
      '[class*="toolbar" i]',
      '[id*="toolbar" i]',
      '[class*="header" i]',
      '[id*="header" i]',
      '[class*="footer" i]',
      '[id*="footer" i]',
      '[class*="menu" i]',
      '[id*="menu" i]',
      '[class*="nav" i]',
      '[id*="nav" i]',
      '[class*="setting" i]',
      '[id*="setting" i]',
      '[class*="reader-tools" i]',
      '[class*="read-tool" i]',
      '[class*="bookrack" i]',
      '[class*="bookshelf" i]'
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
    if (this.isLikelyChapterHref(abs)) score += 26
    if (this.isSamePathGroup(baseUrl, abs)) score += 25
    score += this.pathSimilarityScore(baseUrl, abs)
    if (/\d+/.test(abs)) score += 10
    return score
  }

  private isNextText(text: string): boolean {
    return /(下一章|下一页|下一节|下页|下一篇|后[一1]章|继续阅读|加载下一章|下一回|下一节内容|Next|Next\s*Chapter|Next\s*Page|>>|›)/i.test(text)
  }

  private isPrevText(text: string): boolean {
    return /(上一章|上一页|上一节|上页|上一篇|前[一1]章|上一回|Prev|Previous|Previous\s*Chapter|<<|‹)/i.test(text)
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
      const queryKeys = ['chapterid', 'cid', 'chapter', 'chapter_id', 'page', 'p']
      for (const k of queryKeys) {
        const av = this.getSearchParamCaseInsensitive(a, k)
        const bv = this.getSearchParamCaseInsensitive(b, k)
        if (av !== null && bv !== null) return bv - av
      }
      const an = this.lastPathNumber(a.pathname.split('/').filter(Boolean))
      const bn = this.lastPathNumber(b.pathname.split('/').filter(Boolean))
      if (an === null || bn === null) return null
      return bn - an
    } catch {
      return null
    }
  }

  private getSearchParamCaseInsensitive(u: URL, key: string): number | null {
    const needle = key.toLowerCase()
    for (const [k, v] of u.searchParams.entries()) {
      if (k.toLowerCase() !== needle) continue
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return null
  }

  private isLikelyChapterLinkText(text: string): boolean {
    const s = String(text || '').trim()
    if (!s) return false
    if (s.length > 80) return false
    if (
      /^(登录|注册|目录|书页|返回|首页|上一章|下一章|上一页|下一页|下载|举报)$/i.test(s) ||
      /(书库|标签选书|标签|排行榜|榜单|畅读卡|畅读书库|帮助中心|帮助反馈|作家助手|作者福利|书城|客服|充值|包月|会员|下载app|去app|app下载|作者专区|兼职赚钱)/i.test(s)
    ) {
      return false
    }
    // Common category / genre navigation labels (avoid treating them as chapters).
    if (/(同人|玄幻|奇幻|武侠|仙侠|都市|言情|军事|历史|科幻|游戏|竞技|灵异|悬疑|校园|二次元|轻小说|现实|古代言情|现代言情|全部分类|分类)/i.test(s)) {
      return false
    }
    // Short navigation labels that contain "小说" are usually channel links, not chapters.
    if (/小说/i.test(s) && s.length <= 6) return false
    if (/第\s*[零一二三四五六七八九十百千0-9]+\s*[章回节卷话篇]/i.test(s)) return true
    if (/^(chapter|ch\.)\s*[0-9]+/i.test(s)) return true
    return s.length <= 24
  }

  private isLikelyChapterHref(url: string): boolean {
    if (!url) return false
    try {
      const u = new URL(url)
      const p = u.pathname.toLowerCase()
      if (/\/(chapter|reader|read|content)\b/.test(p)) return true
      // Avoid over-matching category/rank pages like "/y_0_1.html".
      // Chapter urls are more often "{bookId}_{seq}" with a long book id.
      if (/\/\d{5,}[-_]\d{1,6}/.test(p)) return true
      const keys = ['chapterid', 'cid', 'chapter', 'chapter_id']
      return keys.some((k) => this.getSearchParamCaseInsensitive(u, k) !== null)
    } catch {
      return false
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
      const u = new URL(href, base)
      const proto = (u.protocol || '').toLowerCase()
      if (proto !== 'http:' && proto !== 'https:') return ''
      return u.toString()
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
