import React, { useEffect, useMemo, useState } from 'react'

type OverlayConfig = {
  bgOpacity: number
  bgColor: string
  textColor: string
  textOpacity: number
  fontSize: number
  rows: number
  cols: number
  contentProtection?: boolean
  readMode?: 'scroll' | 'page'
  autoSpeed: boolean
  speedMs: number
  charsPerMinute: number
  linesPerTick: number
}

const LS = { cfg: 'overlay:cfg', cfgLegacy: 'demo:cfg' } as const
const LS_FONT_FAMILY = 'overlay:fontFamily' as const
const LS_TOOLBAR = 'overlay:toolbar' as const
const LS_KMODE = 'overlay:kMode' as const
const LS_HOTKEYS = 'overlay:hotkeys' as const

type ToolbarKey =
  | 'playPause'
  | 'pagePrev'
  | 'pageNext'
  | 'chapterPrev'
  | 'chapterNext'
  | 'kbdMode'
  | 'fontMinus'
  | 'fontPlus'
  | 'settings'
  | 'close'

const ALL_TOOLBAR_KEYS: Array<{ key: ToolbarKey; label: string }> = [
  { key: 'playPause', label: '开始/暂停' },
  { key: 'chapterPrev', label: '上一章' },
  { key: 'chapterNext', label: '下一章' },
  { key: 'pagePrev', label: '上一页' },
  { key: 'pageNext', label: '下一页' },
  { key: 'kbdMode', label: '键盘操控' },
  { key: 'fontMinus', label: '字号减小' },
  { key: 'fontPlus', label: '字号增大' },
  { key: 'settings', label: '设置' },
  { key: 'close', label: '关闭' }
]

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

function normalizeKeyFromEvent(e: KeyboardEvent) {
  const k = String(e.key || '')
  if (!k) return ''
  if (k === ' ') return 'Space'
  if (k.length === 1) return k.toUpperCase()
  return k
}

