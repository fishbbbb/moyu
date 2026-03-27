import React, { useEffect, useMemo, useRef, useState } from 'react'
import { splitTextToChapters } from '../utils/chapterSplit'

type OverlayConfig = {
  bgOpacity: number
  bgColor: string
  textColor: string
  fontSize: number
  rows: number
  cols: number
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
      linesPerTick: 1
    })
  }, [])

  const [cfg, setCfg] = useState<OverlayConfig>(initialCfg)
  const [books, setBooks] = useState<BookSummary[]>([])
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
  const [chapterPage, setChapterPage] = useState(0)
  const chapterPageSize = 20

  const [webUrl, setWebUrl] = useState('')
  const [webLoading, setWebLoading] = useState(false)
  const [webErr, setWebErr] = useState<string | null>(null)
  const [webMode, setWebMode] = useState<'article' | 'book'>('article')
  const [webPreview, setWebPreview] = useState<{
    title: string
    url: string
    domain: string | null
    contentText: string
    preview: string
  } | null>(null)
  const [webBookPreview, setWebBookPreview] = useState<{
    bookTitle: string
    detailUrl: string
    domain: string | null
    introText: string
    chapters: Array<{ title: string; url: string }>
  } | null>(null)
  const [webBookId, setWebBookId] = useState<string | null>(null)
  const importTxtInputRef = useRef<HTMLInputElement | null>(null)

  function applyCfg(next: OverlayConfig) {
    setCfg(next)
    setJson(LS.cfg, next)
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

  function splitTxtToItems(t: string) {
    return splitTextToChapters(t)
  }

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

    const chosen = selectBookId ?? activeBookId ?? nextBooks[0]?.id ?? null
    setActiveBookId(chosen)
    if (chosen) await loadBook(chosen)
    else setActive(null)
    if (selectBookId) setWebBookId(selectBookId)
  }

  async function loadBook(bookId: string) {
    setErr(null)
    setLoading(true)
    try {
      const res = (await window.api?.libraryGetBook?.(bookId)) as any
      setActive(res as BookDetail)
      setChapterPage(0)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setActive(null)
    } finally {
      setLoading(false)
    }
  }

  async function startReading(bookId: string, itemId: string, lineIndex: number) {
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
    const reader = new FileReader()
    reader.onload = async () => {
      const t = String(reader.result ?? '')
      if (!t.trim()) {
        setErr('导入失败：文件内容为空。')
        if (importTxtInputRef.current) importTxtInputRef.current.value = ''
        return
      }
      const items = splitTxtToItems(t)
      if (items.length === 1 && items[0]?.title === '全文') {
        setNotice('未识别到章节目录，已按“全文”导入（你仍可正常阅读）。')
      }
      const title = file.name.replace(/\.txt$/i, '') || '未命名'
      try {
        const res = (await window.api?.libraryImportTxt?.({ title, sourceRef: file.name, items })) as any
        await refreshLibrary(res?.bookId)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        // 关键：清空 file input，保证“再次选择同一文件”也会触发 onChange 并能重复导入
        if (importTxtInputRef.current) importTxtInputRef.current.value = ''
      }
    }
    reader.readAsText(file)
  }

  async function onRenameActiveBook() {
    if (!activeBookId) return
    const curTitle = active?.book.title ?? ''
    const next = window.prompt('重命名书籍', curTitle)
    if (!next) return
    const title = next.trim()
    if (!title) return
    try {
      await window.api?.libraryRenameBook?.({ bookId: activeBookId, title })
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
      await window.api?.libraryDeleteBooks?.({ bookIds })
      setSelectedBookIds({})
      await refreshLibrary(undefined)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function onOpenWeb() {
    setWebErr(null)
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
        preview: String(res?.preview ?? '')
      })
      setWebBookPreview(null)
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      // Electron IPC 的错误信息常见形态：Error invoking remote method 'web:extract': Error: xxx
      const m = raw.match(/WEB_EXTRACT::([^:]+)::([\s\S]+)/)
      if (m) {
        setWebErr(m[2]?.trim() || '网页提取失败。')
      } else if (/NO_WEB_WINDOW/.test(raw)) {
        setWebErr('未检测到已打开的网页窗口，请先点击“打开网页”。')
      } else {
        setWebErr(raw)
      }
    } finally {
      setWebLoading(false)
    }
  }

  async function onExtractWebBookDetail() {
    setWebErr(null)
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
      setWebBookPreview({
        bookTitle: String(res?.bookTitle ?? '未命名网页'),
        detailUrl: String(res?.detailUrl ?? ''),
        domain: (res?.domain as string | null) ?? null,
        introText: String(res?.introText ?? ''),
        chapters: normalized
      })
      setWebPreview(null)
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      const m = raw.match(/WEB_EXTRACT::([^:]+)::([\s\S]+)/)
      if (m) setWebErr(m[2]?.trim() || '解析书籍详情失败。')
      else setWebErr(raw)
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
      setWebErr(e instanceof Error ? e.message : String(e))
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
    setNotice('正在提取章节正文…（首次进入该章节会稍慢一点）')
    const res = (await window.api?.webExtractStructuredAtUrl?.({ url })) as any
    const contentText = String(res?.content?.textContent ?? '').trim()
    if (!contentText) return null
    await window.api?.libraryUpdateItemContent?.({ itemId, contentText })
    if (activeBookId) await loadBook(activeBookId)
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

  const filteredBooks = useMemo(() => {
    const qq = q.trim().toLowerCase()
    return books
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
  }, [books, tab, groupFilter, q])

  const selectedCount = useMemo(() => selectedIdsList().length, [selectedBookIds])

  return (
    <div className="page">
      <h2>墨鱼阅读器</h2>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 className="cardTitle">导入与书架</h3>
        <div className="hint" style={{ margin: '-4px 0 12px' }}>
          老板键 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd>（Mac 为 <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd>）显示/隐藏桌面阅读条
        </div>
        <div className="row rowGap">
          <label className="labelBlock">
            <span className="sectionLabel">导入 txt</span>
            <input
              ref={importTxtInputRef}
              type="file"
              accept=".txt,text/plain"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onImportTxt(f)
              }}
            />
          </label>
          <button className="btn" onClick={() => void refreshLibrary()}>
            刷新书架
          </button>
          <button className="btn" onClick={() => void onRenameActiveBook()} disabled={!activeBookId} title="重命名当前选中的书籍">
            重命名当前书
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 className="cardTitle">网页导入阅读</h3>
        <div className="hint" style={{ margin: '-4px 0 12px' }}>
          在内置浏览器中打开网页，完成登录/购买后再点击提取。
        </div>
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <button className={`btn ${webMode === 'article' ? 'btnPrimary' : ''}`} onClick={() => setWebMode('article')}>
            导入文章页
          </button>
          <button className={`btn ${webMode === 'book' ? 'btnPrimary' : ''}`} onClick={() => setWebMode('book')}>
            导入书籍详情页（目录）
          </button>
        </div>
        <div className="row rowGap" style={{ alignItems: 'flex-end' }}>
          <label className="labelBlock" style={{ flex: 1 }}>
            <span className="sectionLabel">网址</span>
            <input
              type="text"
              placeholder="https://example.com/article"
              value={webUrl}
              onChange={(e) => setWebUrl(e.target.value)}
              style={{ width: '100%' }}
            />
          </label>
          <button className="btn" onClick={() => void onOpenWeb()} disabled={webLoading}>
            打开网页
          </button>
          {webMode === 'article' ? (
            <button className="btn" onClick={() => void onExtractWeb()} disabled={webLoading}>
              提取当前页
            </button>
          ) : (
            <button className="btn" onClick={() => void onExtractWebBookDetail()} disabled={webLoading}>
              解析详情（目录）
            </button>
          )}
        </div>
        <div className="row rowGap" style={{ marginTop: 10, alignItems: 'center' }}>
          <label className="labelBlock" style={{ minWidth: 180 }}>
            <span className="hint">保存到</span>
            <select
              value={webBookId ?? ''}
              onChange={(e) => setWebBookId(e.target.value || null)}
              style={{ height: 34, borderRadius: 10, border: '1px solid var(--card-border)', padding: '0 10px', fontSize: 13 }}
            >
              <option value="">新建书籍</option>
              {books.filter((b) => b.sourceType === 'url').map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" onClick={() => window.api?.webClose?.()} disabled={webLoading}>
            关闭网页
          </button>
        </div>

        {webErr ? (
          <div className="hint" style={{ marginTop: 12, color: '#b91c1c' }}>
            {webErr}
          </div>
        ) : null}

        {webPreview ? (
          <div className="cardSection" style={{ marginTop: 14 }}>
            <span className="sectionLabel">正文预览</span>
            <div className="hint" style={{ marginTop: 6 }}>
              {webPreview.title}
              {webPreview.domain ? ` · ${webPreview.domain}` : ''}
            </div>
            <pre
              style={{
                marginTop: 8,
                whiteSpace: 'pre-wrap',
                background: 'var(--card-bg)',
                border: '1px solid var(--card-border)',
                borderRadius: 12,
                padding: 12,
                maxHeight: 220,
                overflow: 'auto',
                fontSize: 12
              }}
            >
              {webPreview.preview || '（暂无预览内容）'}
            </pre>
            <div className="row rowGap" style={{ marginTop: 10 }}>
              <button className="btn btnPrimary" onClick={() => void onSaveWeb()} disabled={webLoading}>
                保存到书架
              </button>
              <button className="btn" onClick={() => onCancelWebPreview()}>
                取消
              </button>
            </div>
          </div>
        ) : null}

        {webBookPreview ? (
          <div className="cardSection" style={{ marginTop: 14 }}>
            <span className="sectionLabel">书籍详情预览</span>
            <div className="hint" style={{ marginTop: 6 }}>
              {webBookPreview.bookTitle}
              {webBookPreview.domain ? ` · ${webBookPreview.domain}` : ''}
              {` · 目录 ${webBookPreview.chapters.length} 章`}
            </div>
            {webBookPreview.introText ? (
              <div
                style={{
                  marginTop: 8,
                  background: 'var(--card-bg)',
                  border: '1px solid var(--card-border)',
                  borderRadius: 12,
                  padding: 12,
                  fontSize: 12,
                  color: 'var(--hint)'
                }}
              >
                {webBookPreview.introText}
              </div>
            ) : null}
            <div className="row rowGap" style={{ marginTop: 10 }}>
              <button className="btn btnPrimary" onClick={() => void onImportWebBook()} disabled={webLoading}>
                导入目录到书架
              </button>
              <button className="btn" onClick={() => onCancelWebPreview()}>
                取消
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 className="cardTitle">阅读条设置</h3>
        <p className="hint" style={{ marginBottom: 14 }}>
          以下设置会同步到桌面阅读条，默认白字、无背景。
        </p>
        <div className="cardSection">
          <span className="sectionLabel">外观</span>
          <div className="row rowGap" style={{ marginTop: 6 }}>
            <label className="labelBlock">
              <span className="hint">字体颜色</span>
              <input
                type="color"
                value={cfg.textColor}
                onChange={(e) => applyCfg({ ...cfg, textColor: e.target.value })}
                title="默认白字"
              />
            </label>
            <label className="labelBlock">
              <span className="hint">背景颜色</span>
              <input
                type="color"
                value={cfg.bgColor}
                onChange={(e) => applyCfg({ ...cfg, bgColor: e.target.value })}
              />
            </label>
            <label className="labelBlock">
              <span className="hint">背景透明度 {cfg.bgOpacity.toFixed(2)}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={cfg.bgOpacity}
                onChange={(e) => applyCfg({ ...cfg, bgOpacity: Number(e.target.value) })}
              />
            </label>
          </div>
        </div>
        <div className="cardSection">
          <span className="sectionLabel">速度与翻页</span>
          <div className="row rowGap" style={{ marginTop: 6 }}>
            <label className="labelBlock">
              <span className="hint">字/分钟</span>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input
                  type="range"
                  min={1}
                  max={1000}
                  step={1}
                  value={cfg.charsPerMinute}
                  onChange={(e) => {
                    const charsPerMinute = Number(e.target.value)
                    const speedMs = cfg.autoSpeed
                      ? calcSpeedMsFromCpm({
                          cols: cfg.cols,
                          rows: cfg.rows,
                          linesPerTick: cfg.linesPerTick,
                          charsPerMinute
                        })
                      : cfg.speedMs
                    applyCfg({ ...cfg, charsPerMinute, speedMs })
                  }}
                />
                <span style={{ minWidth: 52, fontSize: 13 }}>{cfg.charsPerMinute}</span>
              </div>
            </label>
            <label className="labelBlock">
              <span className="hint">每次前进（行）</span>
              <input
                type="number"
                min={1}
                max={10}
                value={cfg.linesPerTick}
                onChange={(e) => applyCfg({ ...cfg, linesPerTick: Number(e.target.value) })}
              />
            </label>
          </div>
        </div>
      </div>

      {err ? (
        <div className="card" style={{ marginTop: 16, borderColor: '#fca5a5', background: '#fef2f2' }}>
          <div className="hint" style={{ color: '#b91c1c' }}>{err}</div>
        </div>
      ) : null}

      {notice ? (
        <div className="card" style={{ marginTop: 16, borderColor: '#fcd34d', background: '#fffbeb' }}>
          <div className="hint" style={{ color: '#92400e' }}>{notice}</div>
        </div>
      ) : null}

      <div className="grid" style={{ marginTop: 16 }}>
        <div className="card">
          <h3 className="cardTitle">书架</h3>
          <div className="hint" style={{ margin: '-6px 0 10px' }}>
            点击一本书后，在右侧展开目录与控制。
          </div>
          <div className="row rowGap" style={{ marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="row" style={{ gap: 8 }}>
              <button className={`btn ${tab === 'all' ? 'btnPrimary' : ''}`} onClick={() => setTab('all')}>
                全部
              </button>
              <button className={`btn ${tab === 'file' ? 'btnPrimary' : ''}`} onClick={() => setTab('file')}>
                本地
              </button>
              <button className={`btn ${tab === 'url' ? 'btnPrimary' : ''}`} onClick={() => setTab('url')}>
                网页
              </button>
            </div>
            <input
              type="text"
              placeholder="搜索书名 / 域名 / 来源"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ flex: 1, minWidth: 180 }}
            />
            <button className="btn" onClick={() => void onCreateGroup(null)} title="在根节点创建分组">
              新建分组
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            <div style={{ border: '1px solid var(--card-border)', borderRadius: 12, padding: 10, minWidth: 0 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="hint">分组</div>
                <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn" onClick={() => void onCreateGroup(null)} title="新建根分组">
                    + 新建
                  </button>
                </div>
              </div>

              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflow: 'auto' }}>
                <button
                  className={`btn ${groupFilter === '__all__' ? 'btnPrimary' : ''}`}
                  onClick={() => setGroupFilter('__all__')}
                  style={{ textAlign: 'left' }}
                >
                  全部分组
                </button>
                <button
                  className={`btn ${groupFilter === null ? 'btnPrimary' : ''}`}
                  onClick={() => setGroupFilter(null)}
                  style={{ textAlign: 'left' }}
                  title="未分组的书"
                >
                  未分组
                </button>

                {groupOptions.length === 0 ? <div className="hint">（还没有分组）</div> : null}

                {groupOptions.map((g) => (
                  <div key={g.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 8, alignItems: 'center' }}>
                    <button
                      className={`btn ${groupFilter === g.id ? 'btnPrimary' : ''}`}
                      onClick={() => setGroupFilter(g.id)}
                      style={{ textAlign: 'left', width: '100%', minWidth: 0 }}
                      title="筛选该分组"
                    >
                      {g.label}
                    </button>
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <button className="btn" onClick={() => void onCreateGroup(g.id)} title="新建子分组">
                        +
                      </button>
                      <button className="btn" onClick={() => void onRenameGroup(g.id)} title="重命名">
                        改
                      </button>
                      <button className="btn" onClick={() => void onDeleteGroup(g.id)} title="删除">
                        删
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ border: '1px solid var(--card-border)', borderRadius: 12, padding: 10, minWidth: 0, overflow: 'hidden' }}>
              <div className="row rowGap" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div className="hint">共 {filteredBooks.length} 本</div>
                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <div className="hint">已选 {selectedCount}</div>
                  <select
                    disabled={selectedCount === 0}
                    onChange={(e) => {
                      const v = e.target.value
                      if (!v) return
                      const ids = selectedIdsList()
                      const gid = v === '__ungrouped__' ? null : v
                      void onMoveBooks(ids, gid)
                      e.currentTarget.value = ''
                    }}
                    defaultValue=""
                    style={{ height: 34, borderRadius: 10, border: '1px solid var(--card-border)', padding: '0 10px', fontSize: 13, maxWidth: '100%' }}
                    title="批量移动到分组"
                  >
                    <option value="">批量移动到…</option>
                    <option value="__ungrouped__">未分组</option>
                    {groupOptions.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.label}
                      </option>
                    ))}
                  </select>
                  <button className="btn" disabled={selectedCount === 0} onClick={() => void onDeleteBooks(selectedIdsList())}>
                    批量删除
                  </button>
                </div>
              </div>

              {books.length === 0 ? <div className="hint">还没有书，先导入一个 txt。</div> : null}
              {filteredBooks.length === 0 && books.length > 0 ? <div className="hint">没有匹配的书。</div> : null}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 380, overflow: 'auto', paddingRight: 2 }}>
                {filteredBooks.map((b) => {
                  const checked = Boolean(selectedBookIds[b.id])
                  const isActive = b.id === activeBookId
                  return (
                    <div
                      key={b.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '22px minmax(0,1fr)',
                        gap: 8,
                        alignItems: 'start',
                        border: '1px solid var(--card-border)',
                        borderRadius: 12,
                        padding: 10,
                        background: isActive ? 'rgba(59,130,246,0.10)' : 'transparent',
                        minWidth: 0
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => setSelectedBookIds((m) => ({ ...m, [b.id]: e.target.checked }))}
                        title="选择"
                        style={{ marginTop: 4 }}
                      />
                      <div style={{ minWidth: 0 }}>
                        <button
                          className="btn"
                          onClick={() => {
                            setActiveBookId(b.id)
                            void loadBook(b.id)
                          }}
                          style={{ textAlign: 'left', width: '100%', minWidth: 0 }}
                          title="打开目录与控制"
                        >
                          <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>{b.title}</div>
                          <div className="hint" style={{ marginTop: 2 }}>
                            {b.sourceType === 'file' ? '本地文件' : '网页'}
                            {b.domain ? ` · ${b.domain}` : ''}
                            {b.lastReadAt ? ` · ${new Date(b.lastReadAt).toLocaleString()}` : ' · 未阅读'}
                          </div>
                        </button>

                        <div className="row" style={{ gap: 8, justifyContent: 'flex-start', marginTop: 8, alignItems: 'center' }}>
                          <select
                            value=""
                            onChange={(e) => {
                              const v = e.target.value
                              const gid = v === '__ungrouped__' ? null : v
                              if (!v) return
                              void onMoveBooks([b.id], gid)
                            }}
                            style={{
                              height: 34,
                              borderRadius: 10,
                              border: '1px solid var(--card-border)',
                              padding: '0 10px',
                              fontSize: 13,
                              maxWidth: '100%'
                            }}
                            title="移动到分组"
                          >
                            <option value="">移动到…</option>
                            <option value="__ungrouped__">未分组</option>
                            {groupOptions.map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.label}
                              </option>
                            ))}
                          </select>
                          <button
                            className="btn"
                            onClick={() => {
                              setActiveBookId(b.id)
                              setActive(null)
                              void (async () => {
                                const next = window.prompt('重命名书籍', b.title)
                                if (!next) return
                                const title = next.trim()
                                if (!title) return
                                await window.api?.libraryRenameBook?.({ bookId: b.id, title })
                                await refreshLibrary(b.id)
                              })()
                            }}
                          >
                            重命名
                          </button>
                          <button className="btn" onClick={() => void onDeleteBooks([b.id])} title="删除该书">
                            删除
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 className="cardTitle">目录与控制</h3>
          {loading ? <div className="hint">加载中…</div> : null}
          {!active ? <div className="hint" style={{ marginTop: 8 }}>选择一本书以查看目录。</div> : null}

          {active ? (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="cardSection">
                <span className="sectionLabel">阅读条操作</span>
                <div className="row rowGap" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  <button
                    className="btn btnPrimary"
                    onClick={() => {
                      const p = active.progress
                      const itemId = p?.itemId ?? active.items[0]?.id
                      const lineIndex = p?.lineIndex ?? 0
                      if (itemId && activeBookId) void startReading(activeBookId, itemId, lineIndex)
                    }}
                  >
                    继续阅读（暂停）
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      if (activeBookId) void enterReadingAuto(activeBookId)
                    }}
                    title="自动进入当前进度（首次章节会按需提取正文）并开始播放"
                  >
                    进入阅读（自动）
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      if (activeBookId) void window.api?.overlayResume?.({ bookId: activeBookId, cols: cfg.cols })
                    }}
                  >
                    打开阅读条（暂停）
                  </button>
                  <button className="btn" onClick={() => void window.api?.overlaySetPlaying?.(true)}>
                    开始
                  </button>
                  <button className="btn" onClick={() => void window.api?.overlaySetPlaying?.(false)}>
                    暂停
                  </button>
                  <button
                    className="btn"
                    onClick={() => void window.api?.overlayStepDisplay?.(-1)}
                    title="上一页"
                  >
                    ‹ 上一页
                  </button>
                  <button
                    className="btn"
                    onClick={() => void window.api?.overlayStepDisplay?.(1)}
                    title="下一页"
                  >
                    下一页 ›
                  </button>
                  <button className="btn" onClick={() => void window.api?.overlayHide?.()} title="关闭阅读条">
                    关闭
                  </button>
                </div>
              </div>

              <div className="cardSection">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="sectionLabel">目录</span>
                  <div className="row" style={{ gap: 10, justifyContent: 'flex-end' }}>
                    <button className="btn" onClick={() => setShowChapters((v) => !v)}>
                      {showChapters ? '收起目录' : '展开目录'}
                    </button>
                  </div>
                </div>
                <div className="hint" style={{ marginTop: 6 }}>
                  在章节列表中点击标题会把该章加载到阅读条（暂停）。把鼠标移到某章上会出现“从本章阅读”快捷按钮。
                </div>
                {showChapters ? (
                  <div style={{ maxHeight: 380, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                    {(() => {
                      const total = active.items.length
                      const totalPages = Math.max(1, Math.ceil(total / chapterPageSize))
                      const safePage = Math.max(0, Math.min(totalPages - 1, chapterPage))
                      const start = safePage * chapterPageSize
                      const end = Math.min(total, start + chapterPageSize)
                      const pageItems = active.items.slice(start, end)

                      const pageOptions = Array.from({ length: totalPages }, (_, p) => {
                        const s = p * chapterPageSize + 1
                        const e = Math.min(total, (p + 1) * chapterPageSize)
                        return { p, label: `${s}-${e}` }
                      })

                      return (
                        <>
                          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <div className="hint">
                              共 {total} 章 · 本页 {start + 1}-{end}
                            </div>
                            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                              <button className="btn" disabled={safePage <= 0} onClick={() => setChapterPage((p) => Math.max(0, p - 1))} title="上一页">
                                上一页
                              </button>
                              <select
                                value={safePage}
                                onChange={(e) => setChapterPage(Number(e.target.value))}
                                style={{ height: 34, borderRadius: 10, border: '1px solid var(--card-border)', padding: '0 10px', fontSize: 13 }}
                                title="选择章节页（每页 20 章）"
                              >
                                {pageOptions.map((o) => (
                                  <option key={o.p} value={o.p}>
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                              <button
                                className="btn"
                                disabled={safePage >= totalPages - 1}
                                onClick={() => setChapterPage((p) => Math.min(totalPages - 1, p + 1))}
                                title="下一页"
                              >
                                下一页
                              </button>
                            </div>
                          </div>

                          {pageItems.map((it) => (
                      <div key={it.id} className="chapterRow">
                        <button
                          className="btn chapterMain"
                          onClick={() => {
                            if (!activeBookId) return
                            void startReading(activeBookId, it.id, 0)
                          }}
                          style={{ textAlign: 'left', flex: 1 }}
                          title="加载到阅读条（暂停）"
                        >
                          {it.orderIndex + 1}. {it.title}
                        </button>
                        <button
                          className="btn chapterAction"
                          onClick={() => {
                            if (!activeBookId) return
                            void startReading(activeBookId, it.id, 0)
                          }}
                          title="从本章开头加载到阅读条（暂停）"
                        >
                          从本章阅读
                        </button>
                      </div>
                          ))}
                        </>
                      )
                    })()}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

