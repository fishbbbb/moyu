import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

type OverlayConfig = {
  bgOpacity: number
  bgColor: string
  textColor: string
  textOpacity: number
  fontSize: number
  rows: number
  cols: number
  readMode?: 'scroll' | 'page'
  autoSpeed: boolean
  // 内部使用 ms/tick 驱动定时器；对用户展示用 charsPerMinute（字/分钟）
  speedMs: number
  charsPerMinute: number
  linesPerTick: number
}

type OverlaySession = {
  bookId: string
  itemId: string
  lines: string[]
  lineIndex: number
  playing: boolean
}

type HotkeyAction = 'playPause' | 'pagePrev' | 'pageNext' | 'chapterPrev' | 'chapterNext'

type HotkeyBinding = {
  key: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}

type HotkeyConfig = {
  bindings: Partial<Record<HotkeyAction, HotkeyBinding[]>>
}

const LS = { cfg: 'overlay:cfg', cfgLegacy: 'demo:cfg' } as const
const LS_FONT_FAMILY = 'overlay:fontFamily' as const
const LS_KMODE = 'overlay:kMode' as const
const LS_HOTKEYS = 'overlay:hotkeys' as const
/** 阅读条最多显示行数（与拖动缩放/设置/工具栏一致） */

function getJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function setJson(key: string, val: unknown) {
  localStorage.setItem(key, JSON.stringify(val))
}

function normalizeKeyFromEvent(e: KeyboardEvent) {
  const k = String(e.key || '')
  if (!k) return ''
  if (k === ' ') return 'Space'
  if (k.length === 1) return k.toUpperCase()
  return k
}

function getDefaultHotkeys(): HotkeyConfig {
  return {
    bindings: {
      playPause: [{ key: 'Space' }],
      pagePrev: [{ key: 'ArrowLeft' }],
      pageNext: [{ key: 'ArrowRight' }],
      chapterPrev: [{ key: 'ArrowUp' }],
      chapterNext: [{ key: 'ArrowDown' }]
    }
  }
}

function normalizeHotkeysConfig(input: unknown): HotkeyConfig {
  const fallback = getDefaultHotkeys()
  if (!input || typeof input !== 'object') return fallback
  const raw = input as any
  const src = raw?.bindings && typeof raw.bindings === 'object' ? raw.bindings : {}
  const actions: HotkeyAction[] = ['playPause', 'pagePrev', 'pageNext', 'chapterPrev', 'chapterNext']
  const bindings: Partial<Record<HotkeyAction, HotkeyBinding[]>> = {}
  for (const a of actions) {
    const v = src[a]
    if (Array.isArray(v)) {
      bindings[a] = v
        .filter((x) => x && typeof x === 'object' && typeof (x as any).key === 'string' && String((x as any).key).trim())
        .map((x) => ({
          key: String((x as any).key),
          ctrl: Boolean((x as any).ctrl),
          alt: Boolean((x as any).alt),
          shift: Boolean((x as any).shift),
          meta: Boolean((x as any).meta)
        }))
      continue
    }
    // 兼容旧版单值结构：{ action: { key, ... } | null }
    if (v && typeof v === 'object' && typeof v.key === 'string' && String(v.key).trim()) {
      bindings[a] = [
        {
          key: String(v.key),
          ctrl: Boolean(v.ctrl),
          alt: Boolean(v.alt),
          shift: Boolean(v.shift),
          meta: Boolean(v.meta)
        }
      ]
      continue
    }
    bindings[a] = []
  }
  return { bindings }
}

