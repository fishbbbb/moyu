import type { SiteAdapter } from '../types'

export type BquduAdapterDeps = {
  isBquduChapterUrl: (url: string) => boolean
  extractBquduChapterContentHtml: (html: string) => string | null
  buildBquduMinimalChapterHtml: (shellHtml: string, partHtml: string) => string
}

export function createBquduChapterAdapter(deps: BquduAdapterDeps): SiteAdapter {
  return {
    id: 'bqudu-chapter',
    matches: deps.isBquduChapterUrl,
    preExtract: async ({ html }) => {
      const part = deps.extractBquduChapterContentHtml(html)
      if (!part) return null
      return { htmlForExtraction: deps.buildBquduMinimalChapterHtml(html, part) }
    }
  }
}
