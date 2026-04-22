import type { SiteAdapter } from '../types'

export type JjwxcAdapterDeps = {
  isJjwxcOnebookUrl: (url: string) => boolean
  cleanJjwxcChapterText: (text: string) => string
}

export function createJjwxcOnebookAdapter(deps: JjwxcAdapterDeps): SiteAdapter {
  return {
    id: 'jjwxc-onebook',
    matches: deps.isJjwxcOnebookUrl,
    postProcessText: deps.cleanJjwxcChapterText,
    ignorePagination: true
  }
}
