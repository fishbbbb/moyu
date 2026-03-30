import React, { useEffect, useMemo, useState } from 'react'

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
  speedMs: number
  charsPerMinute: number
  linesPerTick: number
}

const LS = { cfg: 'overlay:cfg', cfgLegacy: 'demo:cfg' } as const
const LS_FONT_FAMILY = 'overlay:fontFamily' as const
const LS_TOOLBAR = 'overlay:toolbar' as const

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

const ALL_TOOLBAR_KEYS: Array<{ key: ToolbarKey; label: string }> = [
  { key: 'playPause', label: '开始/暂停' },
  { key: 'chapterPrev', label: '上一章' },
  { key: 'chapterNext', label: '下一章' },
  { key: 'pagePrev', label: '上一页' },
  { key: 'pageNext', label: '下一页' },
  { key: 'fontMinus', label: '字号减小' },
  { key: 'fontPlus', label: '字号增大' },
  { key: 'settings', label: '设置' },
  { key: 'close', label: '关闭' }
]

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
  const cpm = clamp(Math.floor(input.charsPerMinute || 100), 1, 1000)
  const charsPerTick = charsPerTickFromCfg(input)
  const rows = Math.max(1, Math.floor(input.rows ?? 1))
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
  return clamp(cpm, 1, 1000)
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
      linesPerTick: 1
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

  useEffect(() => {
    document.documentElement.classList.add('overlayAuxHost')
    document.body.classList.add('overlayAuxHost')
    return () => {
      document.documentElement.classList.remove('overlayAuxHost')
      document.body.classList.remove('overlayAuxHost')
    }
  }, [])

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

  return (
    <div
      style={
        {
        height: '100vh',
        padding: 12,
        boxSizing: 'border-box',
        background: 'transparent',
        // 让“空白背景”可拖拽移动窗口；内部滚动区/控件会覆盖为 no-drag
        WebkitAppRegion: 'drag'
        } as any
      }
    >
      <div
        style={
          {
          height: '100%',
          overflow: 'auto',
          border: '1px solid rgba(255,255,255,0.28)',
          background: 'rgba(28,28,28,0.98)',
          borderRadius: 12,
          padding: 14,
          color: '#fff',
          WebkitAppRegion: 'no-drag'
          } as any
        }
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            marginBottom: 12,
            paddingBottom: 10,
            borderBottom: '1px solid rgba(255,255,255,0.12)',
            WebkitAppRegion: 'drag'
          } as any}
        >
          <div style={{ fontSize: 13, fontWeight: 600, opacity: 0.95 }}>阅读框设置</div>
          <button
            className="btn"
            style={{ background: 'rgba(255,255,255,0.12)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', WebkitAppRegion: 'no-drag' } as any}
            onClick={() => void window.api?.overlaySettingsHide?.()}
            title="关闭"
          >
            关闭
          </button>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>外观</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12 }}>文字</span>
              <input type="color" value={cfg.textColor} onChange={(e) => applyCfg({ ...cfg, textColor: e.target.value })} />
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12 }}>文字透明</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={cfg.textOpacity}
                onChange={(e) => applyCfg({ ...cfg, textOpacity: Number(e.target.value) })}
              />
              <span style={{ width: 36, textAlign: 'right', fontSize: 12 }}>{cfg.textOpacity.toFixed(2)}</span>
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12 }}>背景</span>
              <input type="color" value={cfg.bgColor} onChange={(e) => applyCfg({ ...cfg, bgColor: e.target.value })} />
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12 }}>透明</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={cfg.bgOpacity}
                onChange={(e) => applyCfg({ ...cfg, bgOpacity: Number(e.target.value) })}
              />
              <span style={{ width: 36, textAlign: 'right', fontSize: 12 }}>{cfg.bgOpacity.toFixed(2)}</span>
            </label>
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>尺寸与排版</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12 }}>阅读</span>
              <select
                value={(cfg.readMode ?? 'scroll') as any}
                onChange={(e) => applyCfg({ ...cfg, readMode: (e.target.value === 'page' ? 'page' : 'scroll') as any })}
                style={{ height: 30 }}
              >
                <option value="scroll">滚动（按行推进）</option>
                <option value="page">翻页（一页一翻）</option>
              </select>
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12 }}>行</span>
              <input
                type="number"
                value={cfg.rows}
                onChange={(e) => applyCfg({ ...cfg, rows: Number(e.target.value) })}
                style={{ width: 48 }}
              />
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12 }}>列</span>
              <input
                type="number"
                value={cfg.cols}
                onChange={(e) => applyCfg({ ...cfg, cols: Number(e.target.value) })}
                style={{ width: 56 }}
              />
            </label>
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
                  // 调字号时不改阅读框像素尺寸；只按当前阅读框 bounds 自动换算行/列，从而影响可显示文字数量
                  void (async () => {
                    const b = (await window.api?.overlayGetBounds?.()) as any
                    if (b && typeof b.width === 'number' && typeof b.height === 'number') {
                      const derived = deriveRowsColsFromBounds({ width: b.width, height: b.height, fontSize })
                      next = { ...next, rows: derived.rows, cols: derived.cols }
                    }
                    applyCfg(next)
                  })()
                }}
                style={{ width: 56 }}
              />
            </label>
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 8 }}>
            提示：拖拽阅读条缩放会自动换算行/列，这里也可手动微调。
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>速度</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, minWidth: 64 }}>字/分钟</span>
              <input
                type="range"
                min={1}
                max={1000}
                  step={1}
                value={cfg.charsPerMinute}
                onChange={(e) => applyCfg({ ...cfg, autoSpeed: true, charsPerMinute: Number(e.target.value) })}
              />
              <span style={{ width: 56, textAlign: 'right', fontSize: 12 }}>{cfg.charsPerMinute}</span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, minWidth: 64 }}>每次前进</span>
              {(cfg.readMode ?? 'scroll') === 'page' ? (
                <>
                  <input type="number" step={1} value={cfg.rows} onChange={(e) => applyCfg({ ...cfg, rows: Number(e.target.value) })} style={{ width: 72 }} />
                  <span style={{ width: 56, textAlign: 'right', fontSize: 12 }}>{cfg.rows} 行/页</span>
                </>
              ) : (
                <>
                  <input type="range" min={1} max={10} step={1} value={cfg.linesPerTick} onChange={(e) => applyCfg({ ...cfg, linesPerTick: Number(e.target.value) })} />
                  <span style={{ width: 56, textAlign: 'right', fontSize: 12 }}>{cfg.linesPerTick} 行</span>
                </>
              )}
            </label>
            <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={cfg.autoSpeed} onChange={(e) => applyCfg({ ...cfg, autoSpeed: e.target.checked })} />
              <span style={{ fontSize: 12 }}>自动换算</span>
            </label>
            {!cfg.autoSpeed ? (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, minWidth: 64 }}>ms/tick</span>
                <input type="range" min={80} max={30000} step={10} value={cfg.speedMs} onChange={(e) => applyCfg({ ...cfg, speedMs: Number(e.target.value) })} />
                <span style={{ fontSize: 12 }}>
                  {cfg.speedMs} ≈ {cpmHint} 字/分
                </span>
              </label>
            ) : null}
          </div>
        </div>

        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>工具栏图标</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <button
              className="btn"
              style={{ background: 'rgba(255,255,255,0.12)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', WebkitAppRegion: 'no-drag' } as any}
              onClick={() => setToolbar(ALL_TOOLBAR_KEYS.map((x) => x.key))}
              title="全选"
            >
              全选
            </button>
            <button
              className="btn"
              style={{ background: 'rgba(255,255,255,0.12)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', WebkitAppRegion: 'no-drag' } as any}
              onClick={() => setToolbar([])}
              title="全不选"
            >
              全不选
            </button>
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {ALL_TOOLBAR_KEYS.map((it) => {
              const checked = toolbarKeys.includes(it.key)
              return (
                <label key={it.key} style={{ display: 'flex', gap: 8, alignItems: 'center', WebkitAppRegion: 'no-drag' } as any}>
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
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 8 }}>提示：默认全选；取消后工具栏会立刻隐藏对应按钮。</div>
        </div>
      </div>
    </div>
  )
}

