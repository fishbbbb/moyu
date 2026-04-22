export type ContentStrategy = 'structured' | 'readability' | 'heuristic' | 'manual'

export type ExtractPipelineDebug = {
  candidateScores: Partial<Record<Exclude<ContentStrategy, 'manual'>, number>>
  rankedOrder: ContentStrategy[]
  selectedStrategy: Exclude<ContentStrategy, 'manual'>
}

export type ExtractResult = {
  title: string
  content: string
  textContent: string
  length: number
  source?: ContentStrategy
  debug?: ExtractPipelineDebug
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

export type NavNextCandidate = {
  url: string
  label: string
  confidence: number
  reason: string
}

export type NavigationResult = {
  nextUrl?: string
  prevUrl?: string
  nextConfidence?: number
  nextReason?: string
  prevConfidence?: number
  prevReason?: string
  nextCandidates?: NavNextCandidate[]
}

export type WebNextChapterCandidate = NavNextCandidate

export type ResolvedNextChapter = {
  nextUrl?: string
  nextConfidence: number
  nextReason: string
  source: 'toc' | 'nav' | 'none'
  needsConfirmation?: boolean
  candidates?: WebNextChapterCandidate[]
}

export type TocStatus = 'ready' | 'partial' | 'missing'
export type TocSource = 'list' | 'table' | 'mixed' | 'chapter_metadata' | 'none'

export type TocResult = {
  isTocPage: boolean
  tocUrlCandidate?: string
  entries: Array<{ title: string; url: string }>
  tocStatus: TocStatus
  tocSource: TocSource
}

export type ExtractorOptions = {
  minTextLength?: number
  keepImages?: boolean
}

export type SitePreExtractContext = {
  url: string
  html: string
}

export type SitePreExtractResult = {
  htmlForExtraction?: string
  error?: Error
}

export type SiteAdapter = {
  id: string
  matches: (url: string) => boolean
  preExtract?: (ctx: SitePreExtractContext) => Promise<SitePreExtractResult | null>
  postProcessText?: (text: string) => string
  ignorePagination?: boolean
  shouldIgnoreMetaDescription?: boolean
  hasInjectedChapterBody?: (document: Document) => boolean
  detectTOC?: (ctx: { url: string; html: string }) => TocResult | null
}
