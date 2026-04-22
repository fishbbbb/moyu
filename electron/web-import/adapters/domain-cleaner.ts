import type { SiteAdapter } from '../types'

export type DomainCleanerAdapterDeps = {
  id: string
  matches: (url: string) => boolean
  cleanText: (text: string) => string
}

export function createDomainCleanerAdapter(deps: DomainCleanerAdapterDeps): SiteAdapter {
  return {
    id: deps.id,
    matches: deps.matches,
    postProcessText: deps.cleanText
  }
}
