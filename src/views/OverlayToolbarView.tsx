import React, { useEffect, useMemo, useState } from 'react'

type OverlayConfig = {
  fontSize: number
  rows: number
  cols: number
  readMode?: 'scroll' | 'page'
  linesPerTick: number
  charsPerMinute: number
  autoSpeed: boolean
  speedMs: number
  bgOpacity: number
  bgColor: string
  textColor: string
  textOpacity: number
}

const LS = { cfg: 'overlay:cfg', cfgLegacy: 'demo:cfg' } as const

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function getTextMetrics(input: { fontSize: number }) {
  const fontSize = clamp(Math.floor(Number(input.fontSize ?? 16)), 10, 64)
  const fontFamily = window.getComputedStyle(document.body).fontFamily || 'system-ui'
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  let charW = Math.max(1, fontSize * 0.95)
  if (ctx) {
    ctx.font = `${fontSize}px ${fontFamily}`
    const wHan = ctx.measureText('汉').width
    const wM = ctx.measureText('M').width
    const w0 = ctx.measureText('0').width
    charW = Math.max(1, Math.max(wHan, (wM + w0) / 2))
  }
  const lineH = Math.round(fontSize * 1.25)
  return { charW, lineH }
}

function deriveRowsColsFromBounds(input: { width: number; height: number; fontSize: number }) {
  const fontSize = clamp(Math.floor(Number(input.fontSize ?? 16)), 10, 64)
  const paddingX = 14 + 10
  const paddingY = 10 + 10
  const { charW, lineH } = getTextMetrics({ fontSize })
  const cols = Math.max(1, Math.floor((Math.max(0, input.width - paddingX * 2) + charW * 0.35) / Math.max(1, charW)))
  const rows = Math.max(1, Math.floor((Math.max(0, input.height - paddingY * 2 - 12) + lineH * 0.35) / Math.max(1, lineH)))
  return { rows, cols }
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

function setJson(key: string, val: unknown) {
  localStorage.setItem(key, JSON.stringify(val))
}

type OverlaySession = {
  bookId: string
  itemId: string
  lines: string[]
  lineIndex: number
  playing: boolean
}

type ToolbarKey =
  | 'playPause'
  | 'pagePrev'
  | 'pageNext'
  | 'chapterPrev'
  | 'chapterNext'
  | 'fontMinus'
  | 'fontPlus'
  | 'settings'
  | 'close'

const LS_TOOLBAR = 'overlay:toolbar' as const

function getToolbarCfg(fallback: ToolbarKey[]) {
  const raw = localStorage.getItem(LS_TOOLBAR)
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw) as any
    const keys = Array.isArray(parsed?.keys) ? (parsed.keys as any[]) : []
    const safe = keys.filter((k) => typeof k === 'string') as ToolbarKey[]
    return safe.length ? safe : fallback
  } catch {
    return fallback
  }
}

function hasKey(keys: ToolbarKey[], k: ToolbarKey) {
  return keys.includes(k)
}

function IconPlay() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3.5v9l7-4.5-7-4.5z" fill="currentColor" />
    </svg>
  )
}

function IconPause() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 3.5h2v9h-2zM9.5 3.5h2v9h-2z" fill="currentColor" />
    </svg>
  )
}

function IconPrev() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.5 8l5 4V4l-5 4zM4 4h1.8v8H4z" fill="currentColor" />
    </svg>
  )
}

function IconNext() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.5 8l-5-4v8l5-4zM10.2 4H12v8h-1.8z" fill="currentColor" />
    </svg>
  )
}

function IconChapterPrev() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {/* 左箭头 + 章节列表（区别于翻页的“媒体式”箭头） */}
      <path d="M7 4.5 3.5 8 7 11.5V9.6h3.1V6.4H7V4.5z" fill="currentColor" />
      <path d="M11.2 5.3h1.6v1.2h-1.6zM11.2 7.4h1.6v1.2h-1.6zM11.2 9.5h1.6v1.2h-1.6z" fill="currentColor" opacity="0.9" />
    </svg>
  )
}

