import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { splitTextToChapters } from './chapterSplit'

export type ImportedItem = { title: string; contentText: string }

export type ImportedBookPayload = {
  title: string
  sourceRef: string
  items: ImportedItem[]
  format: 'txt' | 'epub'
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_'
})

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (Array.isArray(v)) return v
  if (v == null) return []
  return [v]
}

function decodeHtmlToText(input: string) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(input, 'text/html')
  const text = String(doc.body?.textContent ?? '')
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((s) => s.trimEnd())
    .join('\n')
    .trim()
}

function resolvePath(basePath: string, href: string) {
  if (!href) return ''
  if (/^[a-z]+:/i.test(href)) return href
  const base = basePath.replace(/\\/g, '/').split('/').slice(0, -1)
  const parts = href.replace(/\\/g, '/').split('/')
  for (const p of parts) {
    if (!p || p === '.') continue
    if (p === '..') base.pop()
    else base.push(p)
  }
  return base.join('/')
}

function pickTitle(rawHtml: string, fallback: string) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(rawHtml, 'text/html')
  const h = doc.querySelector('h1,h2,h3,title')?.textContent?.trim()
  return h || fallback
}

function isLikelyEpubFrontMatter(input: {
  idref: string
  href: string
  mediaType: string
  title: string
  contentText: string
  orderIndex: number
}) {
  const idref = String(input.idref ?? '').toLowerCase()
  const href = String(input.href ?? '').toLowerCase()
  const mediaType = String(input.mediaType ?? '').toLowerCase()
  const title = String(input.title ?? '').trim().toLowerCase()
  const text = String(input.contentText ?? '').trim().toLowerCase()

  if (input.orderIndex <= 3) {
    if (/\b(cover|toc|nav|contents)\b/.test(idref)) return true
    if (/\b(cover|toc|nav|contents?)\b/.test(href)) return true
    if (mediaType.includes('application/x-dtbncx+xml')) return true
    if (/^(cover|table\s+of\s+contents|contents?|目录|封面|扉页)$/.test(title)) return true
    if (text.length > 0 && text.length <= 260 && /(table\s+of\s+contents|目录|contents?)/.test(text)) return true
  }

  return false
}

async function importTxt(file: File): Promise<ImportedBookPayload> {
  const text = await file.text()
  const items = splitTextToChapters(text)
  return {
    title: file.name.replace(/\.txt$/i, '') || '未命名',
    sourceRef: file.name,
    items,
    format: 'txt'
  }
}

async function importEpub(file: File): Promise<ImportedBookPayload> {
  const bytes = await file.arrayBuffer()
  const zip = await JSZip.loadAsync(bytes)

  const containerXml = await zip.file('META-INF/container.xml')?.async('string')
  if (!containerXml) throw new Error('EPUB_PARSE::CONTAINER_NOT_FOUND::缺少 META-INF/container.xml')
  const container = xml.parse(containerXml)
  const rootfile =
    container?.container?.rootfiles?.rootfile?.['@_full-path'] ||
    asArray(container?.container?.rootfiles?.rootfile)[0]?.['@_full-path']
  const opfPath = String(rootfile || '').trim()
  if (!opfPath) throw new Error('EPUB_PARSE::OPF_NOT_FOUND::无法定位 OPF 文件')

  const opfXml = await zip.file(opfPath)?.async('string')
  if (!opfXml) throw new Error('EPUB_PARSE::OPF_READ_FAILED::无法读取 OPF 文件')
  const opf = xml.parse(opfXml)
  const pkg = opf?.package
  const metadata = pkg?.metadata ?? {}
  const manifestItems = asArray(pkg?.manifest?.item)
  const spineRefs = asArray(pkg?.spine?.itemref)

  const title =
    String(metadata?.['dc:title'] ?? metadata?.title ?? '')
      .replace(/\s+/g, ' ')
      .trim() || file.name.replace(/\.epub$/i, '') || '未命名'

  const idToManifest = new Map<string, { href: string; mediaType: string }>()
  for (const it of manifestItems) {
    const id = String(it?.['@_id'] ?? '').trim()
    const hrefRaw = String(it?.['@_href'] ?? '').trim()
    const mediaType = String(it?.['@_media-type'] ?? '').trim()
    const href = resolvePath(opfPath, hrefRaw)
    if (id && href) idToManifest.set(id, { href, mediaType })
  }

  const items: ImportedItem[] = []
  for (let i = 0; i < spineRefs.length; i += 1) {
    const ref = spineRefs[i]
    const idref = String(ref?.['@_idref'] ?? '').trim()
    const m = idToManifest.get(idref)
    if (!m?.href) continue
    const html = await zip.file(m.href)?.async('string')
    if (!html) continue
    const contentText = decodeHtmlToText(html)
    if (!contentText) continue
    const fallback = `章节 ${items.length + 1}`
    const title = pickTitle(html, fallback)

    if (
      isLikelyEpubFrontMatter({
        idref,
        href: m.href,
        mediaType: m.mediaType,
        title,
        contentText,
        orderIndex: i
      })
    ) {
      continue
    }

    items.push({ title, contentText })
  }

  if (items.length === 0) {
    throw new Error('EPUB_PARSE::EMPTY_CONTENT::未从 EPUB 中提取到正文章节')
  }

  return {
    title,
    sourceRef: file.name,
    items,
    format: 'epub'
  }
}

export async function importLocalBookFile(file: File): Promise<ImportedBookPayload> {
  const lower = String(file.name || '').toLowerCase()
  if (lower.endsWith('.txt')) return importTxt(file)
  if (lower.endsWith('.epub')) return importEpub(file)
  throw new Error('BOOK_IMPORT::UNSUPPORTED_FORMAT::当前仅支持 TXT / EPUB')
}
