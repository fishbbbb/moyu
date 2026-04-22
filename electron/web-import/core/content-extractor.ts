import type { JSDOM } from 'jsdom'
import type { ExtractResult } from '../types'

type FallbackExtractorDeps = {
  findBestDensityCandidate: (document: Document) => Element | null
  cleanNodeForText: (node: Element) => Element
  normalizeText: (text: string) => string
}

export function fallbackExtractCore(dom: JSDOM, deps: FallbackExtractorDeps): ExtractResult | null {
  const best = deps.findBestDensityCandidate(dom.window.document)
  if (!best) return null
  const cleaned = deps.cleanNodeForText(best)
  const textContent = deps.normalizeText(cleaned.textContent || '')
  return {
    title: dom.window.document.title || '',
    content: cleaned.innerHTML,
    textContent,
    length: textContent.length
  }
}

type StructuredExtractorDeps = {
  normalizeText: (text: string) => string
  shouldIgnoreMetaDescriptionBySite: (url: string) => boolean
  collectStructuredText: (value: unknown, out: string[]) => void
  escapeHtml: (s: string) => string
}

export function extractStructuredDataCore(dom: JSDOM, sourceUrl: string, deps: StructuredExtractorDeps): ExtractResult | null {
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
      deps.collectStructuredText(parsed, bodies)
    } catch {
      // ignore malformed JSON-LD
    }
  }

  const ignoreMetaDesc = deps.shouldIgnoreMetaDescriptionBySite(sourceUrl) && bodies.length === 0
  const textContent = deps.normalizeText([...(bodies || []), ignoreMetaDesc ? '' : descFromMeta].filter(Boolean).join('\n\n'))
  if (!textContent) return null

  const content = textContent
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${deps.escapeHtml(line)}</p>`)
    .join('')

  return {
    title: titleFromMeta || document.title || '',
    content,
    textContent,
    length: textContent.length
  }
}