function getCfgWithMigration(fallback: OverlayConfig): OverlayConfig {
  const next = getJson<OverlayConfig>(LS.cfg, fallback)
  if (next && typeof next === 'object') return next
  const legacy = getJson<OverlayConfig>(LS.cfgLegacy, fallback)
  if (legacy && typeof legacy === 'object') return legacy
  return fallback
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const s = String(hex || '').trim()
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (!m) return null
  let h = m[1].toLowerCase()
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = Number.parseInt(h, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function withAlpha(hex: string, alpha: number) {
  const a = clamp(Number(alpha ?? 1), 0, 1)
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`
}

function charsPerTickFromCfg(input: { cols: number; linesPerTick: number }) {
  const cols = Math.max(1, Math.floor(input.cols || 48))
  const linesPerTick = clamp(Math.floor(input.linesPerTick || 1), 1, 10)
  return Math.max(1, cols * linesPerTick)
}

function calcSpeedMsFromCpm(input: { cols: number; rows?: number; linesPerTick: number; charsPerMinute: number }) {
  const cpm = clamp(Math.floor(input.charsPerMinute || 100), 1, 1000)
  const charsPerTick = charsPerTickFromCfg(input)
  const rows = Math.max(1, Math.floor(input.rows ?? 1))
  let ms = Math.round((60_000 * charsPerTick) / cpm)
  // 小页（每页十几个字）时按 CPM 会翻得过快：加“舒适下限”，保证至少 ~2.8 秒/页
  const minPageMs = 2800
  const minMsPerTickFromPage = Math.round((minPageMs * Math.max(1, input.linesPerTick)) / rows)
  const minTickMs = 900
  ms = clamp(ms, Math.max(minTickMs, minMsPerTickFromPage), 30_000)
  return ms
}

export function OverlayView() {
  const [session, setSession] = useState<OverlaySession | null>(null)
  // session 推过来的原始行；Overlay 端会按当前 cols 进一步做“超长行切分”（避免溢出被裁剪）
  const [rawLines, setRawLines] = useState<string[]>([])
  const [idx, setIdx] = useState<number>(0)
  const [playing, setPlaying] = useState<boolean>(false)
  const [focused, setFocused] = useState(false)
  const [kMode, setKMode] = useState<boolean>(() => Boolean(getJson(LS_KMODE, { enabled: false } as any)?.enabled))
  const [hotkeys, setHotkeys] = useState<HotkeyConfig>(() => normalizeHotkeysConfig(getJson<HotkeyConfig>(LS_HOTKEYS, getDefaultHotkeys())))
  const [bounds, setBounds] = useState<{ width: number; height: number } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cfgRef = useRef<OverlayConfig | null>(null)
  const metricsRef = useRef<{ key: string; charW: number; lineH: number } | null>(null)
  const playingRef = useRef(false)
  const linesLenRef = useRef(0)
  const pendingJumpRef = useRef<null | { kind: 'prevToEnd'; rows: number; fromItemId: string | null; seq: number }>(null)
  const [pendingJumpSeq, setPendingJumpSeq] = useState(0)
  const pendingJumpSeqRef = useRef(0)
  const autoAdvanceRef = useRef<null | { fromItemId: string | null }>(null)
  const manualChapterStepPendingRef = useRef(false)
  const resizeRef = useRef<{
    startX: number
    startY: number
    startW: number
    startH: number
    startWinX: number
    startWinY: number
    dir: { x: -1 | 0 | 1; y: -1 | 0 | 1 }
    active: boolean
  } | null>(null)
  const lastAutoBoundsKeyRef = useRef<string>('')
  // 窗口拖动：允许在正文区域拖动窗口，但要与“点击出工具栏 / resize”分离
  const didAutoFitRef = useRef(false)
  const lastProgressFlushRef = useRef<{ at: number; lineIndex: number }>({ at: 0, lineIndex: -1 })
  const idxRef = useRef(0)
  const sessionRef = useRef<OverlaySession | null>(null)
  const lastSyncRef = useRef<{ at: number; lineIndex: number }>({ at: 0, lineIndex: -1 })
  const lastRepaintRef = useRef<{ at: number; sig: string }>({ at: 0, sig: '' })
  /** 阅读框拖拽缩放时：用预览行列驱动排版，松手后再 applyCfg，避免每帧写盘/重算导致卡顿 */
  const [previewRowsCols, setPreviewRowsCols] = useState<null | { rows: number; cols: number }>(null)
  /** 正文区域实际像素尺寸（随窗口变化即时更新，避免只依赖 IPC bounds 滞后导致 canvas 被拉伸压扁） */
  const [holderLayout, setHolderLayout] = useState<{ w: number; h: number } | null>(null)
  const holderRef = useRef<HTMLDivElement | null>(null)
  const resizeRafRef = useRef(0)
  const holderLayoutRafRef = useRef(0)
  const pendingHolderLayoutRef = useRef<{ w: number; h: number } | null>(null)
  const pendingResizeRef = useRef<{ w: number; h: number; x: number; y: number } | null>(null)
  const lastAppliedResizeRef = useRef<{ w: number; h: number; x: number; y: number } | null>(null)
  const [cfg, setCfg] = useState<OverlayConfig>(() =>
    getCfgWithMigration({
      bgOpacity: 0,
      bgColor: '#000000',
      textColor: '#ffffff',
      textOpacity: 1,
      fontSize: 16,
      rows: 1,
      cols: 48,
      readMode: 'scroll',
      autoSpeed: true,
      charsPerMinute: 100,
      speedMs: calcSpeedMsFromCpm({ cols: 48, rows: 1, linesPerTick: 1, charsPerMinute: 100 }),
      linesPerTick: 1
    })
  )

  const timerRef = useRef<number | null>(null)

  function setKModeAndPersist(next: boolean, reason: 'ipc' | 'local') {
    const enabled = Boolean(next)
    setKMode(enabled)
    setJson(LS_KMODE, { enabled })
    if (enabled) {
      // 进入 K：默认收起 HUD 与辅助窗，保持画面干净
      setFocused(false)
      void window.api?.overlayToolbarHide?.()
      void window.api?.overlaySettingsHide?.()
    }
    if (reason === 'local') void window.api?.overlayKModeSet?.(enabled)
  }

  useEffect(() => {
    cfgRef.current = cfg
  }, [cfg])

  useEffect(() => {
    playingRef.current = playing
  }, [playing])

  function getTextMetrics(input: { fontSize: number }) {
    const fontSize = clamp(Math.floor(Number(input.fontSize ?? 16)), 10, 64)
    const fontFamily = window.getComputedStyle(document.body).fontFamily || 'system-ui'
    const key = `${fontSize}|${fontFamily}`
    const cached = metricsRef.current
    if (cached?.key === key) return cached
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    // fallback：尽量接近中文等宽体验
    let charW = Math.max(1, fontSize * 0.95)
    if (ctx) {
      ctx.font = `${fontSize}px ${fontFamily}`
      const wHan = ctx.measureText('汉').width
      const wM = ctx.measureText('M').width
      const w0 = ctx.measureText('0').width
      // 取一个偏保守的宽度，避免“显示不全”
      charW = Math.max(1, Math.max(wHan, (wM + w0) / 2))
    }
    const lineH = Math.round(fontSize * 1.25)
    const next = { key, charW, lineH }
    metricsRef.current = next
    return next
  }

  // 与 JSX 样式保持一致的 padding（用于 rows/cols 与像素宽高的互算）
  // 收紧文字与边框的留白，减少“框内空白感”
  const PAD_X = 6
  const PAD_Y = 6
  const EXTRA_H = 8
  // 给右侧留一点余量，避免不同平台的次像素/阴影导致“半个字被裁切”
  const COL_FIT_SAFETY_PX = 0

  function splitToCols(s: string, cols: number) {
    const str = String(s ?? '')
    const chars = Array.from(str)
    if (chars.length <= cols) return [str]

    // 处理“段首缩进”：很多中文正文会用空格/全角空格缩进。
    // 如果分页刚好从段落中间开始，缩进消失会造成“这一页偏左/下一页偏右”的错觉。
    // 这里把段首缩进继承到续行，让左边界更稳定。
    const m = /^[\s\u3000]+/.exec(str)
    const indent = m?.[0] ?? ''
    const indentChars = Array.from(indent)
    const indentLen = Math.min(indentChars.length, Math.max(0, cols - 1))

    const out: string[] = []
    // 第一行按原样切（保留原始缩进）
    out.push(chars.slice(0, cols).join(''))
    if (chars.length <= cols) return out

    // 续行：带缩进，但要扣掉缩进占用的列数
    const take = Math.max(1, cols - indentLen)
    for (let i = cols; i < chars.length; i += take) {
      const chunk = chars.slice(i, i + take).join('')
      out.push((indentLen > 0 ? indentChars.slice(0, indentLen).join('') : '') + chunk)
    }
    return out.length ? out : ['']
  }

  const displayRows = Math.max(1, Math.floor((previewRowsCols?.rows ?? cfg.rows) || 1))
  const cfgColsCap = Math.max(1, Math.floor(Number((previewRowsCols?.cols ?? cfg.cols) || 48)))

  const effectiveCols = useMemo(() => {
    const cfgCols = cfgColsCap
    const { charW } = getTextMetrics({ fontSize: cfg.fontSize })
    const availFromHolder = holderLayout?.w
    const availFromBounds = bounds ? Math.max(0, bounds.width - PAD_X * 2 - COL_FIT_SAFETY_PX) : 0
    const avail = availFromHolder != null && availFromHolder > 0 ? availFromHolder : availFromBounds
    if (!avail) return cfgCols
    // 略微“激进”一点，让行宽更贴近可用宽度，避免整体视觉偏右
    // 不设下限 20：窄窗口时 floor(avail/charW) 常 <20，若强行 20 列会导致行宽超出可视区被边框裁切
    const fitCols = Math.max(1, Math.floor((avail + charW * 0.1) / Math.max(1, charW)))
    // 优先贴合当前可用像素宽度（含拖拽缩放中 holder 尺寸），避免“低于某宽度不重排”
    return fitCols
  }, [bounds, cfg.fontSize, cfgColsCap, holderLayout?.w])

  const lines = useMemo(() => {
    const cols = effectiveCols
    if (!rawLines.length) return []
    const out: string[] = []
    for (const ln of rawLines) {
      // 只对“超长行”做切分；已经是按 cols 重排的行会保持不变
      if ((ln ?? '').length <= cols) out.push(ln ?? '')
      else out.push(...splitToCols(ln ?? '', cols))
    }
    return out
  }, [effectiveCols, rawLines])

  const line = useMemo(() => {
    const safeIdx = Math.max(0, Math.min(lines.length - 1, idx))
    return lines[safeIdx] ?? ''
  }, [idx, lines])

  const visibleText = useMemo(() => {
    if (!session || lines.length === 0) return ''
    const rows = displayRows
    const start = Math.max(0, Math.min(lines.length - 1, idx))
    const slice = lines.slice(start, Math.min(lines.length, start + rows))
    return slice.join('\n')
  }, [session, displayRows, idx, lines])
  const showPlaceholder = !session || lines.length === 0
  const topSafe = 0
  const frameActive = focused && !kMode
  // 背景是否可见：聚焦时按配置显示；失焦时完全透明（只留文字），保持“真正透明”的视觉目标
  const effectiveBgOpacity = frameActive ? cfg.bgOpacity : 0
  const lineH = Math.round(clamp(Math.floor(Number(cfg.fontSize ?? 16)), 10, 64) * 1.25)
  const canvasCssH = Math.max(1, Math.floor(displayRows * lineH))

  useEffect(() => {
    // 使用 Canvas 绘制文字：每次内容/样式变化都 clearRect 后重绘，避免透明窗口下的残影。
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1))
    const holder = canvas.parentElement as HTMLElement | null
    const cssW = Math.max(
      1,
      Math.floor(holderLayout?.w ?? holder?.clientWidth ?? canvas.getBoundingClientRect().width ?? 1)
    )
    const cssH = canvasCssH
    const pxW = cssW * dpr
    const pxH = cssH * dpr
    if (canvas.width !== pxW) canvas.width = pxW
    if (canvas.height !== pxH) canvas.height = pxH

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    const fontSize = clamp(Math.floor(Number(cfg.fontSize ?? 16)), 10, 64)
    const fontFamily = window.getComputedStyle(document.body).fontFamily || 'system-ui'
    ctx.font = `${fontSize}px ${fontFamily}`
    ctx.textBaseline = 'top'
    ctx.fillStyle = withAlpha(cfg.textColor, cfg.textOpacity)

    const text = showPlaceholder ? '（还没有推送内容）' : visibleText
    const alpha = showPlaceholder ? 0.45 : 1
    // placeholder 用同色低透明度，避免引入额外背景
    const base = withAlpha(cfg.textColor, clamp(cfg.textOpacity * alpha, 0, 1))
    ctx.fillStyle = base

    const rows = displayRows
    const maxLines = Math.min(rows, Math.max(1, text.split('\n').length))
    const linesToDraw = text.split('\n').slice(0, maxLines)
    for (let i = 0; i < linesToDraw.length; i++) {
      ctx.fillText(linesToDraw[i] ?? '', 0, i * lineH)
    }
  }, [
    // 宽度与文本/行高变化要重设 canvas backing store，避免位图被拉伸
    bounds?.width,
    holderLayout?.w,
    canvasCssH,
    cfg.fontSize,
    displayRows,
    cfg.textColor,
    cfg.textOpacity,
    showPlaceholder,
    visibleText
  ])

  useEffect(() => {
    // 当内容变化或行数变化时，确保 idx 不越界
    if (lines.length === 0) return
    const maxIdx = Math.max(0, lines.length - 1)
    if (idx > maxIdx) setIdx(maxIdx)
  }, [idx, lines.length])

  useEffect(() => {
    linesLenRef.current = lines.length
    const pending = pendingJumpRef.current
    if (!pending) return
    if (pending.kind !== 'prevToEnd') return
    if (lines.length === 0) return
    if (pending.seq !== pendingJumpSeq) return
    // 如果 session 还没真正切到上一章（itemId 没变），就先不落点，
    // 等下一次章节切换后再计算 idx，避免“过早落点/跳错章”。
    if (pending.fromItemId && session?.itemId === pending.fromItemId) return
    // 切到上一章后，把位置落到“末页起始行”，实现“章首按上一页 = 上一章末页”
    const rows = Math.max(1, Math.floor(pending.rows || 1))
    const nextIdx = Math.max(0, lines.length - rows)
    pendingJumpRef.current = null
    setIdx(nextIdx)
    void window.api?.overlaySyncLineIndex?.({ lineIndex: nextIdx })
  }, [cfg.readMode, cfg.rows, cfg.linesPerTick, pendingJumpSeq, session?.itemId, lines.length])

  // 监听正文容器真实尺寸，驱动列数与 canvas backing store（比仅靠 IPC bounds 更跟手、避免压扁）
  useLayoutEffect(() => {
    const el = holderRef.current
    if (!el) return
    function flushHolderLayout() {
      holderLayoutRafRef.current = 0
      const p = pendingHolderLayoutRef.current
      if (!p) return
      setHolderLayout((prev) => (prev && prev.w === p.w && prev.h === p.h ? prev : p))
      pendingHolderLayoutRef.current = null
    }
    const ro = new ResizeObserver((entries) => {
      const e = entries[0]
      if (!e) return
      const cr = e.contentRect
      const w = Math.max(0, Math.floor(cr.width))
      const h = Math.max(0, Math.floor(cr.height))
      pendingHolderLayoutRef.current = { w, h }
      if (!holderLayoutRafRef.current) {
        holderLayoutRafRef.current = requestAnimationFrame(flushHolderLayout)
      }
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (holderLayoutRafRef.current) {
        cancelAnimationFrame(holderLayoutRafRef.current)
        holderLayoutRafRef.current = 0
      }
      pendingHolderLayoutRef.current = null
    }
  }, [])

  // Canvas 渲染不再依赖“重挂载/清空一帧”的 DOM 兜底逻辑

  useEffect(() => {
    let off: null | (() => void) = null
    let offBounds: null | (() => void) = null
    let offStep: null | (() => void) = null
    let disposed = false

    async function init() {
      const offSessionCandidate = window.api?.overlayOnSession?.((next) => {
        const s = next as any
        if (s && typeof s === 'object' && Array.isArray(s.lines) && s.lines.length > 0) {
          const autoPending = autoAdvanceRef.current
          setSession(s as OverlaySession)
          setRawLines(s.lines)
          const nextIdx = Number(s?.lineIndex ?? 0)
          setIdx(nextIdx)
          // 自动续章：若主进程没有切到下一章（最后一章），停止播放
          let nextPlaying = Boolean(s?.playing ?? false)
          if (autoPending) {
            const from = autoPending.fromItemId
            const to = String(s?.itemId ?? '')
            if (from && to === from) {
              autoAdvanceRef.current = null
              nextPlaying = false
              void window.api?.overlaySetPlaying?.(false)
            } else {
              autoAdvanceRef.current = null
            }
          }
          setPlaying(nextPlaying)
        } else {
          setSession(null)
          setRawLines([])
          setIdx(0)
          autoAdvanceRef.current = null
          setPlaying(false)
        }
      }) ?? null
      if (disposed) offSessionCandidate?.()
      else off = offSessionCandidate

      const raw = (await window.api?.overlayGetSession?.()) as any
      if (disposed) return
      if (raw && typeof raw === 'object' && Array.isArray(raw.lines) && raw.lines.length > 0) {
        setSession(raw as OverlaySession)
        setRawLines(raw.lines)
        const nextIdx = Number(raw.lineIndex ?? 0)
        setIdx(nextIdx)
        setPlaying(Boolean(raw.playing ?? false))
      } else {
        const fallbackCfg = getCfgWithMigration({
          cols: 48,
          rows: 1,
          linesPerTick: 1,
          charsPerMinute: 100,
          speedMs: 1200,
          autoSpeed: true,
          readMode: 'scroll',
          bgOpacity: 0,
          bgColor: '#000000',
          textColor: '#ffffff',
          textOpacity: 1,
          fontSize: 16
        } as OverlayConfig)
        await window.api?.overlayRestoreLast?.({ cols: fallbackCfg.cols })
      }

      const b = (await window.api?.overlayGetBounds?.()) as any
      if (disposed) return
      if (b && typeof b.width === 'number' && typeof b.height === 'number') {
        setBounds({ width: b.width, height: b.height })
      }

      // 监听主进程广播的窗口尺寸变化（包含系统边框拖拽/双击缩放等），用于：
      // - 触发 canvas 重新设置 width（避免拉伸压扁）
      // - 让 effectiveCols 等逻辑使用最新可用宽度
      const offBoundsCandidate =
        window.api?.overlayOnBounds?.((bb) => {
          // 拖拽过程中由 ResizeObserver/本地 rAF 跟进尺寸，忽略主进程广播避免双通道抖动
          if (resizeRef.current?.active) return
          const x = bb as any
          if (x && typeof x.width === 'number' && typeof x.height === 'number') {
            setBounds({ width: x.width, height: x.height })
          }
        }) ?? null
      if (disposed) offBoundsCandidate?.()
      else offBounds = offBoundsCandidate

      // 按“实际显示行”翻页：避免主进程按 rawLines 长度 clamp 导致翻页失效/错判到头
      const offStepCandidate =
        window.api?.overlayOnStepDisplay?.((payload) => {
          const p = payload as any
          const delta = Math.trunc(Number(p?.delta ?? 0))
          if (!Number.isFinite(delta) || delta === 0) return

          // 手动翻页时先暂停自动阅读，避免竞态
          if (playingRef.current) {
            setPlaying(false)
            void window.api?.overlaySetPlaying?.(false)
          }

          setIdx((cur) => {
            const len = linesLenRef.current
            const maxIdx = Math.max(0, len - 1)
            if (len === 0) return 0
            const next = cur + delta
            if (next < 0) {
              if (manualChapterStepPendingRef.current) return 0
              // 到章首仍要“上一页”：自动切到上一章
              const nextSeq = pendingJumpSeqRef.current + 1
              pendingJumpSeqRef.current = nextSeq
              pendingJumpRef.current = {
                kind: 'prevToEnd',
                // readMode=page：上一页/下一页按整页 rows
                // readMode=scroll：上一页/下一页按 linesPerTick（按行推进）
                rows:
                  (cfgRef.current?.readMode ?? 'scroll') === 'page'
                    ? Math.max(1, Math.floor(Number(cfgRef.current?.rows ?? 1)))
                    : Math.max(1, Math.floor(Number(cfgRef.current?.linesPerTick ?? 1))),
                fromItemId: sessionRef.current?.itemId ?? null,
                seq: nextSeq
              }
              setPendingJumpSeq(nextSeq)
              manualChapterStepPendingRef.current = true
              void Promise.resolve(window.api?.overlayChapterStep?.(-1)).then((res: any) => {
                manualChapterStepPendingRef.current = false
                // 已经在第一章仍继续“上一页”：不触发落点，避免 pending 卡死
                if (res?.unchanged) pendingJumpRef.current = null
              })
              return 0
            }
            if (next > maxIdx) {
              if (manualChapterStepPendingRef.current) return maxIdx
              // 到章尾仍要“下一页”：自动切到下一章
              manualChapterStepPendingRef.current = true
              void Promise.resolve(window.api?.overlayChapterStep?.(1)).finally(() => {
                manualChapterStepPendingRef.current = false
              })
              return maxIdx
            }
            return Math.max(0, Math.min(maxIdx, next))
          })
        }) ?? null
      if (disposed) offStepCandidate?.()
      else offStep = offStepCandidate
    }

    void init()
    return () => {
      disposed = true
      off?.()
      offBounds?.()
      offStep?.()
    }
  }, [])

  useEffect(() => {
    idxRef.current = idx
  }, [idx])

  useEffect(() => {
    // 自动阅读时 idx 在渲染进程推进；把它同步到主进程的 overlay session，
    // 避免用户点击“暂停”时主进程广播旧 lineIndex 导致页面回跳。
    if (!session?.bookId || !session?.itemId) return
    const now = Date.now()
    const last = lastSyncRef.current
    const minMs = 500
    // 设计目标：自动阅读按“页”推进（当前阅读框内 rows 行），而不是按行滚动
    const stepLines = playing ? Math.max(1, Math.floor(cfg.rows || 1)) : Math.max(1, Math.floor(cfg.linesPerTick || 1))
    if (now - last.at < minMs && Math.abs(idx - last.lineIndex) < stepLines) return
    lastSyncRef.current = { at: now, lineIndex: idx }
    void window.api?.overlaySyncLineIndex?.({ lineIndex: idx })
  }, [cfg.linesPerTick, cfg.readMode, cfg.rows, idx, session?.bookId, session?.itemId])

  useEffect(() => {
    // 透明窗口残影兜底：任何“可见内容签名”变化都触发一次强制重绘（含手动/自动翻页）。
    // 仅做轻量节流，避免高频触发导致资源开销。
    if (!session || lines.length === 0) return
    const repaintSig = [
      session.itemId,
      idx,
      displayRows,
      effectiveCols,
      cfg.fontSize,
      cfg.textColor,
      cfg.textOpacity,
      showPlaceholder ? '1' : '0',
      visibleText
    ].join('|')

    const now = Date.now()
    const last = lastRepaintRef.current
    const minMs = 120
    if (repaintSig === last.sig && now - last.at < minMs) return

    lastRepaintRef.current = { at: now, sig: repaintSig }
    void window.api?.overlayForceRepaint?.()
  }, [
    session,
    lines.length,
    idx,
    displayRows,
    effectiveCols,
    cfg.fontSize,
    cfg.textColor,
    cfg.textOpacity,
    showPlaceholder,
    visibleText
  ])

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  async function flushProgressNow(reason: 'throttle' | 'pause' | 'unmount' | 'blur') {
    const s = sessionRef.current
    if (!s?.bookId || !s?.itemId) return
    if (lines.length === 0) return
    const lineIndex = Math.max(0, Math.min(lines.length - 1, idxRef.current))
    const last = lastProgressFlushRef.current
    // 防止重复刷同一行导致无意义写入
    if (last.lineIndex === lineIndex && reason !== 'pause' && reason !== 'unmount') return
    lastProgressFlushRef.current = { at: Date.now(), lineIndex }
    await window.api?.progressSet?.({ bookId: s.bookId, itemId: s.itemId, lineIndex })
  }

  useEffect(() => {
    // 启动时用当前 cfg 计算一个更合理的阅读条尺寸（避免默认过宽）
    if (!bounds) return
    // 只在首次拿到 bounds 后自动校准一次
    if (!didAutoFitRef.current) {
      didAutoFitRef.current = true
      void applyBoundsFromCfg(cfg)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds?.width])
  function isInNoDragArea(target: EventTarget | null) {
    const el = target as HTMLElement | null
    if (!el) return false
    return Boolean(el.closest?.('[data-nodrag="1"]'))
  }

  function isOnDragStrip(target: EventTarget | null) {
    const el = target as HTMLElement | null
    if (!el) return false
    return Boolean(el.closest?.('[data-dragstrip="1"]'))
  }

  function isResizeHandle(target: EventTarget | null) {
    const el = target as HTMLElement | null
    if (!el) return false
    return Boolean(el.closest?.('[data-resize-handle="1"]'))
  }

  const moveGestureRef = useRef<{
    pointerId: number
    downX: number
    downY: number
    moved: boolean
    active: boolean
  } | null>(null)

  function stopWindowMoveGesture() {
    const g = moveGestureRef.current
    if (g) g.active = false
    moveGestureRef.current = null
    window.api?.overlayMoveStop?.()
  }

  function cancelResizeGesture() {
    const r = resizeRef.current
    if (r) resizeRef.current = { ...r, active: false }
    pendingResizeRef.current = null
    lastAppliedResizeRef.current = null
    if (resizeRafRef.current) {
      cancelAnimationFrame(resizeRafRef.current)
      resizeRafRef.current = 0
    }
    setPreviewRowsCols(null)
  }

  function canStartWindowMoveFromTarget(target: EventTarget | null) {
    // resize/按钮等区域不触发窗口拖动
    if (isInNoDragArea(target)) return false
    if (isResizeHandle(target)) return false
    if (resizeRef.current?.active) return false
    // 顶部拖拽条仍保留，但正文也允许拖动
    return true
  }


  async function onResizeMouseDown(e: React.MouseEvent, dir: { x: -1 | 0 | 1; y: -1 | 0 | 1 }) {
    e.preventDefault()
    e.stopPropagation()
    const b = (await window.api?.overlayGetBounds?.()) as any
    if (!b || typeof b.width !== 'number' || typeof b.height !== 'number') return
    setPreviewRowsCols(null)
    pendingResizeRef.current = null
    if (resizeRafRef.current) {
      cancelAnimationFrame(resizeRafRef.current)
      resizeRafRef.current = 0
    }
    lastAppliedResizeRef.current = { w: b.width, h: b.height, x: b.x ?? 0, y: b.y ?? 0 }
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startW: b.width,
      startH: b.height,
      startWinX: b.x ?? 0,
      startWinY: b.y ?? 0,
      dir,
      active: true
    }
  }

  useEffect(() => {
    if (!playing) {
      if (timerRef.current) window.clearInterval(timerRef.current)
      timerRef.current = null
      // 暂停时强制落一次进度，避免节流导致丢失
      void flushProgressNow('pause')
      return
    }

    if (timerRef.current) window.clearInterval(timerRef.current)
    timerRef.current = window.setInterval(() => {
      setIdx((cur) => {
        // 已经请求过“下一章”，等待主进程切章完成并回推新 session
        if (autoAdvanceRef.current) return cur

        // 自动阅读始终“整页一翻”：每 tick 前进 rows 行
        const stepLines = Math.max(1, Math.floor(cfg.rows || 1))
        const next = cur + stepLines
        const maxIdx = Math.max(0, lines.length - 1)
        const capped = Math.min(next, maxIdx)
        // 文末：请求切到下一章并继续播放（只有最后一章才停止）
        if (capped >= maxIdx && playing) {
          autoAdvanceRef.current = { fromItemId: sessionRef.current?.itemId ?? null }
          void Promise.resolve(window.api?.overlayChapterStep?.(1)).then((res: any) => {
            // 若已经是最后一章，主进程不会切换 session，此时主动停止
            if (res?.unchanged) {
              autoAdvanceRef.current = null
              setPlaying(false)
              void window.api?.overlaySetPlaying?.(false)
            }
          })
        }
        // 节流写入进度：避免每 tick 都写盘/IPC
        const now = Date.now()
        const last = lastProgressFlushRef.current
        const minMs = 1500
        const minLines = Math.max(1, stepLines * 6)
        if (now - last.at >= minMs || Math.abs(capped - last.lineIndex) >= minLines) {
          lastProgressFlushRef.current = { at: now, lineIndex: capped }
          const s = sessionRef.current
          if (s?.bookId && s?.itemId) void window.api?.progressSet?.({ bookId: s.bookId, itemId: s.itemId, lineIndex: capped })
        }
        return capped
      })
    }, Math.max(30, cfg.speedMs))

    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [cfg.linesPerTick, cfg.speedMs, lines.length, playing, session])

  useEffect(() => {
    // K 模式快捷键监听（仅 Overlay 主窗前台；不做全局热键）
    if (!kMode) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setKModeAndPersist(false, 'local')
        return
      }
      const s = sessionRef.current
      if (!s?.bookId || !s?.itemId) return

      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as any).isContentEditable)) return

      const key = normalizeKeyFromEvent(e)
      if (!key) return

      const bindings = hotkeys?.bindings ?? {}
      const match = (b: HotkeyBinding | null | undefined) => {
        if (!b || !b.key) return false
        if (String(b.key).toUpperCase() !== String(key).toUpperCase()) return false
        if (Boolean(b.ctrl) !== Boolean(e.ctrlKey)) return false
        if (Boolean(b.alt) !== Boolean(e.altKey)) return false
        if (Boolean(b.shift) !== Boolean(e.shiftKey)) return false
        if (Boolean(b.meta) !== Boolean(e.metaKey)) return false
        return true
      }

      const actions: HotkeyAction[] = ['playPause', 'pagePrev', 'pageNext', 'chapterPrev', 'chapterNext']
      const hit = actions.find((a) => {
        const list = Array.isArray((bindings as any)[a]) ? ((bindings as any)[a] as HotkeyBinding[]) : []
        return list.some((b) => match(b))
      })
      if (!hit) return

      e.preventDefault()
      e.stopPropagation()

      const doPauseIfPlaying = async () => {
        if (!playingRef.current) return
        setPlaying(false)
        await window.api?.overlaySetPlaying?.(false)
      }

      const stepLines =
        (cfgRef.current?.readMode ?? 'scroll') === 'page'
          ? Math.max(1, Math.floor(Number(cfgRef.current?.rows ?? 1)))
          : Math.max(1, Math.floor(Number(cfgRef.current?.linesPerTick ?? 1)))

      void (async () => {
        if (hit === 'playPause') {
          const next = !playingRef.current
          setPlaying(next)
          await window.api?.overlaySetPlaying?.(next)
          return
        }
        if (hit === 'pagePrev') {
          await doPauseIfPlaying()
          await window.api?.overlayStepDisplay?.(-1 * stepLines)
          return
        }
        if (hit === 'pageNext') {
          await doPauseIfPlaying()
          await window.api?.overlayStepDisplay?.(1 * stepLines)
          return
        }
        if (hit === 'chapterPrev') {
          await doPauseIfPlaying()
          await window.api?.overlayChapterStep?.(-1)
          return
        }
        if (hit === 'chapterNext') {
          await doPauseIfPlaying()
          await window.api?.overlayChapterStep?.(1)
          return
        }
      })()
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true } as any)
  }, [hotkeys, kMode])

  useEffect(() => {
    // 让 overlay 页面本身“看不见多余 UI”，只留一行
    document.body.style.background = 'transparent'
    const applyFont = (v: string | null) => {
      const next = typeof v === 'string' ? v : ''
      document.body.style.fontFamily = next
    }
    applyFont(localStorage.getItem(LS_FONT_FAMILY))
    function onStorage(e: StorageEvent) {
      if (e.key !== LS_FONT_FAMILY) return
      applyFont(e.newValue)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    function onBlur() {
      setFocused(false)
      void flushProgressNow('blur')
      // 失焦时兜底停止窗口拖动，避免偶发漏掉 pointerup 导致后续拖拽失效
      stopWindowMoveGesture()
      // 缩放手势同理：若 mouseup 丢失会让 resizeRef.active 卡住，进而阻塞后续窗口拖动
      cancelResizeGesture()
      // 失焦（例如点击到其他应用）时，收起工具栏和设置面板，但不改变自动阅读状态
      // 注意：从阅读框点击到“设置窗”也会触发 overlay blur，此时不应把设置窗立刻关掉（否则表现为“一点就跳出”）
      if (window.api?.overlayAuxHideAllSmart) void window.api.overlayAuxHideAllSmart()
      else void window.api?.overlayAuxHideAll?.()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])

  useEffect(() => {
    // 监听主进程广播的 K 模式切换（来自工具栏/设置窗）
    const off =
      window.api?.overlayOnKMode?.((payload) => {
        const p = payload as any
        const enabled = Boolean(p?.enabled)
        setKModeAndPersist(enabled, 'ipc')
      }) ?? null
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // 监听快捷键配置变化（设置窗写 localStorage -> 其他窗口触发 storage event）
    function onStorage(e: StorageEvent) {
      if (e.key === LS_HOTKEYS) setHotkeys(normalizeHotkeysConfig(getJson<HotkeyConfig>(LS_HOTKEYS, getDefaultHotkeys())))
      if (e.key === LS_KMODE) {
        const enabled = Boolean(getJson(LS_KMODE, { enabled: false } as any)?.enabled)
        setKModeAndPersist(enabled, 'ipc')
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      stopWindowMoveGesture()
      cancelResizeGesture()
      void flushProgressNow('unmount')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') {
        stopWindowMoveGesture()
        cancelResizeGesture()
      }
    }
    function onWindowMouseLeave() {
      // 在少数系统/窗口切换场景下，pointerup 可能丢失；离开窗口时兜底收尾
      stopWindowMoveGesture()
      cancelResizeGesture()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('mouseleave', onWindowMouseLeave)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('mouseleave', onWindowMouseLeave)
    }
  }, [])

  function normalizeCfg(next: OverlayConfig) {
    const autoSpeed = Boolean(next.autoSpeed ?? false)
    const readMode: 'scroll' | 'page' = (next.readMode === 'page' || next.readMode === 'scroll') ? next.readMode : 'scroll'
    const baseCpm = clamp(Math.floor(Number(next.charsPerMinute ?? 100)), 1, 1000)
    const effectiveLinesPerTick =
      readMode === 'page' ? Math.max(1, Math.floor(Number(next.rows ?? 1))) : clamp(Math.floor(Number(next.linesPerTick ?? 1)), 1, 10)
    const computedSpeedMs = autoSpeed
      ? calcSpeedMsFromCpm({
          cols: Number(next.cols ?? 48),
          rows: Number(next.rows ?? 1),
          linesPerTick: effectiveLinesPerTick,
          charsPerMinute: baseCpm
        })
      : next.speedMs
    const safe: OverlayConfig = {
      ...next,
      bgOpacity: clamp(Number(next.bgOpacity ?? 0), 0, 1),
      textOpacity: clamp(Number(next.textOpacity ?? 1), 0, 1),
      fontSize: clamp(Math.floor(Number(next.fontSize ?? 16)), 10, 64),
      rows: Math.max(1, Math.floor(Number(next.rows ?? 1))),
      cols: Math.max(1, Math.floor(Number(next.cols ?? 48))),
      readMode,
      autoSpeed,
      speedMs: clamp(Math.floor(Number(computedSpeedMs ?? 1200)), 80, 30_000),
      charsPerMinute: baseCpm,
      linesPerTick: clamp(Math.floor(Number(next.linesPerTick ?? 1)), 1, 10),
      bgColor: String(next.bgColor ?? '#000000'),
      textColor: String(next.textColor ?? '#ffffff')
    }
    return safe
  }

  function applyCfg(next: OverlayConfig) {
    const safe = normalizeCfg(next)
    setCfg(safe)
    setJson(LS.cfg, safe)
  }

  const applyCfgRef = useRef(applyCfg)
  applyCfgRef.current = applyCfg

  function applyCfgExternal(next: OverlayConfig) {
    const safe = normalizeCfg(next)
    setCfg(safe)
  }

  async function applyBoundsFromCfg(next: OverlayConfig) {
    const fontSize = clamp(Math.floor(Number(next.fontSize ?? 18)), 10, 64)
    const rows = Math.max(1, Math.floor(Number(next.rows ?? 1)))
    const cols = Math.max(1, Math.floor(Number(next.cols ?? 48)))
    const paddingX = PAD_X
    const paddingY = PAD_Y
    const { charW, lineH } = getTextMetrics({ fontSize })
    const width = Math.round(cols * charW + paddingX * 2 + COL_FIT_SAFETY_PX)
    const height = Math.round(rows * lineH + paddingY * 2 + EXTRA_H)
    await window.api?.overlaySetBounds?.({ width, height })
    setBounds({ width, height })
  }

  useEffect(() => {
    // 设计目标：
    // - 用户“改行/列/字号”时：窗口像素尺寸随之变化，保证字的像素大小不变（不做缩放压扁）
    // - 用户“拖拽缩放窗口”时：行/列随窗口变化（字号不变）
    if (!bounds) return
    if (resizeRef.current?.active) return
    const key = `${cfg.fontSize}|${cfg.rows}|${cfg.cols}`
    if (lastAutoBoundsKeyRef.current === key) return
    lastAutoBoundsKeyRef.current = key
    void applyBoundsFromCfg(cfg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.fontSize, cfg.rows, cfg.cols, bounds?.width])

  useEffect(() => {
    // Overlay 必须响应来自工具栏/设置窗写入的 cfg，否则“字号/行列/外观”会表现为无效
    function onStorage(e: StorageEvent) {
      if (e.key !== LS.cfg && e.key !== LS.cfgLegacy) return
      const next = getCfgWithMigration(cfg)
      applyCfgExternal(next)
      // 注意：外部修改（例如工具栏调字号）不应联动改变阅读框的窗口像素尺寸；
      // 只更新 cfg，让“可显示文字数量”随字号/行列变化而变化。
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg])

  function calcRowsColsFromBounds(input: { width: number; height: number; fontSize: number }) {
    const fontSize = clamp(Math.floor(Number(input.fontSize ?? 16)), 10, 64)
    const paddingX = PAD_X
    const paddingY = PAD_Y
    const { charW, lineH: lineHeight } = getTextMetrics({ fontSize })
    // 与 applyBoundsFromCfg 的公式互逆：这里保守取整，避免抖动
    const cols = Math.max(1, Math.floor((Math.max(0, input.width - paddingX * 2 - COL_FIT_SAFETY_PX) + charW * 0.35) / Math.max(1, charW)))
    // 额外留一点余量给圆角/阴影；并扣掉 applyBoundsFromCfg 里加的 EXTRA_H
    // 重要：rows 必须“保守不溢出”，否则 canvas 高度会比 holder 实际可用高度更大，
    // 导致最后一行字下半部分/外框底边被窗口底缘裁剪。
    const rows = Math.max(1, Math.floor(Math.max(0, input.height - paddingY * 2 - EXTRA_H) / Math.max(1, lineHeight)))
    return { rows, cols }
  }

  useEffect(() => {
    function flushResizeFrame() {
      resizeRafRef.current = 0
      const p = pendingResizeRef.current
      if (!p) return
      lastAppliedResizeRef.current = p
      // 拖拽跟手：用 send 避免 invoke 排队；松手后再 invoke 对齐主进程状态
      window.api?.overlaySetBoundsFast?.({ width: p.w, height: p.h, x: p.x, y: p.y })
    }

    function onMove(e: MouseEvent) {
      const r = resizeRef.current
      if (!r?.active) return
      const curCfg = cfgRef.current
      if (!curCfg) return
      const dx = e.clientX - r.startX
      const dy = e.clientY - r.startY
      const nextW = Math.max(1, Math.round(r.startW + dx * r.dir.x))
      const nextH = Math.max(1, Math.round(r.startH + dy * r.dir.y))
      const nextX = r.dir.x < 0 ? Math.round(r.startWinX - (nextW - r.startW)) : r.startWinX
      const nextY = r.dir.y < 0 ? Math.round(r.startWinY - (nextH - r.startH)) : r.startWinY
      pendingResizeRef.current = { w: nextW, h: nextH, x: nextX, y: nextY }
      // 拖拽中实时预览“行/列 -> 边框高度/宽度”，让框体跟手；
      // 字号不变，真正配置写入仍在 mouseup，避免中途抖动和频繁写盘。
      const d = calcRowsColsFromBounds({ width: nextW, height: nextH, fontSize: curCfg.fontSize })
      setPreviewRowsCols((prev) => (prev && prev.rows === d.rows && prev.cols === d.cols ? prev : d))
      if (!resizeRafRef.current) {
        resizeRafRef.current = requestAnimationFrame(flushResizeFrame)
      }
    }
    function onUp() {
      const r = resizeRef.current
      if (!r) return
      if (resizeRafRef.current) {
        cancelAnimationFrame(resizeRafRef.current)
        resizeRafRef.current = 0
      }
      // 若最后一帧还没进 rAF，直接同步应用终点
      if (pendingResizeRef.current) {
        const p = pendingResizeRef.current
        lastAppliedResizeRef.current = p
        window.api?.overlaySetBoundsFast?.({ width: p.w, height: p.h, x: p.x, y: p.y })
      }
      pendingResizeRef.current = null

      const p = lastAppliedResizeRef.current
      const curCfg = cfgRef.current
      resizeRef.current = { ...r, active: false }

      if (p && curCfg) {
        const d = calcRowsColsFromBounds({ width: p.w, height: p.h, fontSize: curCfg.fontSize })
        applyCfgRef.current({ ...curCfg, rows: d.rows, cols: d.cols })
        void window.api?.overlaySetBounds?.({ width: p.w, height: p.h, x: p.x, y: p.y })
        setBounds({ width: p.w, height: p.h })
      }
      setPreviewRowsCols(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  return (
    <div
      style={
        {
          height: '100vh',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          boxSizing: 'border-box'
        } as any
      }
      onPointerDown={(e) => {
        if (e.button !== 0) return
        if (resizeRef.current?.active) return
        if (!canStartWindowMoveFromTarget(e.target)) return
        // 新一轮手势前清理上次可能遗留的状态（如漏掉 pointerup/cancel）
        stopWindowMoveGesture()
        moveGestureRef.current = { pointerId: e.pointerId, downX: e.clientX, downY: e.clientY, moved: false, active: true }
      }}
      onPointerMove={(e) => {
        const g = moveGestureRef.current
        if (!g?.active || g.pointerId !== e.pointerId) return
        if (g.moved) return
        const dx = Math.abs(e.clientX - g.downX)
        const dy = Math.abs(e.clientY - g.downY)
        const threshold = 4
        if (dx + dy < threshold) return
        g.moved = true
        // 一旦进入“拖动窗口”模式，就捕获指针，避免鼠标快速移动时丢事件；
        // 实际窗口移动在主进程完成（全局 cursor point），所以这里主要用于可靠收到 up/cancel。
        try {
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        } catch {
          // ignore
        }
        window.api?.overlayMoveStart?.()
      }}
      onPointerUp={(e) => {
        const g = moveGestureRef.current
        if (!g?.active || g.pointerId !== e.pointerId) return
        stopWindowMoveGesture()
      }}
      onPointerCancel={(e) => {
        const g = moveGestureRef.current
        if (!g?.active || g.pointerId !== e.pointerId) return
        stopWindowMoveGesture()
      }}
      onClick={(e) => {
        // 点击（非 resize/按钮区域）显示工具栏
        if (isInNoDragArea(e.target)) return
        // 顶部拖拽条只用于拖动窗口，避免误触弹出工具栏
        if (isOnDragStrip(e.target)) return
        // 如果本次是“拖动窗口”手势，则不弹出工具栏（避免拖完就弹）
        if (moveGestureRef.current?.moved) return
        // K 模式：单击正文退出（不立刻弹出工具栏，避免一次点击做两件事）
        if (kMode) {
          setKModeAndPersist(false, 'local')
          return
        }
        setFocused(true)
        void window.api?.overlayToolbarShow?.()
      }}
      onDoubleClick={(e) => {
        // 双击不做显示逻辑，避免误触；但阻止选中文本
        e.preventDefault()
      }}
      onContextMenu={() => {
        stopWindowMoveGesture()
      }}
    >
      <div
        style={
          {
            flex: 1,
            width: '100%',
            minHeight: 0,
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-start',
            alignItems: 'stretch',
            // 外层允许工具栏浮在边框外
            overflow: 'visible',
            userSelect: 'none'
          } as any
        }
        title={line}
      >
        {/* 顶部细小区域作为拖拽条，避免遮挡正文点击 */}
        {/* 当阅读框处于聚焦并显示 resize 时，顶部拖拽条需要“让路”给上边缘缩放手柄，
            否则部分窗口尺寸下会出现：按住上方框无法触发缩放手势。 */}
        {focused && !kMode ? (
          <>
            <div
              data-dragstrip="1"
              style={
                {
                  position: 'absolute',
                  top: -6,
                  left: 0,
                  width: 10,
                  height: 6,
                  WebkitAppRegion: 'drag',
                  cursor: 'grab'
                } as any
              }
            />
            <div
              data-dragstrip="1"
              style={
                {
                  position: 'absolute',
                  top: -6,
                  right: 0,
                  width: 10,
                  height: 6,
                  WebkitAppRegion: 'drag',
                  cursor: 'grab'
                } as any
              }
            />
          </>
        ) : (
          <div
            data-dragstrip="1"
            style={
              {
                position: 'absolute',
                top: -6,
                left: 0,
                right: 0,
                height: 6,
                WebkitAppRegion: 'drag',
                cursor: 'grab'
              } as any
            }
          />
        )}
        {/* 给工具条预留一条“透明安全区”，视觉上像放在阅读框外，但不会被窗口裁切 */}
        {topSafe ? <div style={{ height: topSafe }} /> : null}
        <div
          ref={holderRef}
          style={
            {
              width: '100%',
              position: 'relative',
              borderRadius: 10,
              boxSizing: 'border-box',
              padding: `${PAD_Y}px ${PAD_X}px`,
              // 外层不裁剪，避免工具栏和面板被裁掉
              overflow: 'visible',
              // 聚焦时用实线边框（避免 inset 阴影在透明窗口上下边被合成裁切）；失焦用透明边框保持布局不跳变
              border: frameActive ? '1px solid rgba(255,255,255,0.55)' : '1px solid transparent'
            } as any
          }
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: effectiveBgOpacity > 0 ? cfg.bgColor : 'transparent',
              opacity: effectiveBgOpacity,
              borderRadius: 10,
              pointerEvents: 'none',
              willChange: 'opacity'
            }}
          />
          <canvas
            ref={canvasRef}
            style={{
              position: 'relative',
              zIndex: 1,
              width: '100%',
              height: canvasCssH,
              display: 'block',
              // 仅裁剪绘制结果，避免出框
              overflow: 'hidden',
              // 保持透明
              background: 'transparent'
            }}
          />
          {/* 缩放手柄相对阅读框（holder）定位；之前若在满高父级上会贴窗口底缘压在边框上 */}
          {focused && !kMode ? (
            <>
            <div
              title="缩放手柄：拖曳调整阅读框大小"
              onMouseDown={(e) => void onResizeMouseDown(e, { x: 1, y: 1 })}
              data-nodrag="1"
              data-resize-handle="1"
              style={{
                position: 'absolute',
                right: 7,
                bottom: 7,
                width: 14,
                height: 14,
                zIndex: 2,
                WebkitAppRegion: 'no-drag',
                cursor: 'nwse-resize',
                background: 'rgba(255,255,255,0.14)',
                borderRadius: 4,
                boxSizing: 'border-box',
                border: '1px solid rgba(255,255,255,0.25)'
              } as any}
            />
            <div
              onMouseDown={(e) => void onResizeMouseDown(e, { x: -1, y: 0 })}
              data-nodrag="1"
              data-resize-handle="1"
              style={{
                position: 'absolute',
                left: 0,
                top: 10,
                bottom: 10,
                width: 6,
                cursor: 'ew-resize',
                WebkitAppRegion: 'no-drag',
                background: 'transparent',
                zIndex: 2
              } as any}
            />
            <div
              onMouseDown={(e) => void onResizeMouseDown(e, { x: 1, y: 0 })}
              data-nodrag="1"
              data-resize-handle="1"
              style={{
                position: 'absolute',
                right: 0,
                top: 10,
                bottom: 10,
                width: 6,
                cursor: 'ew-resize',
                WebkitAppRegion: 'no-drag',
                background: 'transparent',
                zIndex: 2
              } as any}
            />
            <div
              onMouseDown={(e) => void onResizeMouseDown(e, { x: 0, y: -1 })}
              data-nodrag="1"
              data-resize-handle="1"
              style={{
                position: 'absolute',
                left: 10,
                right: 10,
                top: 0,
                height: 6,
                cursor: 'ns-resize',
                WebkitAppRegion: 'no-drag',
                background: 'transparent',
                zIndex: 2
              } as any}
            />
            <div
              onMouseDown={(e) => void onResizeMouseDown(e, { x: 0, y: 1 })}
              data-nodrag="1"
              data-resize-handle="1"
              style={{
                position: 'absolute',
                left: 10,
                right: 10,
                bottom: 0,
                height: 6,
                cursor: 'ns-resize',
                WebkitAppRegion: 'no-drag',
                background: 'transparent',
                zIndex: 2
              } as any}
            />
            <div
              onMouseDown={(e) => void onResizeMouseDown(e, { x: -1, y: -1 })}
              data-nodrag="1"
              data-resize-handle="1"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: 8,
                height: 8,
                cursor: 'nwse-resize',
                WebkitAppRegion: 'no-drag',
                background: 'transparent',
                zIndex: 2
              } as any}
            />
            <div
              onMouseDown={(e) => void onResizeMouseDown(e, { x: 1, y: -1 })}
              data-nodrag="1"
              data-resize-handle="1"
              style={{
                position: 'absolute',
                right: 0,
                top: 0,
                width: 8,
                height: 8,
                cursor: 'nesw-resize',
                WebkitAppRegion: 'no-drag',
                background: 'transparent',
                zIndex: 2
              } as any}
            />
            <div
              onMouseDown={(e) => void onResizeMouseDown(e, { x: -1, y: 1 })}
              data-nodrag="1"
              data-resize-handle="1"
              style={{
                position: 'absolute',
                left: 0,
                bottom: 0,
                width: 8,
                height: 8,
                cursor: 'nesw-resize',
                WebkitAppRegion: 'no-drag',
                background: 'transparent',
                zIndex: 2
              } as any}
            />
          </>
        ) : null}
        </div>
      </div>
    </div>
  )
}