function IconChapterNext() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {/* 右箭头 + 章节列表（与上一章对称） */}
      <path d="M9 4.5v1.9h-3.1v3.2H9v1.9L12.5 8 9 4.5z" fill="currentColor" />
      <path d="M3.2 5.3h1.6v1.2H3.2zM3.2 7.4h1.6v1.2H3.2zM3.2 9.5h1.6v1.2H3.2z" fill="currentColor" opacity="0.9" />
    </svg>
  )
}

function IconMinus() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 7.75h8v1.5H4z" fill="currentColor" />
    </svg>
  )
}

function IconPlus() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M7.25 4v3.25H4v1.5h3.25V12h1.5V8.75H12v-1.5H8.75V4z" fill="currentColor" />
    </svg>
  )
}

function IconSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 5.25A2.75 2.75 0 1 0 8 10.75 2.75 2.75 0 0 0 8 5.25zm0-3.25c.3 0 .57.18.68.46l.38.96c.18.05.35.11.52.19l.95-.39a.75.75 0 0 1 .95.32l.75 1.3a.75.75 0 0 1-.14.91l-.72.72c.03.19.05.38.05.58 0 .2-.02.39-.05.58l.72.72c.24.24.3.61.14.91l-.75 1.3a.75.75 0 0 1-.95.32l-.95-.39a4 4 0 0 1-.52.19l-.38.96A.75.75 0 0 1 8 14.5H7a.75.75 0 0 1-.68-.46l-.38-.96a4 4 0 0 1-.52-.19l-.95.39a.75.75 0 0 1-.95-.32l-.75-1.3a.75.75 0 0 1 .14-.91l.72-.72A4 4 0 0 1 3.5 8c0-.2.02-.39.05-.58l-.72-.72a.75.75 0 0 1-.14-.91l.75-1.3a.75.75 0 0 1 .95-.32l.95.39c.17-.08.34-.14.52-.19l.38-.96A.75.75 0 0 1 7 2h1z"
        fill="currentColor"
      />
    </svg>
  )
}

