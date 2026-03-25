export type SplitItem = { title: string; contentText: string }

export type ChapterSplitOptions = {
  /** 若章节命中少于该值，则退化为“全文” */
  minHits: number
  /** 若平均间隔小于该值（单位：行），认为可能是误切，退化为“全文” */
  minAvgGapLines: number
  /** 只有当命中章节数达到该值时，才启用“过密退化全文”的保护（避免短文误伤） */
  denseGuardMinHits: number
  /** 若第一章不从开头开始，且开头内容（去空白后）不少于该长度，则补一个“开头”章节 */
  minHeadContentCharsNoSpace: number
  /** 返回的“全文”标题 */
  fullTitle: string
  /** 返回的“开头”标题 */
  headTitle: string
}

export const DEFAULT_CHAPTER_SPLIT_OPTIONS: ChapterSplitOptions = {
  minHits: 2,
  minAvgGapLines: 4,
  denseGuardMinHits: 8,
  minHeadContentCharsNoSpace: 80,
  fullTitle: '全文',
  headTitle: '开头'
}

function clampInt(n: number, min: number, max: number) {
  const x = Number.isFinite(n) ? Math.floor(n) : min
  return Math.max(min, Math.min(max, x))
}

function normalizeBlankLines(text: string) {
  // 把“只有空白/全角空格”的行视为真正空行，并彻底移除所有空行：
  // 单行阅读时避免出现“隔一页空一页有”的体验问题。
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t\u3000]+$/g, ''))
    .filter((l) => l.replace(/[ \t\u3000]/g, '').length > 0)
  return lines.join('\n')
}

export function splitTextToChapters(inputText: string, options?: Partial<ChapterSplitOptions>): SplitItem[] {
  const opt: ChapterSplitOptions = { ...DEFAULT_CHAPTER_SPLIT_OPTIONS, ...(options ?? {}) }
  const rawLines = String(inputText ?? '').replace(/\r\n/g, '\n').split('\n')

  const chapterReList: RegExp[] = [
    // 常见：第X章/回/节/卷/话/集/篇/幕/部（允许无标题、允许用空格或标点分隔）
    /^\s*第\s*[零一二三四五六七八九十百千两0-9]+\s*[章回节卷话集篇幕部][\s:：\-—_.、·]*.*$/,
    /^\s*Chapter\s+\d+\b.*$/i,
    /^\s*CHAPTER\s+\d+\b.*$/,
    // “卷 X”这类（不带“第”）
    /^\s*卷\s*[零一二三四五六七八九十百千两0-9]+[\s:：\-—_.、·]*.*$/,
    // 非数字章节名：序章/楔子/引子/前言/后记/终章/尾声/番外等（常见于轻小说/网文）
    /^\s*(序章|序|楔子|引子|前言|扉页|正文|后记|完结感言|终章|最终章|尾声|番外|外传|附录|幕间|间章)[\s:：\-—_.、·]*.*$/,
    // 英文非数字章节名
    /^\s*(Prologue|Epilogue|Afterword|Preface|Appendix|Interlude|Extra)\b[\s:：\-—_.、·]*.*$/i
  ]

  const isLikelyHeadingLine = (lineTrimmed: string, prevTrimmed: string, nextTrimmed: string) => {
    if (!lineTrimmed) return false
    // 避免正文句子误判成标题：标题行一般不会有明显句末/逗号类标点
    if (/[。！？；;：:，,]/.test(lineTrimmed)) return false
    // 太长的行更像正文
    if (lineTrimmed.length > 60) return false
    // 标题行往往“独立成行”
    const isolated = !prevTrimmed || !nextTrimmed
    const shortEnough = lineTrimmed.length <= 40
    return isolated || shortEnough
  }

  const hits: Array<{ title: string; lineIndex: number }> = []
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]?.trim() ?? ''
    if (!line) continue
    if (!chapterReList.some((re) => re.test(line))) continue
    const prevTrimmed = (rawLines[i - 1] ?? '').trim()
    const nextTrimmed = (rawLines[i + 1] ?? '').trim()
    if (!isLikelyHeadingLine(line, prevTrimmed, nextTrimmed)) continue
    hits.push({ title: line, lineIndex: i })
  }

  const makeContent = (start: number, end: number) => normalizeBlankLines(rawLines.slice(start, end).join('\n')).trim()

  if (hits.length < clampInt(opt.minHits, 1, 9999)) {
    const contentText = normalizeBlankLines(rawLines.join('\n')).trim()
    return [{ title: opt.fullTitle, contentText }]
  }

  // 兜底：章节标题过密时退化为“全文”
  const gaps: number[] = []
  for (let i = 1; i < hits.length; i++) gaps.push((hits[i]!.lineIndex ?? 0) - (hits[i - 1]!.lineIndex ?? 0))
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 999
  const denseGuardMinHits = clampInt(opt.denseGuardMinHits, 0, 9999)
  if (hits.length >= denseGuardMinHits && avgGap < clampInt(opt.minAvgGapLines, 0, 9999)) {
    const contentText = normalizeBlankLines(rawLines.join('\n')).trim()
    return [{ title: opt.fullTitle, contentText }]
  }

  const items: SplitItem[] = []

  // 兜底：第一章不从文件开头开始则补“开头”
  const firstStart = hits[0]!.lineIndex
  if (firstStart > 0) {
    const headText = makeContent(0, firstStart)
    if (headText.replace(/\s+/g, '').length >= clampInt(opt.minHeadContentCharsNoSpace, 0, 1_000_000)) {
      items.push({ title: opt.headTitle, contentText: headText })
    }
  }

  for (let i = 0; i < hits.length; i++) {
    const start = hits[i]!.lineIndex
    const end = i + 1 < hits.length ? hits[i + 1]!.lineIndex : rawLines.length
    const contentText = makeContent(start, end)
    items.push({ title: hits[i]!.title, contentText })
  }

  return items.filter((it) => String(it.contentText ?? '').trim().length > 0)
}

