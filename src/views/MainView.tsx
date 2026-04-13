import React, { useEffect, useMemo, useRef, useState } from 'react'
import { importLocalBookFile } from '../utils/ebookImport'

type OverlayConfig = {
  bgOpacity: number
  bgColor: string
  textColor: string
  fontSize: number
  rows: number
  cols: number
  contentProtection?: boolean
  autoSpeed: boolean
  speedMs: number
  charsPerMinute: number
  linesPerTick: number
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function reflowToCols(text: string, cols: number) {
  const c = clamp(Math.floor(cols || 48), 10, 400)
  const rawLines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((s) => s.replace(/\t/g, '    ').trimEnd())

  const out: string[] = []
  for (const raw of rawLines) {
    if (raw.length === 0) {
      out.push('')
      continue
    }
    for (let i = 0; i < raw.length; i += c) out.push(raw.slice(i, i + c))
  }
  // 避免空数组导致 overlay 显示异常
  return out.length > 0 ? out : ['']
}

function toRawLines(text: string) {
  const rawLines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((s) => s.replace(/\t/g, '    ').trimEnd())
  return rawLines.length > 0 ? rawLines : ['']
}

function calcSpeedMs(input: { cols: number; linesPerTick: number }) {
  const charsPerMinute = 1800
  const cols = Math.max(1, Math.floor(input.cols || 48))
  const linesPerTick = clamp(Math.floor(input.linesPerTick || 1), 1, 10)
  const charsPerTick = Math.max(1, cols * linesPerTick)
  const ms = Math.round((60_000 * charsPerTick) / charsPerMinute)
  return clamp(ms, 80, 5000)
}

function calcSpeedMsFromCpm(input: {
  cols: number
  rows?: number
  linesPerTick: number
  charsPerMinute: number
}) {
  const cpm = clamp(Math.floor(input.charsPerMinute || 100), 1, 1000)
  const cols = Math.max(1, Math.floor(input.cols || 48))
  const rows = Math.max(1, Math.floor(input.rows ?? 1))
  const linesPerTick = clamp(Math.floor(input.linesPerTick || 1), 1, 10)
  const charsPerTick = Math.max(1, cols * linesPerTick)
  let ms = Math.round((60_000 * charsPerTick) / cpm)
  const minPageMs = 2800
  const minMsPerTickFromPage = Math.round((minPageMs * Math.max(1, linesPerTick)) / rows)
  ms = clamp(ms, Math.max(900, minMsPerTickFromPage), 30_000)
  return ms
}

type BookSummary = {
  id: string
  title: string
  sourceType: 'file' | 'url'
  sourceRef: string
  domain?: string | null
  groupId?: string | null
  createdAt: number
  updatedAt: number
  lastReadAt: number | null
}

type GroupRow = {
  id: string
  title: string
  parentId: string | null
  orderIndex: number
  createdAt: number
  updatedAt: number
}

type BookDetail = {
  book: { id: string; title: string }
  items: Array<{ id: string; title: string; orderIndex: number; contentText: string; sourceUrl?: string | null }>
  progress: { bookId: string; itemId: string; lineIndex: number; updatedAt: number } | null
}

type WebExtractErrorInfo = {
  code: string
  message: string
}

type ToastState = {
  id: number
  type: 'success' | 'error'
  message: string
  sticky?: boolean
  durationMs?: number
  actionLabel?: string
  onAction?: () => void
}

const LS = { cfg: 'overlay:cfg', cfgLegacy: 'demo:cfg' } as const

function setJson(key: string, val: unknown) {
  localStorage.setItem(key, JSON.stringify(val))
}

function getJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function getCfgWithMigration(fallback: OverlayConfig): OverlayConfig {
  const next = getJson<OverlayConfig>(LS.cfg, fallback)
  if (next && typeof next === 'object') return next
  const legacy = getJson<OverlayConfig>(LS.cfgLegacy, fallback)
  if (legacy && typeof legacy === 'object') return legacy
  return fallback
}

export function MainView() {
  const initialCfg = useMemo<OverlayConfig>(() => {
    return getCfgWithMigration({
      bgOpacity: 0,
      bgColor: '#000000',
      textColor: '#ffffff',
      fontSize: 16,
      rows: 1,
      cols: 48,
      autoSpeed: true,
      charsPerMinute: 100,
      speedMs: calcSpeedMsFromCpm({ cols: 48, rows: 1, linesPerTick: 1, charsPerMinute: 100 }),
      linesPerTick: 1,
      contentProtection: false
    })
  }, [])

  const [cfg, setCfg] = useState<OverlayConfig>(initialCfg)
  const [books, setBooks] = useState<BookSummary[]>([])
  const [remoteSearchBooks, setRemoteSearchBooks] = useState<BookSummary[] | null>(null)
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [tab, setTab] = useState<'all' | 'file' | 'url'>('all')
  const [groupFilter, setGroupFilter] = useState<string | null | '__all__'>('__all__')
  const [q, setQ] = useState('')
  const [selectedBookIds, setSelectedBookIds] = useState<Record<string, boolean>>({})
  const [activeBookId, setActiveBookId] = useState<string | null>(null)
  const [active, setActive] = useState<BookDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showChapters, setShowChapters] = useState(true)

  const [webUrl, setWebUrl] = useState('')
  const [webLoading, setWebLoading] = useState(false)
  const [webErr, setWebErr] = useState<string | null>(null)
  const [webErrCode, setWebErrCode] = useState<string | null>(null)
  const [webErrExpanded, setWebErrExpanded] = useState(false)
  const [webMode, setWebMode] = useState<'article' | 'book'>('article')
  const [webPreview, setWebPreview] = useState<{
    title: string
    url: string
    domain: string | null
    contentText: string
    preview: string
    extractDebug?: unknown
  } | null>(null)
  const [webBookPreview, setWebBookPreview] = useState<{
    bookTitle: string
    detailUrl: string
    domain: string | null
    introText: string
    chapters: Array<{ title: string; url: string }>
    tocStatus?: 'ready' | 'partial' | 'missing'
  } | null>(null)
  const [webBookId, setWebBookId] = useState<string | null>(null)
  /** 结构化抽取后「下一章」处于 0.45~0.75 置信区间：主窗口展示候选供用户打开核验 */
  const [webPendingNextChapter, setWebPendingNextChapter] = useState<null | {
    itemId: string
    bookId: string | null
    chapterTitle: string
    candidates: Array<{ url: string; label: string; confidence: number; reason: string }>
  }>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const chapterListRef = useRef<HTMLDivElement | null>(null)
  const [chapterScrollTop, setChapterScrollTop] = useState(0)
  const importTxtInputRef = useRef<HTMLInputElement | null>(null)

  function applyCfg(next: OverlayConfig) {
    setCfg(next)
    setJson(LS.cfg, next)
  }

  function showToast(next: Omit<ToastState, 'id'>) {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current)
      toastTimerRef.current = null
    }
    const t: ToastState = { id: Date.now(), ...next }
    setToast(t)
    if (!t.sticky) {
      toastTimerRef.current = window.setTimeout(() => {
        setToast((cur) => (cur?.id === t.id ? null : cur))
        toastTimerRef.current = null
      }, Math.max(1200, Number(t.durationMs ?? (t.type === 'error' ? 6000 : 2200))))
    }
  }

  const groupOptions = useMemo(() => {
    const byParent = new Map<string | null, GroupRow[]>()
    for (const g of groups) {
      const k = g.parentId ?? null
      const list = byParent.get(k) ?? []
      list.push(g)
      byParent.set(k, list)
    }
    for (const [k, list] of byParent) {
      list.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0) || a.title.localeCompare(b.title))
      byParent.set(k, list)
    }

    const out: Array<{ id: string; label: string }> = []
    const walk = (parentId: string | null, depth: number) => {
      const kids = byParent.get(parentId) ?? []
      for (const g of kids) {
        out.push({ id: g.id, label: `${'—'.repeat(Math.min(6, depth))}${depth ? ' ' : ''}${g.title}` })
        walk(g.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [groups])

  async function refreshLibrary(selectBookId?: string) {
    setErr(null)
    setNotice(null)
    const [resBooks, resGroups] = await Promise.all([
      (window.api?.libraryListBooks?.() as any) ?? Promise.resolve({ books: [] }),
      (window.api?.libraryListGroups?.() as any) ?? Promise.resolve({ groups: [] })
    ])
    const nextBooks = (resBooks?.books ?? []) as BookSummary[]
    const nextGroups = (resGroups?.groups ?? []) as GroupRow[]
    setBooks(nextBooks)
    setGroups(nextGroups)

    const preferred = selectBookId ?? activeBookId ?? null
    const chosen =
      preferred && nextBooks.some((b) => b.id === preferred) ? preferred : (nextBooks[0]?.id ?? null)
    setActiveBookId(chosen)
    if (chosen) await loadBook(chosen)
    else setActive(null)
    if (selectBookId) {
      const picked = nextBooks.find((b) => b.id === selectBookId)
      // 仅允许把网页章节“追加保存”到网页书（sourceType='url'）里，避免误挂到本地书导致 BOOK_TYPE_MISMATCH。
      setWebBookId(picked?.sourceType === 'url' ? selectBookId : null)
    }
  }

  async function loadBook(bookId: string) {
    setErr(null)
    setLoading(true)
    try {
      const res = (await window.api?.libraryGetBook?.(bookId)) as any
      setActive(res as BookDetail)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setActive(null)
    } finally {
      setLoading(false)
    }
  }

  async function startReading(bookId: string, itemId: string, lineIndex: number) {
    setWebPendingNextChapter(null)
    const it = active?.items.find((x) => x.id === itemId)
    if (!it) return
    const contentText = String(it.contentText ?? '').trim()
    if (!contentText) {
      // 网页书籍导入时章节正文是“按需提取”的：点击章节也应该自动提取一次，避免空白。
      const fetched = await ensureItemHasContent(itemId, (it as any)?.sourceUrl ?? null)
      if (!fetched) {
        setNotice(null)
        setErr('该章节未能提取到正文：可能需要登录/购买，或站点为动态渲染/反爬。')
        return
      }
      // ensureItemHasContent 内部会刷新 active；这里用 fetched 直接打开阅读条，避免再次等待。
      const lines = toRawLines(fetched)
      await window.api?.overlayPushSession?.({ bookId, itemId, lines, lineIndex, playing: false })
      return
    }
    // 重要：只推“原始行”，具体按窗口宽度/字号换行交给 Overlay 端做
    const lines = toRawLines(contentText)
    await window.api?.overlayPushSession?.({ bookId, itemId, lines, lineIndex, playing: false })
  }

  async function onImportTxt(file: File) {
    setErr(null)
    setNotice(null)
    try {
      const payload = await importLocalBookFile(file)
      if (!payload.items.length) {
        setErr('导入失败：未提取到可读内容。')
        return
      }
      if (payload.format === 'txt' && payload.items.length === 1 && payload.items[0]?.title === '全文') {
        setNotice('未识别到章节目录，已按“全文”导入（你仍可正常阅读）。')
      }
      if (payload.format === 'epub') {
        setNotice(`EPUB 导入完成：共 ${payload.items.length} 章。`)
      }
      const res = (await window.api?.libraryImportTxt?.({
        title: payload.title,
        sourceRef: payload.sourceRef,
        items: payload.items
      })) as any
      await refreshLibrary(res?.bookId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('BOOK_IMPORT::UNSUPPORTED_FORMAT')) {
        setErr('当前仅支持导入 TXT / EPUB。')
      } else if (msg.includes('EPUB_PARSE::')) {
        setErr(msg.split('::').slice(2).join('::') || 'EPUB 解析失败。')
      } else {
        setErr(msg)
      }
    } finally {
      if (importTxtInputRef.current) importTxtInputRef.current.value = ''
    }
  }

  async function onRenameActiveBook() {
    if (!activeBookId) return
    const curTitle = active?.book.title ?? ''
    const next = window.prompt('重命名书籍', curTitle)
    if (!next) return
    const title = next.trim()
    if (!title) return
    try {
      await window.api?.bookRename?.({ bookId: activeBookId, newTitle: title })
      await refreshLibrary(activeBookId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  function selectedIdsList() {
    return Object.entries(selectedBookIds)
      .filter(([, v]) => v)
      .map(([k]) => k)
  }

  async function onCreateGroup(parentId: string | null) {
    const next = window.prompt('新建分组', '')
    if (!next) return
    const title = next.trim()
    if (!title) return
    try {
      await window.api?.libraryCreateGroup?.({ title, parentId })
      await refreshLibrary(activeBookId ?? undefined)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function onRenameGroup(groupId: string) {
    const cur = groups.find((g) => g.id === groupId)?.title ?? ''
    const next = window.prompt('重命名分组', cur)
    if (!next) return
    const title = next.trim()
    if (!title) return
    try {
      await window.api?.libraryRenameGroup?.({ groupId, title })
      await refreshLibrary(activeBookId ?? undefined)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function onDeleteGroup(groupId: string) {
    const g = groups.find((x) => x.id === groupId)
    const name = g?.title ?? '该分组'
    const modeRaw = window.prompt(`删除分组「${name}」：\n输入 1=仅删除分组（书保留到未分组）\n输入 2=连同分组下书籍一起删除`, '1')
    if (!modeRaw) return
    const mode = modeRaw.trim() === '2' ? 'deleteBooks' : 'keepBooks'
    const ok = window.confirm(mode === 'deleteBooks' ? '确认删除分组并删除其下所有书籍？此操作不可恢复。' : '确认删除分组？书籍会保留到未分组。')
    if (!ok) return
    try {
      await window.api?.libraryDeleteGroup?.({ groupId, mode })
      if (groupFilter === groupId) setGroupFilter('__all__')
      await refreshLibrary(activeBookId ?? undefined)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function onMoveBooks(bookIds: string[], nextGroupId: string | null) {
    try {
      await window.api?.libraryMoveBooks?.({ bookIds, groupId: nextGroupId })
      await refreshLibrary(activeBookId ?? undefined)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function onDeleteBooks(bookIds: string[]) {
    const ok = window.confirm(`确认删除 ${bookIds.length} 本书？将同时删除其章节与阅读进度，此操作不可恢复。`)
    if (!ok) return
    try {
      const res = (await window.api?.bookDeleteMany?.({ bookIds })) as any
      setSelectedBookIds({})
      await refreshLibrary(undefined)
      const deletedCount = Number(res?.deletedCount ?? 0)
      setNotice(`已删除 ${deletedCount} 本书。`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function onOpenWeb() {
    setWebErr(null)
    setWebErrCode(null)
    setWebErrExpanded(false)
    setNotice(null)
    const url = webUrl.trim()
    if (!url) {
      setWebErr('请输入要打开的网页地址。')
      return
    }
    setWebLoading(true)
    try {
      await window.api?.webOpen?.({ url })
    } catch (e) {
      setWebErr(e instanceof Error ? e.message : String(e))
    } finally {
      setWebLoading(false)
    }
  }

  async function onExtractWeb() {
    setWebErr(null)
    setWebErrCode(null)
    setWebErrExpanded(false)
    setWebLoading(true)
    try {
      const res = (await window.api?.webExtract?.()) as any
      const contentText = String(res?.contentText ?? '').trim()
      if (!contentText || contentText.length < 200) {
        setWebErr('未检测到正文或正文过短，请手动打开正确页面后再试。')
        setWebPreview(null)
        return
      }
      setWebPreview({
        title: String(res?.title ?? '未命名网页'),
        url: String(res?.url ?? ''),
        domain: (res?.domain as string | null) ?? null,
        contentText,
        preview: String(res?.preview ?? ''),
        extractDebug: res?.extractDebug
      })
      setWebBookPreview(null)
    } catch (e) {
      const info = parseWebExtractError(e)
      if (info) {
        setWebErrCode(info.code)
        setWebErr(info.message || '网页提取失败。')
      } else if (/NO_WEB_WINDOW/.test(e instanceof Error ? e.message : String(e))) {
        setWebErrCode('NO_WEB_WINDOW')
        setWebErr('未检测到已打开的网页窗口，请先点击“打开网页”。')
      } else {
        setWebErrCode('UNKNOWN')
        setWebErr(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setWebLoading(false)
    }
  }

  async function onExtractWebFromSelection() {
    setWebErr(null)
    setWebErrCode(null)
    setWebErrExpanded(false)
    setWebLoading(true)
    try {
      const res = (await window.api?.webExtractFromSelection?.()) as any
      const contentText = String(res?.contentText ?? '').trim()
      if (!contentText || contentText.length < 20) {
        setWebErr('未检测到有效选区内容，请先在网页中选中正文后重试。')
        setWebPreview(null)
        return
      }
      setWebPreview({
        title: String(res?.title ?? '未命名网页'),
        url: String(res?.url ?? ''),
        domain: (res?.domain as string | null) ?? null,
        contentText,
        preview: String(res?.preview ?? '')
      })
      setWebBookPreview(null)
      setNotice('已使用手动框选兜底提取（L4）。')
    } catch (e) {
      const info = parseWebExtractError(e)
      if (info) {
        setWebErrCode(info.code)
        setWebErr(info.message || '手动框选提取失败。')
      } else {
        setWebErrCode('UNKNOWN')
        setWebErr(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setWebLoading(false)
    }
  }

  async function onExtractWebBookDetail() {
    setWebErr(null)
    setWebErrCode(null)
    setWebErrExpanded(false)
    setWebLoading(true)
    try {
      const res = (await window.api?.webExtractBookDetail?.()) as any
      const chapters = Array.isArray(res?.chapters) ? (res.chapters as Array<{ t?: string; u?: string; title?: string; url?: string }>) : []
      const normalized = chapters
        .map((c) => ({ title: String((c as any).title ?? (c as any).t ?? '').trim(), url: String((c as any).url ?? (c as any).u ?? '').trim() }))
        .filter((c) => c.url)
      if (!normalized.length) {
        setWebErr('未识别到目录链接（可能不是详情页或站点结构特殊）。')
        setWebBookPreview(null)
        return
      }
      if (normalized.length <= 1) {
        setWebErr('仅识别到 1 章：请优先输入书籍简介/目录页链接再点“解析目录”（章节页通常无法拿到全目录）。')
      }
      setWebBookPreview({
        bookTitle: String(res?.bookTitle ?? '未命名网页'),
        detailUrl: String(res?.detailUrl ?? ''),
        domain: (res?.domain as string | null) ?? null,
        introText: String(res?.introText ?? ''),
        chapters: normalized,
        tocStatus: (res?.tocStatus as 'ready' | 'partial' | 'missing' | undefined) ?? undefined
      })
      setWebPreview(null)
    } catch (e) {
      const info = parseWebExtractError(e)
      if (info) {
        setWebErrCode(info.code)
        setWebErr(info.message || '解析书籍详情失败。')
      } else {
        setWebErrCode('UNKNOWN')
        setWebErr(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setWebLoading(false)
    }
  }

  async function onRefreshAndRetry() {
    setWebErr(null)
    setWebErrCode(null)
    setWebErrExpanded(false)
    setWebLoading(true)
    try {
      await window.api?.webRefresh?.()
      if (webMode === 'article') {
        await onExtractWeb()
      } else {
        await onExtractWebBookDetail()
      }
    } catch (e) {
      const info = parseWebExtractError(e)
      if (info) {
        setWebErrCode(info.code)
        setWebErr(info.message || '刷新后重试失败。')
      } else {
        setWebErrCode('UNKNOWN')
        setWebErr(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setWebLoading(false)
    }
  }

  async function onSaveWeb() {
    if (!webPreview) return
    setWebErr(null)
    setWebLoading(true)
    try {
      const res = (await window.api?.libraryImportWebItem?.({
        title: webPreview.title,
        sourceUrl: webPreview.url,
        contentText: webPreview.contentText,
        domain: webPreview.domain,
        bookId: webBookId
      })) as any
      const bookId = String(res?.bookId ?? '')
      await refreshLibrary(bookId || undefined)
      setNotice('网页正文已保存到书架。')
      setWebPreview(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'BOOK_TYPE_MISMATCH') {
        setWebErrCode('BOOK_TYPE_MISMATCH')
        setWebErr('当前选择的是本地导入书籍，不能把网页章节保存到该书中。请切换到「网页书」或清空目标书后再保存。')
      } else {
        setWebErrCode('UNKNOWN')
        setWebErr(msg)
      }
    } finally {
      setWebLoading(false)
    }
  }

  function onCancelWebPreview() {
    setWebPreview(null)
    setWebBookPreview(null)
  }

  async function onImportWebBook() {
    if (!webBookPreview) return
    setWebErr(null)
    setWebLoading(true)
    try {
      const res = (await window.api?.libraryImportWebBook?.({
        bookTitle: webBookPreview.bookTitle,
        detailUrl: webBookPreview.detailUrl,
        domain: webBookPreview.domain,
        introText: webBookPreview.introText,
        chapters: webBookPreview.chapters
      })) as any
      const bookId = String(res?.bookId ?? '')
      await refreshLibrary(bookId || undefined)
      setNotice('书籍目录已导入书架（章节正文将在阅读时按需提取）。')
      setWebBookPreview(null)
    } catch (e) {
      setWebErr(e instanceof Error ? e.message : String(e))
    } finally {
      setWebLoading(false)
    }
  }

  async function ensureItemHasContent(itemId: string, sourceUrl: string | null) {
    const it = active?.items.find((x) => x.id === itemId)
    if (!it) return null
    if (String(it.contentText ?? '').trim().length > 0) return it.contentText
    const url = String(sourceUrl ?? '').trim()
    if (!url) return null
    setWebPendingNextChapter(null)
    setNotice('正在提取章节正文…（首次进入该章节会稍慢一点）')
    const res = (await window.api?.webExtractStructuredAtUrl?.({ url })) as any
    const contentText = String(res?.content?.textContent ?? '').trim()
    if (!contentText) return null
    await window.api?.libraryUpdateItemContent?.({ itemId, contentText })
    if (activeBookId) await loadBook(activeBookId)
    if (res?.nextChapterNeedsConfirmation && Array.isArray(res?.nextChapterCandidates) && res.nextChapterCandidates.length) {
      setWebPendingNextChapter({
        itemId,
        bookId: activeBookId,
        chapterTitle: String(it.title || '').trim(),
        candidates: res.nextChapterCandidates as Array<{ url: string; label: string; confidence: number; reason: string }>
      })
      showToast({
        type: 'success',
        message: '正文已保存。下一章链接不够确定，请在下方「候选」中选一项在网页窗口打开核验。',
        sticky: false,
        durationMs: 6500
      })
    }
    return contentText
  }

  async function enterReadingAuto(bookId: string) {
    const detail = ((await window.api?.libraryGetBook?.(bookId)) as any) as BookDetail
    const itemId = detail?.progress?.itemId ?? detail?.items?.[0]?.id
    const lineIndex = detail?.progress?.lineIndex ?? 0
    if (!itemId) return
    const item = detail.items.find((x: any) => x.id === itemId)
    if (!item) return
    if (!String(item.contentText ?? '').trim()) {
      await loadBook(bookId)
      const activeItem = (active?.items ?? []).find((x) => x.id === itemId) as any
      await ensureItemHasContent(itemId, activeItem?.sourceUrl ?? null)
      const again = ((await window.api?.libraryGetBook?.(bookId)) as any) as BookDetail
      const item2 = again.items.find((x: any) => x.id === itemId)
      if (!item2) return
      const lines = toRawLines(item2.contentText)
      await window.api?.overlayPushSession?.({ bookId, itemId, lines, lineIndex, playing: true })
      return
    }
    const lines = toRawLines(item.contentText)
    await window.api?.overlayPushSession?.({ bookId, itemId, lines, lineIndex, playing: true })
  }

  useEffect(() => {
    void refreshLibrary()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current)
        toastTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!notice) return
    showToast({ type: 'success', message: notice })
  }, [notice])

  useEffect(() => {
    if (!err) return
    showToast({ type: 'error', message: err, sticky: false, durationMs: 6500 })
  }, [err])

  useEffect(() => {
    if (!webErr) return
    const canRetry = Boolean(webErrCode === 'EXTRACTION_TIMEOUT' || webErrCode === 'DOM_TOO_LARGE')
    showToast({
      type: 'error',
      message: webErr,
      sticky: false,
      durationMs: 7000,
      actionLabel: canRetry ? '重试' : undefined,
      onAction: canRetry ? (() => void onExtractWeb()) : undefined
    })
  }, [webErr, webErrCode])

  useEffect(() => {
    if (!webPreview) return
    showToast({
      type: 'success',
      message: '提取成功，可直接保存到书架',
      actionLabel: '保存',
      onAction: () => void onSaveWeb()
    })
  }, [webPreview])

  useEffect(() => {
    const qq = q.trim()
    if (!qq) {
      setRemoteSearchBooks(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = (await window.api?.bookSearch?.({ query: qq })) as any
          if (!cancelled) setRemoteSearchBooks((res?.books ?? []) as BookSummary[])
        } catch {
          if (!cancelled) setRemoteSearchBooks(null)
        }
      })()
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [q])

  const sourceBooks = remoteSearchBooks ?? books

  const filteredBooks = useMemo(() => {
    const qq = q.trim().toLowerCase()
    return sourceBooks
      .filter((b) => {
        if (tab !== 'all' && b.sourceType !== tab) return false
        if (groupFilter !== '__all__') {
          const gid = (b.groupId ?? null) as any
          if ((groupFilter ?? null) !== gid) return false
        }
        if (!qq) return true
        const hay = `${b.title ?? ''} ${(b.domain ?? '') || ''} ${(b.sourceRef ?? '') || ''}`.toLowerCase()
        return hay.includes(qq)
      })
      .sort((a, b) => Number(b.lastReadAt ?? b.updatedAt) - Number(a.lastReadAt ?? a.updatedAt))
  }, [sourceBooks, tab, groupFilter, q])

  function parseWebExtractError(input: unknown): WebExtractErrorInfo | null {
    const raw = input instanceof Error ? input.message : String(input)
    const m = raw.match(/WEB_EXTRACT::([^:]+)::([\s\S]+)/)
    if (!m) return null
    return {
      code: String(m[1] || '').trim(),
      message: String(m[2] || '').trim()
    }
  }

  const chapterRowHeight = 38
  const chapterViewportHeight = 300
  const chapterItems = active?.items ?? []
  const chapterTotal = chapterItems.length
  const chapterStart = Math.max(0, Math.floor(chapterScrollTop / chapterRowHeight) - 6)
  const chapterEnd = Math.min(chapterTotal, chapterStart + Math.ceil(chapterViewportHeight / chapterRowHeight) + 12)
  const chapterVisibleItems = chapterItems.slice(chapterStart, chapterEnd)
  const chapterOffsetY = chapterStart * chapterRowHeight

  return (
    <div className="toolRootSingle">
      {toast ? (
        <div className={`toolToast ${toast.type === 'error' ? 'toolToastError' : ''}`}>
          <span>{toast.message}</span>
          <button className="toolToastAction" onClick={() => setToast(null)} title="关闭提示" aria-label="关闭提示">
            关闭
          </button>
          {toast.actionLabel ? (
            <button
              className="toolToastAction"
              onClick={() => {
                toast.onAction?.()
                if (!toast.sticky) setToast(null)
              }}
            >
              {toast.actionLabel}
            </button>
          ) : null}
        </div>
      ) : null}

      <main className="toolMainSingle">
        <section className="toolTop">
          <div className="toolTopBar">
            <input
              className="toolSearchInput"
              type="text"
              placeholder="搜索书名 / 域名 / 来源"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="row" style={{ gap: 8 }}>
              <button className={`toolChip ${tab === 'all' ? 'toolChipActive' : ''}`} onClick={() => setTab('all')}>全部</button>
              <button className={`toolChip ${tab === 'file' ? 'toolChipActive' : ''}`} onClick={() => setTab('file')}>本地</button>
              <button className={`toolChip ${tab === 'url' ? 'toolChipActive' : ''}`} onClick={() => setTab('url')}>网页</button>
              <label className="toolIconBtn" title="导入 TXT / EPUB">
                ＋
                <input
                  ref={importTxtInputRef}
                  type="file"
                  accept=".txt,text/plain,.epub,application/epub+zip"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) onImportTxt(f)
                  }}
                />
              </label>
              <button className="toolChip" onClick={() => void onRenameActiveBook()} disabled={!activeBookId} title="重命名当前选中书籍">
                重命名当前书
              </button>
            </div>
          </div>

          <div className="toolTwoCol">
            <div className="toolBookList">
              {filteredBooks.length === 0 ? (
                <div className="toolEmpty">
                  <div className="toolEmptyArt">📘</div>
                  <div>暂无书籍，点击上方导入 TXT / EPUB 或网页</div>
                </div>
              ) : (
                filteredBooks.map((b) => {
                  const checked = Boolean(selectedBookIds[b.id])
                  return (
                    <div
                      key={b.id}
                      className={`toolBookRow ${activeBookId === b.id ? 'toolBookRowActive' : ''}`}
                      onClick={() => {
                        setActiveBookId(b.id)
                        void loadBook(b.id)
                      }}
                      onDoubleClick={() => {
                        void (async () => {
                          setActiveBookId(b.id)
                          const detail = ((await window.api?.libraryGetBook?.(b.id)) as any) as BookDetail
                          const itemId = detail?.progress?.itemId ?? detail?.items?.[0]?.id
                          const lineIndex = detail?.progress?.lineIndex ?? 0
                          if (itemId) await startReading(b.id, itemId, lineIndex)
                        })()
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          e.stopPropagation()
                          setSelectedBookIds((m) => ({ ...m, [b.id]: e.target.checked }))
                        }}
                      />
                      <div className="toolProgressTrack"><div className="toolProgressFill" style={{ width: b.lastReadAt ? '100%' : '12%' }} /></div>
                      <div className="toolBookMain">
                        <div className="toolBookTitle">{b.title}</div>
                        <div className="toolBookSub">{b.domain || b.sourceRef || '未阅读'}</div>
                      </div>
                      <div className="toolBookActions">
                        <button
                          className="toolIconBtn"
                          title="重命名"
                          onClick={(e) => {
                            e.stopPropagation()
                            void (async () => {
                              const next = window.prompt('重命名书籍', b.title)
                              if (!next) return
                              const title = next.trim()
                              if (!title) return
                              await window.api?.bookRename?.({ bookId: b.id, newTitle: title })
                              await refreshLibrary(b.id)
                            })()
                          }}
                        >
                          ✏️
                        </button>
                        <button
                          className="toolIconBtn"
                          title="删除"
                          onClick={(e) => {
                            e.stopPropagation()
                            void onDeleteBooks([b.id])
                          }}
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            <div className="toolWebCenter">
              <div className="toolWebMode">
                <button className={`toolChip ${webMode === 'article' ? 'toolChipActive' : ''}`} onClick={() => setWebMode('article')}>文章</button>
                <button className={`toolChip ${webMode === 'book' ? 'toolChipActive' : ''}`} onClick={() => setWebMode('book')}>目录</button>
              </div>
              <input
                className="toolWebInput"
                type="text"
                value={webUrl}
                placeholder="输入网址后回车或点击提取"
                onChange={(e) => setWebUrl(e.target.value)}
              />
              <div className="hint">支持目录页或章节页，系统会自动识别</div>
              <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
                <button className="toolChip" onClick={() => void onOpenWeb()} disabled={webLoading}>打开网页</button>
                <button className="toolChip toolChipActive" onClick={() => void (webMode === 'article' ? onExtractWeb() : onExtractWebBookDetail())} disabled={webLoading}>
                  {webMode === 'article' ? '提取当前页' : '解析目录'}
                </button>
                <button className="toolChip" onClick={() => void onRefreshAndRetry()} disabled={webLoading}>刷新重试</button>
              </div>
              <div className={`toolStatusPill ${webErr ? 'toolStatusPillErr' : webLoading ? '' : 'toolStatusPillOk'}`}>
                {webLoading ? '提取中...' : webErr ? `失败：${webErrCode || 'UNKNOWN'}` : webPreview || webBookPreview ? '成功' : '待提取'}
              </div>
              {webErr ? (
                <button className="toolErrorStrip" onClick={() => setWebErrExpanded((v) => !v)}>
                  {webErr}（点击展开）
                </button>
              ) : null}
              {webErr && webErrExpanded ? (
                <div className="row" style={{ justifyContent: 'center' }}>
                  <button
                    className="toolChip"
                    title="当自动提取失败时，手动框选正文区域"
                    onClick={() => void onExtractWebFromSelection()}
                  >
                    手动框选
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className="toolBottom">
          {!active ? (
            <div className="toolEmpty">未识别到目录，请尝试手动刷新</div>
          ) : (
            <>
              <div className="toolBottomHead">
                <strong>{active.book.title}</strong>
                <button className="toolChip" onClick={() => setShowChapters((v) => !v)}>{showChapters ? '收起目录' : '展开目录'}</button>
              </div>
              {showChapters ? (
                <div
                  ref={chapterListRef}
                  className="toolVirtualList"
                  onScroll={(e) => setChapterScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}
                >
                  <div style={{ height: chapterTotal * chapterRowHeight, position: 'relative' }}>
                    <div style={{ transform: `translateY(${chapterOffsetY}px)` }}>
                      {chapterVisibleItems.map((it) => (
                        <button
                          key={it.id}
                          className="toolChapterItem"
                          onClick={() => {
                            if (!activeBookId) return
                            void startReading(activeBookId, it.id, 0)
                          }}
                        >
                          {it.orderIndex + 1}. {it.title}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
              {webPendingNextChapter ? (
                <div className="toolPreviewPane" style={{ marginTop: 10 }}>
                  <div className="toolBottomHead">
                    <strong>下一章候选（需人工确认）</strong>
                    <button type="button" className="toolChip" onClick={() => setWebPendingNextChapter(null)}>
                      关闭
                    </button>
                  </div>
                  <div className="hint" style={{ marginBottom: 8 }}>
                    当前：{webPendingNextChapter.chapterTitle}。置信度中等时不会自动跟链，请点击候选在「网页导入」窗口打开，确认后再继续阅读。
                  </div>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 6, justifyContent: 'flex-start' }}>
                    {webPendingNextChapter.candidates.map((c, i) => (
                      <button
                        key={`${c.url}-${i}`}
                        type="button"
                        className="toolChip"
                        title={c.url}
                        onClick={() => void window.api?.webOpen?.({ url: c.url })}
                      >
                        {(c.label || `候选 ${i + 1}`).slice(0, 22)}
                        {typeof c.confidence === 'number' ? ` · ${Math.round(c.confidence * 100)}%` : ''}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}

          {webPreview ? (
            <div className="toolPreviewPane">
              <div className="toolBottomHead">
                <strong>{webPreview.title}</strong>
                <button className="toolChip toolChipActive" onClick={() => void onSaveWeb()}>保存到书架</button>
              </div>
              {webPreview.extractDebug &&
              typeof webPreview.extractDebug === 'object' &&
              webPreview.extractDebug !== null &&
              'selectedStrategy' in (webPreview.extractDebug as object) ? (
                <div className="hint" style={{ marginBottom: 6 }}>
                  抽取策略：{(webPreview.extractDebug as { selectedStrategy?: string }).selectedStrategy}
                  {' · '}
                  候选分{' '}
                  {JSON.stringify((webPreview.extractDebug as { candidateScores?: Record<string, number> }).candidateScores ?? {})}
                </div>
              ) : null}
              <pre className="toolPreviewText">{webPreview.preview || '（暂无预览）'}</pre>
            </div>
          ) : null}

          {webBookPreview ? (
            <div className="toolPreviewPane">
              <div className="toolBottomHead">
                <strong>{webBookPreview.bookTitle}</strong>
                <button className="toolChip toolChipActive" onClick={() => void onImportWebBook()}>导入目录</button>
              </div>
              <div className="hint">
                入库后共 {webBookPreview.chapters.length + 1} 条（含简介）· 章节 {webBookPreview.chapters.length}
                {webBookPreview.tocStatus === 'ready'
                  ? ' · 状态：完整'
                  : webBookPreview.tocStatus === 'partial'
                    ? ' · 状态：可能不完整'
                    : null}
              </div>
              <div
                className="toolPreviewText"
                style={{ maxHeight: 200, overflow: 'auto', marginTop: 8, whiteSpace: 'normal', fontSize: 13 }}
              >
                <div title={webBookPreview.introText || ''}>
                  <strong>1.</strong> 简介{' '}
                  <span style={{ opacity: 0.85 }}>
                    {webBookPreview.introText
                      ? `${webBookPreview.introText.slice(0, 100)}${webBookPreview.introText.length > 100 ? '…' : ''}`
                      : '（暂无简介摘要）'}
                  </span>
                </div>
                {webBookPreview.chapters.map((c, i) => (
                  <div key={`${c.url}-${i}`} style={{ marginTop: 6 }} title={c.url}>
                    <strong>{i + 2}.</strong> {c.title || `章节 ${i + 1}`}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="toolSettingsGrid" style={{ marginTop: 12 }}>
            <label className="labelBlock">
              <span className="hint">字体颜色</span>
              <input type="color" value={cfg.textColor} onChange={(e) => applyCfg({ ...cfg, textColor: e.target.value })} />
            </label>
            <label className="labelBlock">
              <span className="hint">背景颜色</span>
              <input type="color" value={cfg.bgColor} onChange={(e) => applyCfg({ ...cfg, bgColor: e.target.value })} />
            </label>
            <label className="labelBlock">
              <span className="hint">透明度 {cfg.bgOpacity.toFixed(2)}</span>
              <input type="range" min={0} max={1} step={0.01} value={cfg.bgOpacity} onChange={(e) => applyCfg({ ...cfg, bgOpacity: Number(e.target.value) })} />
            </label>
            <label className="labelBlock">
              <span className="hint">字/分钟 {cfg.charsPerMinute}</span>
              <input
                type="range"
                min={1}
                max={1000}
                step={1}
                value={cfg.charsPerMinute}
                onChange={(e) =>
                  applyCfg({
                    ...cfg,
                    charsPerMinute: Number(e.target.value),
                    speedMs: calcSpeedMsFromCpm({
                      cols: cfg.cols,
                      rows: cfg.rows,
                      linesPerTick: cfg.linesPerTick,
                      charsPerMinute: Number(e.target.value)
                    })
                  })
                }
              />
            </label>
          </div>
        </section>
      </main>

      <div className="toolBottomBar">
        <button
          className="toolPrimaryBtn"
          onClick={() => {
            if (activeBookId) void enterReadingAuto(activeBookId)
          }}
          disabled={!activeBookId}
        >
          启动阅读条
        </button>
        <button className="toolChip" onClick={() => void window.api?.overlaySetPlaying?.(false)}>暂停</button>
        <button className="toolChip" onClick={() => void window.api?.overlayResume?.({ bookId: activeBookId || '', cols: cfg.cols })} disabled={!activeBookId}>打开阅读条</button>
        <button className="toolChip" onClick={() => void refreshLibrary(activeBookId || undefined)}>刷新</button>
      </div>
    </div>
  )
}