function bindingToLabel(b: HotkeyBinding | null | undefined) {
  if (!b || !b.key) return '未设置'
  const parts: string[] = []
  if (b.meta) parts.push('Meta')
  if (b.ctrl) parts.push('Ctrl')
  if (b.alt) parts.push('Alt')
  if (b.shift) parts.push('Shift')
  parts.push(String(b.key))
  return parts.join('+')
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
    // backward compatible: single binding object
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

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function charsPerTickFromCfg(input: { cols: number; linesPerTick: number }) {
  const cols = Math.max(1, Math.floor(input.cols || 48))
  const linesPerTick = clamp(Math.floor(input.linesPerTick || 1), 1, 10)
  return Math.max(1, cols * linesPerTick)
}

function calcSpeedMsFromCpm(input: { cols: number; rows?: number; linesPerTick: number; charsPerMinute: number }) {
  const cpm = clamp(Math.floor(Number(input.charsPerMinute ?? 100)), 0, 2000)
  const charsPerTick = charsPerTickFromCfg(input)
  const rows = Math.max(1, Math.floor(input.rows ?? 1))
  if (cpm <= 0) return 30_000
  let ms = Math.round((60_000 * charsPerTick) / cpm)
  const minPageMs = 2800
  const minMsPerTickFromPage = Math.round((minPageMs * Math.max(1, input.linesPerTick)) / rows)
  const minTickMs = 900
  ms = clamp(ms, Math.max(minTickMs, minMsPerTickFromPage), 30_000)
  return ms
}

function calcCpmFromSpeedMs(input: { cols: number; linesPerTick: number; speedMs: number }) {
  const ms = clamp(Math.floor(input.speedMs || 600), 80, 30_000)
  const charsPerTick = charsPerTickFromCfg(input)
  const cpm = Math.round((60_000 * charsPerTick) / ms)
  return clamp(cpm, 0, 2000)
}

function getCfgWithMigration(fallback: OverlayConfig): OverlayConfig {
  const next = getJson<OverlayConfig>(LS.cfg, fallback)
  if (next && typeof next === 'object') return next
  const legacy = getJson<OverlayConfig>(LS.cfgLegacy, fallback)
  if (legacy && typeof legacy === 'object') return legacy
  return fallback
}

export function OverlaySettingsView() {
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
      linesPerTick: 1,
      contentProtection: false
    })
  )
  const [toolbarKeys, setToolbarKeys] = useState<ToolbarKey[]>(() => {
    const fallback = ALL_TOOLBAR_KEYS.map((x) => x.key)
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
  })
  const [kModeEnabled, setKModeEnabled] = useState<boolean>(() => Boolean(getJson(LS_KMODE, { enabled: false } as any)?.enabled))
  const [hotkeys, setHotkeys] = useState<HotkeyConfig>(() => normalizeHotkeysConfig(getJson<HotkeyConfig>(LS_HOTKEYS, getDefaultHotkeys())))
  const [captureAction, setCaptureAction] = useState<HotkeyAction | null>(null)
  const [settingsTab, setSettingsTab] = useState<'外观' | '操控' | '高级'>('外观')

  useEffect(() => {
    document.documentElement.classList.add('overlayAuxHost')
    document.body.classList.add('overlayAuxHost')
    return () => {
      document.documentElement.classList.remove('overlayAuxHost')
      document.body.classList.remove('overlayAuxHost')
    }
  }, [])

  useEffect(() => {
    // 打开/切 Tab 时只请求主进程按默认高度 + 可用空间布局；外框高度不随内容膨胀
    void window.api?.overlaySettingsResize?.({ width: 300 })
  }, [settingsTab])

  useEffect(() => {
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
    function onStorage(e: StorageEvent) {
      if (e.key === LS_TOOLBAR) {
        const fallback = ALL_TOOLBAR_KEYS.map((x) => x.key)
        const raw = localStorage.getItem(LS_TOOLBAR)
        if (!raw) return setToolbarKeys(fallback)
        try {
          const parsed = JSON.parse(raw) as any
          const keys = Array.isArray(parsed?.keys) ? (parsed.keys as any[]) : []
          const safe = keys.filter((k) => typeof k === 'string') as ToolbarKey[]
          setToolbarKeys(safe.length ? safe : fallback)
        } catch {
          setToolbarKeys(fallback)
        }
      }
      if (e.key === LS_KMODE) setKModeEnabled(Boolean(getJson(LS_KMODE, { enabled: false } as any)?.enabled))
      if (e.key === LS_HOTKEYS) setHotkeys(normalizeHotkeysConfig(getJson<HotkeyConfig>(LS_HOTKEYS, getDefaultHotkeys())))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cpmHint = useMemo(() => calcCpmFromSpeedMs({ cols: cfg.cols, linesPerTick: cfg.linesPerTick, speedMs: cfg.speedMs }), [cfg.cols, cfg.linesPerTick, cfg.speedMs])

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

  function applyCfg(next: OverlayConfig) {
    const autoSpeed = Boolean(next.autoSpeed ?? false)
    const readMode: 'scroll' | 'page' = next.readMode === 'page' || next.readMode === 'scroll' ? next.readMode : 'scroll'
    const baseCpm = clamp(Math.floor(Number(next.charsPerMinute ?? 100)), 0, 2000)
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
      textColor: String(next.textColor ?? '#ffffff'),
      contentProtection: Boolean(next.contentProtection)
    }
    setCfg(safe)
    setJson(LS.cfg, safe)
  }

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== LS.cfg && e.key !== LS.cfgLegacy) return
      const next = getCfgWithMigration(cfg)
      setCfg(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [cfg])

  function setToolbar(next: ToolbarKey[]) {
    const safe = Array.from(new Set(next))
    setToolbarKeys(safe)
    setJson(LS_TOOLBAR, { keys: safe })
  }

  async function setKMode(next: boolean) {
    const enabled = Boolean(next)
    setKModeEnabled(enabled)
    setJson(LS_KMODE, { enabled })
    await window.api?.overlayKModeSet?.(enabled)
    if (enabled) {
      // 从设置页开启 K：更像“确认进入”，收起设置窗以保持画面干净
      await window.api?.overlaySettingsHide?.()
    }
  }

  function setHotkeysConfig(next: HotkeyConfig) {
    const safe: HotkeyConfig = normalizeHotkeysConfig(next)
    setHotkeys(safe)
    setJson(LS_HOTKEYS, safe)
  }

  useEffect(() => {
    if (!captureAction) return
    const handler = (e: KeyboardEvent) => {
      // 录入时屏蔽默认行为
      e.preventDefault()
      e.stopPropagation()
      const key = normalizeKeyFromEvent(e)
      if (!key || key === 'Escape') {
        setCaptureAction(null)
        return
      }
      const binding: HotkeyBinding = {
        key,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        meta: e.metaKey
      }
      const prevList = Array.isArray(hotkeys?.bindings?.[captureAction]) ? (hotkeys?.bindings?.[captureAction] as HotkeyBinding[]) : []
      const sig = JSON.stringify(binding)
      const exists = prevList.some((x) => JSON.stringify(x) === sig)
      const next: HotkeyConfig = {
        bindings: { ...(hotkeys?.bindings ?? {}), [captureAction]: exists ? prevList : [...prevList, binding] }
      }
      setHotkeysConfig(next)
      setCaptureAction(null)
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true } as any)
  }, [captureAction, hotkeys])

  return (
    <div
      style={
        {
          height: '100vh',
          padding: 8,
          boxSizing: 'border-box',
          background: 'transparent',
          WebkitAppRegion: 'drag',
          overflow: 'hidden'
        } as any
      }
    >
      <div
        className="overlaySettingsPanel"
        style={
          {
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            border: '1px solid rgba(255,255,255,0.28)',
            background: 'rgba(28,28,28,0.98)',
            borderRadius: 12,
            padding: 12,
            color: '#fff',
            boxSizing: 'border-box',
            WebkitAppRegion: 'no-drag'
          } as any
        }
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
            paddingBottom: 8,
            borderBottom: '1px solid rgba(255,255,255,0.12)',
            WebkitAppRegion: 'drag',
            flexShrink: 0
          } as any}
        >
          <div style={{ fontSize: 13, fontWeight: 600, opacity: 0.95 }}>阅读框设置</div>
          <button
            className="btn"
            style={
              {
                background: 'rgba(255,255,255,0.12)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.2)',
                padding: '4px 10px',
                WebkitAppRegion: 'no-drag'
              } as any
            }
            onClick={() => void window.api?.overlaySettingsHide?.()}
            title="关闭"
          >
            关闭
          </button>
        </div>

        <div className="overlaySettingsTabs" role="tablist" aria-label="设置分组">
          {(['外观', '操控', '高级'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={settingsTab === t}
              className={`overlaySettingsTab ${settingsTab === t ? 'overlaySettingsTabActive' : ''}`}
              onClick={() => setSettingsTab(t)}
            >
              {t}
            </button>
          ))}
        </div>

        <div
          className="overlaySettingsBody"
          style={
            {
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              WebkitAppRegion: 'no-drag'
            } as any
          }
        >          {settingsTab === '外观' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>颜色与透明</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 12 }}>文字</span>
                    <input type="color" value={cfg.textColor} onChange={(e) => applyCfg({ ...cfg, textColor: e.target.value })} />
                  </label>
                  <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flex: 1, minWidth: 140 }}>
                    <span style={{ fontSize: 12 }}>透明</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={cfg.textOpacity}
                      onChange={(e) => applyCfg({ ...cfg, textOpacity: Number(e.target.value) })}
                      style={{ flex: 1 }}
                    />
                    <span style={{ width: 32, textAlign: 'right', fontSize: 11 }}>{cfg.textOpacity.toFixed(2)}</span>
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                  <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 12 }}>背景</span>
                    <input type="color" value={cfg.bgColor} onChange={(e) => applyCfg({ ...cfg, bgColor: e.target.value })} />
                  </label>
                  <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flex: 1, minWidth: 140 }}>
                    <span style={{ fontSize: 12 }}>透明</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={cfg.bgOpacity}
                      onChange={(e) => applyCfg({ ...cfg, bgOpacity: Number(e.target.value) })}
                      style={{ flex: 1 }}
                    />
                    <span style={{ width: 32, textAlign: 'right', fontSize: 11 }}>{cfg.bgOpacity.toFixed(2)}</span>
                  </label>
                </div>
              </div>

              <div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>尺寸与排版</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 12 }}>字号</span>
                    <input
                      type="number"
                      min={10}
                      max={64}
                      value={cfg.fontSize}
                      onChange={(e) => {
                        const fontSize = Number(e.target.value)
                        let next = { ...cfg, fontSize }
                        void (async () => {
                          const b = (await window.api?.overlayGetBounds?.()) as any
                          if (b && typeof b.width === 'number' && typeof b.height === 'number') {
                            const derived = deriveRowsColsFromBounds({ width: b.width, height: b.height, fontSize })
                            next = { ...next, rows: derived.rows, cols: derived.cols }
                          }
                          applyCfg(next)
                        })()
                      }}
                      style={{ width: 52 }}
                    />
                  </label>
                  <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 12 }}>行</span>
                    <input
                      type="number"
                      value={cfg.rows}
                      onChange={(e) => applyCfg({ ...cfg, rows: Number(e.target.value) })}
                      style={{ width: 44 }}
                    />
                  </label>
                  <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 12 }}>列</span>
                    <input
                      type="number"
                      value={cfg.cols}
                      onChange={(e) => applyCfg({ ...cfg, cols: Number(e.target.value) })}
                      style={{ width: 52 }}
                    />
                  </label>
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 8 }}>拖拽阅读条也会自动换算行/列。</div>
              </div>
            </div>
          ) : null}

          {settingsTab === '操控' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={kModeEnabled} onChange={(e) => void setKMode(e.target.checked)} />
                <span style={{ fontSize: 12 }}>启用 K 模式（仅阅读条前台生效）</span>
              </label>

              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>快捷键</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {(
                  [
                    { key: 'playPause', label: '开始/暂停' },
                    { key: 'pagePrev', label: '上一页' },
                    { key: 'pageNext', label: '下一页' },
                    { key: 'chapterPrev', label: '上一章' },
                    { key: 'chapterNext', label: '下一章' }
                  ] as Array<{ key: HotkeyAction; label: string }>
                ).map((it) => {
                  const curList = Array.isArray(hotkeys?.bindings?.[it.key]) ? (hotkeys?.bindings?.[it.key] as HotkeyBinding[]) : []
                  const capturing = captureAction === it.key
                  return (
                    <div key={it.key} className="overlayHotkeyRow">
                      <div className="overlayHotkeyLabel">{it.label}</div>
                      <div className="overlayHotkeyKeys">
                        {capturing ? (
                          <span style={{ fontSize: 11, opacity: 0.75 }}>按下按键…</span>
                        ) : curList.length > 0 ? (
                          curList.map((b, idx) => (
                            <span key={`${it.key}-${idx}-${bindingToLabel(b)}`} className="overlayHotkeyChip">
                              {bindingToLabel(b)}
                              <button
                                type="button"
                                className="overlayHotkeyChipX"
                                onClick={() => {
                                  const nextList = curList.filter((_, i) => i !== idx)
                                  setHotkeysConfig({ bindings: { ...(hotkeys?.bindings ?? {}), [it.key]: nextList } })
                                }}
                                title="移除"
                              >
                                ×
                              </button>
                            </span>
                          ))
                        ) : (
                          <span style={{ fontSize: 11, opacity: 0.5 }}>未设置</span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="overlayHotkeyAdd"
                        onClick={() => setCaptureAction(capturing ? null : it.key)}
                        title={capturing ? '取消' : '添加快捷键'}
                      >
                        {capturing ? '取消' : '+'}
                      </button>
                    </div>
                  )
                })}
              </div>
              <button
                className="btn"
                style={{ background: 'rgba(255,255,255,0.12)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', alignSelf: 'flex-start' } as any}
                onClick={() => setHotkeysConfig(getDefaultHotkeys())}
              >
                恢复默认
              </button>
            </div>
          ) : null}

          {settingsTab === '高级' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>阅读与速度</div>
                <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12 }}>模式</span>
                  <select
                    value={(cfg.readMode ?? 'scroll') as any}
                    onChange={(e) => applyCfg({ ...cfg, readMode: e.target.value === 'page' ? 'page' : 'scroll' })}
                    style={{ height: 28 }}
                  >
                    <option value="scroll">滚动</option>
                    <option value="page">翻页</option>
                  </select>
                </label>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, minWidth: 56 }}>字/分钟</span>
                  <input
                    type="range"
                    min={0}
                    max={2000}
                    step={1}
                    value={cfg.charsPerMinute}
                    onChange={(e) => applyCfg({ ...cfg, autoSpeed: true, charsPerMinute: Number(e.target.value) })}
                    style={{ flex: 1, minWidth: 80 }}
                  />
                  <span style={{ width: 40, textAlign: 'right', fontSize: 12 }}>{cfg.charsPerMinute}</span>
                </label>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                  <span style={{ fontSize: 12, minWidth: 56 }}>每次前进</span>
                  {(cfg.readMode ?? 'scroll') === 'page' ? (
                    <span style={{ fontSize: 12 }}>{cfg.rows} 行/页</span>
                  ) : (
                    <>
                      <input
                        type="range"
                        min={1}
                        max={10}
                        step={1}
                        value={cfg.linesPerTick}
                        onChange={(e) => applyCfg({ ...cfg, linesPerTick: Number(e.target.value) })}
                        style={{ flex: 1, minWidth: 80 }}
                      />
                      <span style={{ fontSize: 12 }}>{cfg.linesPerTick} 行</span>
                    </>
                  )}
                </label>
                <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <input type="checkbox" checked={cfg.autoSpeed} onChange={(e) => applyCfg({ ...cfg, autoSpeed: e.target.checked })} />
                  <span style={{ fontSize: 12 }}>自动换算</span>
                </label>
                {!cfg.autoSpeed ? (
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                    <span style={{ fontSize: 12, minWidth: 56 }}>ms/tick</span>
                    <input
                      type="range"
                      min={80}
                      max={30000}
                      step={10}
                      value={cfg.speedMs}
                      onChange={(e) => applyCfg({ ...cfg, speedMs: Number(e.target.value) })}
                      style={{ flex: 1, minWidth: 80 }}
                    />
                    <span style={{ fontSize: 11 }}>
                      {cfg.speedMs} ≈ {cpmHint}
                    </span>
                  </label>
                ) : null}
              </div>

              <div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>显示与隐私</div>
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={Boolean(cfg.contentProtection)}
                    onChange={(e) => applyCfg({ ...cfg, contentProtection: e.target.checked })}
                    style={{ marginTop: 2 }}
                  />
                  <span style={{ fontSize: 12, lineHeight: 1.4 }}>
                    内容保护
                    <span style={{ display: 'block', fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 2 }}>
                      降低录屏/截图可见性（视系统能力而定）
                    </span>
                  </span>
                </label>
              </div>

              <div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>工具栏图标</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                  <button
                    className="btn"
                    style={{ background: 'rgba(255,255,255,0.12)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', padding: '4px 8px' } as any}
                    onClick={() => setToolbar(ALL_TOOLBAR_KEYS.map((x) => x.key))}
                  >
                    全选
                  </button>
                  <button
                    className="btn"
                    style={{ background: 'rgba(255,255,255,0.12)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', padding: '4px 8px' } as any}
                    onClick={() => setToolbar([])}
                  >
                    全不选
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  {ALL_TOOLBAR_KEYS.map((it) => {
                    const checked = toolbarKeys.includes(it.key)
                    return (
                      <label key={it.key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.target.checked ? [...toolbarKeys, it.key] : toolbarKeys.filter((k) => k !== it.key)
                            setToolbar(next)
                          }}
                        />
                        <span style={{ fontSize: 12 }}>{it.label}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

