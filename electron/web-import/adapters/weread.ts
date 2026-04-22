import type { SiteAdapter, TocResult } from '../types'

export type WereadAdapterDeps = {
  isWereadReaderUrl: (url: string) => boolean
  extractWereadChapterContentHtml: (html: string) => string | null
  buildWereadMinimalChapterHtml: (shellHtml: string, partHtml: string) => string
  cleanWereadReaderNoise: (text: string) => string
  detectWereadReaderTOC: (url: string, html: string) => TocResult | null
  createWereadAuthRequiredError: () => Error
}

export function createWereadReaderAdapter(deps: WereadAdapterDeps): SiteAdapter {
  return {
    id: 'weread-reader',
    matches: deps.isWereadReaderUrl,
    preExtract: async ({ html }) => {
      const part = deps.extractWereadChapterContentHtml(html)
      if (part) return { htmlForExtraction: deps.buildWereadMinimalChapterHtml(html, part) }
      return {
        error: deps.createWereadAuthRequiredError()
      }
    },
    postProcessText: deps.cleanWereadReaderNoise,
    shouldIgnoreMetaDescription: true,
    detectTOC: ({ url, html }) => deps.detectWereadReaderTOC(url, html)
  }
}
