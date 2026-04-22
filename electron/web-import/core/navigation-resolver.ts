import type { NavigationResult, NavNextCandidate, ResolvedNextChapter } from '../types'

type CollectNavNextCandidatesArgs = {
  scored: Array<{ text: string; url: string; score: number }>
  primaryUrl: string | undefined
  primaryConf: number | undefined
  primaryReason: string | undefined
  seenFingerprints: Set<string>
  urlFingerprint: (url: string) => string
  isNextText: (text: string) => boolean
}

export function collectNavNextCandidatesCore(args: CollectNavNextCandidatesArgs): NavNextCandidate[] {
  const { scored, primaryUrl, primaryConf, primaryReason, seenFingerprints, urlFingerprint, isNextText } = args
  const out: NavNextCandidate[] = []
  const add = (url: string, label: string, confidence: number, reason: string) => {
    if (!url || seenFingerprints.has(urlFingerprint(url))) return
    if (out.some((x) => urlFingerprint(x.url) === urlFingerprint(url))) return
    out.push({
      url,
      label: label.slice(0, 56) || '下一章',
      confidence,
      reason
    })
  }

  if (primaryUrl && primaryConf !== undefined) {
    add(primaryUrl, '系统推荐', primaryConf, primaryReason || 'primary')
  }

  for (const item of scored) {
    if (!item.url) continue
    const looksNext =
      isNextText(item.text) ||
      (/第\s*[0-9零一二三四五六七八九十百千]+\s*[章回节卷]/i.test(item.text) && item.score >= 48) ||
      (/next|下一篇/i.test(item.text) && item.score >= 52)
    if (!looksNext) continue
    const conf = Math.min(0.88, 0.48 + item.score / 200)
    add(item.url, item.text, conf, 'anchor_guess')
    if (out.length >= 8) break
  }

  out.sort((a, b) => b.confidence - a.confidence)
  return out.slice(0, 6)
}

type ResolveNextChapterArgs = {
  pageUrl: string
  tocEntries: Array<{ title: string; url: string }>
  nav: NavigationResult
  urlFingerprint: (url: string) => string
}

export function resolveNextChapterCore(args: ResolveNextChapterArgs): ResolvedNextChapter {
  const { pageUrl, tocEntries, nav, urlFingerprint } = args

  let curHost = ''
  try {
    curHost = new URL(pageUrl).hostname
  } catch {
    curHost = ''
  }

  const looksLikeChapterUrl = (rawUrl: string) => {
    if (!rawUrl) return false
    try {
      const u = new URL(rawUrl)
      if (u.pathname === '/' || u.pathname.length <= 1) return false
      // For toc-adjacent inference, same-host links are usually safe to treat as chapter candidates.
      // This avoids over-filtering non-standard chapter URL patterns.
      if (curHost && u.hostname === curHost) return true
      const p = u.pathname.toLowerCase()
      const q = u.search || ''
      if (/(chapter|reader|read|content)\b/i.test(p)) return true
      if (/(?:[?&])(cid|chapterid|chapter)=\d+/i.test(q)) return true
      if (/\/\d+[-_]\d+/.test(p)) return true
      // Fallback: long numeric ids are typical for chapter pages.
      return /\d{5,}/.test(p)
    } catch {
      return /\/(chapter|reader|read|content)\b/i.test(rawUrl) || /(?:[?&])(cid|chapterid|chapter)=\d+/i.test(rawUrl)
    }
  }

  const curFp = urlFingerprint(pageUrl)
  const idx = tocEntries.findIndex((e) => urlFingerprint(e.url) === curFp)
  if (idx >= 0 && idx + 1 < tocEntries.length) {
    const next = tocEntries[idx + 1]
    if (!looksLikeChapterUrl(next.url)) {
      return { nextConfidence: 0, nextReason: 'toc_adjacent_unplausible', source: 'none' }
    }
    return {
      nextUrl: next.url,
      nextConfidence: 0.92,
      nextReason: 'toc_adjacent',
      source: 'toc',
      needsConfirmation: false,
      candidates: [{ url: next.url, label: next.title, confidence: 0.92, reason: 'toc_adjacent' }]
    }
  }

  const pool = [...(nav.nextCandidates ?? [])]
  if (nav.nextUrl && !pool.some((c) => urlFingerprint(c.url) === urlFingerprint(nav.nextUrl || ''))) {
    pool.unshift({
      url: nav.nextUrl,
      label: '系统推荐',
      confidence: nav.nextConfidence ?? 0.5,
      reason: nav.nextReason || 'nav_primary'
    })
  }
  const viable = pool.filter((c) => c.confidence >= 0.45)
  if (!viable.length) {
    return { nextConfidence: 0, nextReason: 'none', source: 'none' }
  }

  viable.sort((a, b) => b.confidence - a.confidence)
  const best = viable[0]

  if (best.confidence >= 0.75) {
    return {
      nextUrl: best.url,
      nextConfidence: best.confidence,
      nextReason: best.reason,
      source: 'nav',
      needsConfirmation: false,
      candidates: [best]
    }
  }

  if (best.confidence >= 0.45 && best.confidence < 0.75) {
    return {
      needsConfirmation: true,
      candidates: viable.slice(0, 6),
      nextConfidence: best.confidence,
      nextReason: 'pending_user_choice',
      source: 'nav'
    }
  }

  return { nextConfidence: 0, nextReason: 'none', source: 'none' }
}
