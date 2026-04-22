import { createBquduChapterAdapter } from './bqudu'
import { createDomainCleanerAdapter } from './domain-cleaner'
import { createJjwxcOnebookAdapter } from './jjwxc'
import { createTaduChapterAdapter } from './tadu'
import { createWereadReaderAdapter } from './weread'
import type { SiteAdapter, TocResult } from '../types'

export type SiteAdapterFactoryDeps = {
  isBquduChapterUrl: (url: string) => boolean
  extractBquduChapterContentHtml: (html: string) => string | null
  buildBquduMinimalChapterHtml: (shellHtml: string, partHtml: string) => string
  isWereadReaderUrl: (url: string) => boolean
  extractWereadChapterContentHtml: (html: string) => string | null
  buildWereadMinimalChapterHtml: (shellHtml: string, partHtml: string) => string
  cleanWereadReaderNoise: (text: string) => string
  detectWereadReaderTOC: (url: string, html: string) => TocResult | null
  createWereadAuthRequiredError: () => Error
  isTaduChapterUrl: (url: string) => boolean
  fetchTaduPartContentHtml: (pageUrl: string, html: string) => Promise<string | null>
  buildTaduMinimalChapterHtml: (shellHtml: string, partHtml: string) => string
  hasTaduInjectedChapterBody: (document: Document) => boolean
  isJjwxcOnebookUrl: (url: string) => boolean
  cleanJjwxcChapterText: (text: string) => string
  isTaduUrl: (url: string) => boolean
  cleanNovelReaderUiNoise: (text: string) => string
  isReadnovelUrl: (url: string) => boolean
}

export function createSiteAdapters(deps: SiteAdapterFactoryDeps): SiteAdapter[] {
  return [
    createBquduChapterAdapter({
      isBquduChapterUrl: deps.isBquduChapterUrl,
      extractBquduChapterContentHtml: deps.extractBquduChapterContentHtml,
      buildBquduMinimalChapterHtml: deps.buildBquduMinimalChapterHtml
    }),
    createWereadReaderAdapter({
      isWereadReaderUrl: deps.isWereadReaderUrl,
      extractWereadChapterContentHtml: deps.extractWereadChapterContentHtml,
      buildWereadMinimalChapterHtml: deps.buildWereadMinimalChapterHtml,
      cleanWereadReaderNoise: deps.cleanWereadReaderNoise,
      detectWereadReaderTOC: deps.detectWereadReaderTOC,
      createWereadAuthRequiredError: deps.createWereadAuthRequiredError
    }),
    createTaduChapterAdapter({
      isTaduChapterUrl: deps.isTaduChapterUrl,
      fetchTaduPartContentHtml: deps.fetchTaduPartContentHtml,
      buildTaduMinimalChapterHtml: deps.buildTaduMinimalChapterHtml,
      hasTaduInjectedChapterBody: deps.hasTaduInjectedChapterBody
    }),
    createJjwxcOnebookAdapter({
      isJjwxcOnebookUrl: deps.isJjwxcOnebookUrl,
      cleanJjwxcChapterText: deps.cleanJjwxcChapterText
    }),
    createDomainCleanerAdapter({
      id: 'tadu-domain',
      matches: deps.isTaduUrl,
      cleanText: deps.cleanNovelReaderUiNoise
    }),
    createDomainCleanerAdapter({
      id: 'readnovel-domain',
      matches: deps.isReadnovelUrl,
      cleanText: deps.cleanNovelReaderUiNoise
    })
  ]
}