function IconClose() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function OverlayToolbarView() {
  const [session, setSession] = useState<OverlaySession | null>(null)
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
      speedMs: 1200,
      linesPerTick: 1
    })
  )
  const allKeys: ToolbarKey[] = useMemo(
    () => ['playPause', 'chapterPrev', 'chapterNext', 'pagePrev', 'pageNext', 'fontMinus', 'fontPlus', 'settings', 'close'],
    []
  )
  const [toolbarKeys, setToolbarKeys] = useState<ToolbarKey[]>(() => getToolbarCfg(allKeys))

  useEffect(() => {
    let off: null | (() => void) = null
    async function init() {
      off = window.api?.overlayOnSession?.((next) => {
        const s = next as any
        if (s && typeof s === 'object') setSession(s as OverlaySession)
        else setSession(null)
      }) ?? null
      const raw = (await window.api?.overlayGetSession?.()) as any
      if (raw && typeof raw === 'object') setSession(raw as OverlaySession)
    }
    void init()
    return () => off?.()
  }, [])

  useEffect(() => {
    // 主窗口全局样式把 body 设成了浅色背景；工具栏窗口需要完全透明。
    const prevBodyBg = document.body.style.background
    const prevHtmlBg = document.documentElement.style.background
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
    return () => {
      document.body.style.background = prevBodyBg
      document.documentElement.style.background = prevHtmlBg
    }
  }, [])

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === LS.cfg || e.key === LS.cfgLegacy) setCfg(getCfgWithMigration(cfg))
      if (e.key === LS_TOOLBAR) setToolbarKeys(getToolbarCfg(allKeys))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [cfg])

  const playing = Boolean(session?.playing ?? false)

  useEffect(() => {
    document.documentElement.classList.add('overlayAuxHost')
    document.body.classList.add('overlayAuxHost')
    return () => {
      document.documentElement.classList.remove('overlayAuxHost')
      document.body.classList.remove('overlayAuxHost')
    }
  }, [])

  async function bumpFont(delta: number) {
    const fontSize = clamp(cfg.fontSize + delta, 10, 64)
    let next = { ...cfg, fontSize }
    const b = (await window.api?.overlayGetBounds?.()) as any
    if (b && typeof b.width === 'number' && typeof b.height === 'number') {
      const derived = deriveRowsColsFromBounds({ width: b.width, height: b.height, fontSize })
      next = { ...next, rows: derived.rows, cols: derived.cols }
    }
    setCfg(next)
    setJson(LS.cfg, next)
  }

  async function stepPage(deltaPages: number) {
    // 若当前在自动阅读，先暂停，再按“当前页”做相对翻页，避免跳回自动阅读开始位置
    if (playing) await window.api?.overlaySetPlaying?.(false)
    const step = Math.max(1, Math.floor(cfg.rows || 1))
    await window.api?.overlayStepDisplay?.(deltaPages * step)
  }

  async function stepChapter(delta: number) {
    // 手动切章先暂停，避免自动阅读定时推进与切章并发导致“乱跳”
    if (playing) await window.api?.overlaySetPlaying?.(false)
    await window.api?.overlayChapterStep?.(delta)
  }

  // 注意：toolbar 端拿到的 session.lines 是“原始行”，与 Overlay 端的“显示行”不一致，
  // 用它来 disable 会造成“明明还能翻却按钮变灰/无效”的错觉。
  const canPrev = Boolean(session)
  const canNext = Boolean(session)

  return (
    <div
      className="overlayToolbarRoot"
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        padding: 8,
        boxSizing: 'border-box',
        userSelect: 'none',
        background: 'transparent',
        // 让工具栏窗口本体可拖拽；按钮等交互区域会覆盖为 no-drag
        WebkitAppRegion: 'drag'
      } as any}
    >
      <div className="overlayToolbar" data-nodrag="1" style={{ WebkitAppRegion: 'no-drag' } as any}>
        <div className="overlayToolbarGroup">
          {hasKey(toolbarKeys, 'playPause') ? (
            <button className="overlayToolBtn" onClick={() => void window.api?.overlaySetPlaying?.(!playing)} title={playing ? '暂停' : '开始'}>
              {playing ? <IconPause /> : <IconPlay />}
            </button>
          ) : null}
          {hasKey(toolbarKeys, 'chapterPrev') ? (
            <button className="overlayToolBtn" onClick={() => void stepChapter(-1)} title="上一章">
              <IconChapterPrev />
            </button>
          ) : null}
          {hasKey(toolbarKeys, 'chapterNext') ? (
            <button className="overlayToolBtn" onClick={() => void stepChapter(1)} title="下一章">
              <IconChapterNext />
            </button>
          ) : null}
          {hasKey(toolbarKeys, 'pagePrev') ? (
            <button
              className="overlayToolBtn"
              onClick={() => stepPage(-1)}
              title="上一页"
              disabled={!canPrev}
              style={canPrev ? ({} as any) : ({ opacity: 0.4, cursor: 'not-allowed' } as any)}
            >
              <IconPrev />
            </button>
          ) : null}
          {hasKey(toolbarKeys, 'pageNext') ? (
            <button
              className="overlayToolBtn"
              onClick={() => stepPage(1)}
              title="下一页"
              disabled={!canNext}
              style={canNext ? ({} as any) : ({ opacity: 0.4, cursor: 'not-allowed' } as any)}
            >
              <IconNext />
            </button>
          ) : null}
        </div>
        <div className="overlayToolbarDivider" />
        <div className="overlayToolbarGroup">
          {hasKey(toolbarKeys, 'fontMinus') ? (
            <button className="overlayToolBtn" onClick={() => void bumpFont(-1)} title="字号减小">
              <IconMinus />
            </button>
          ) : null}
          {hasKey(toolbarKeys, 'fontPlus') ? (
            <button className="overlayToolBtn" onClick={() => void bumpFont(1)} title="字号增大">
              <IconPlus />
            </button>
          ) : null}
        </div>
        <div className="overlayToolbarDivider" />
        <div className="overlayToolbarGroup">
          {hasKey(toolbarKeys, 'settings') ? (
            <button className="overlayToolBtn" onClick={() => void window.api?.overlaySettingsShow?.()} title="阅读框设置">
              <IconSettings />
            </button>
          ) : null}
          {hasKey(toolbarKeys, 'close') ? (
            <button className="overlayToolBtn overlayToolBtnDanger" onClick={() => void window.api?.overlayHide?.()} title="关闭阅读条">
              <IconClose />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

