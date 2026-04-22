import type { SiteAdapter } from '../types'

export type TaduAdapterDeps = {
  isTaduChapterUrl: (url: string) => boolean
  fetchTaduPartContentHtml: (pageUrl: string, html: string) => Promise<string | null>
  buildTaduMinimalChapterHtml: (shellHtml: string, partHtml: string) => string
  hasTaduInjectedChapterBody: (document: Document) => boolean
}

export function createTaduChapterAdapter(deps: TaduAdapterDeps): SiteAdapter {
  return {
    id: 'tadu-chapter',
    matches: deps.isTaduChapterUrl,
    preExtract: async ({ url, html }) => {
      const part = await deps.fetchTaduPartContentHtml(url, html)
      if (!part) return null
      return { htmlForExtraction: deps.buildTaduMinimalChapterHtml(html, part) }
    },
    hasInjectedChapterBody: deps.hasTaduInjectedChapterBody
  }
}
