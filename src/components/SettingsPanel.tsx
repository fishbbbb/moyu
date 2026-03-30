import React from 'react'

export function SettingsPanel(props: {
  open: boolean
  onToggleOpen: () => void
  cfg: {
    fontSize: number
    bgColor: string
    bgOpacity: number
    charsPerMinute: number
    rows: number
  }
  fontFamily: string
  onApplyCfg: (next: { fontSize: number; bgColor: string; bgOpacity: number; charsPerMinute: number; rows: number }) => void
  onApplyFontFamily: (fontFamily: string) => void
}) {
  const fontOptions: Array<{ value: string; label: string }> = [
    { value: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial', label: '系统无衬线' },
    { value: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif', label: '苹方/微软雅黑' },
    { value: '"STSong", "Songti SC", "SimSun", serif', label: '宋体风格' }
  ]

  return (
    <section className="uiPanel">
      <div className="uiPanelHead uiPanelHeadClickable" onClick={props.onToggleOpen} role="button" tabIndex={0}>
        <div className="uiPanelTitle">阅读条设置</div>
        <div className={`uiPanelChevron ${props.open ? 'uiPanelChevronOpen' : ''}`} aria-hidden="true">
          ▾
        </div>
      </div>

      <div className={`uiCollapse ${props.open ? 'uiCollapseOpen' : ''}`}>
        <div className="uiCollapseInner">
          <div className="uiPanelBody">
            <div className="uiSettingBlock">
              <div className="uiSettingLabel">字体</div>
              <div className="uiSettingControlRow">
                <label className="uiSettingControlLabel">
                  <span className="uiSettingControlText">字号 {props.cfg.fontSize}</span>
                  <input
                    className="uiRange"
                    type="range"
                    min={10}
                    max={64}
                    step={1}
                    value={props.cfg.fontSize}
                    onChange={(e) => props.onApplyCfg({ ...props.cfg, fontSize: Number(e.target.value) })}
                  />
                </label>
              </div>
              <div className="uiSelectRow">
                <span className="uiSettingControlText">字体选择</span>
                <select className="uiSelect" value={props.fontFamily} onChange={(e) => props.onApplyFontFamily(e.target.value)}>
                  {fontOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="uiSettingBlock">
              <div className="uiSettingLabel">背景</div>
              <div className="uiSettingControlRow">
                <label className="uiColorRow">
                  <span className="uiSettingControlText">颜色</span>
                  <input type="color" className="uiColor" value={props.cfg.bgColor} onChange={(e) => props.onApplyCfg({ ...props.cfg, bgColor: e.target.value })} />
                </label>
              </div>
              <div className="uiSettingControlRow">
                <label className="uiSettingControlLabel">
                  <span className="uiSettingControlText">
                    透明度 {props.cfg.bgOpacity.toFixed(2)}
                  </span>
                  <input
                    className="uiRange"
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={props.cfg.bgOpacity}
                    onChange={(e) => props.onApplyCfg({ ...props.cfg, bgOpacity: Number(e.target.value) })}
                  />
                </label>
              </div>
            </div>

            <div className="uiSettingBlock">
              <div className="uiSettingLabel">速度</div>
              <div className="uiSettingControlRow">
                <label className="uiSettingControlLabel">
                  <span className="uiSettingControlText">字/分钟 {props.cfg.charsPerMinute}</span>
                  <input
                    className="uiRange"
                    type="range"
                    min={1}
                    max={1000}
                    step={1}
                    value={props.cfg.charsPerMinute}
                    onChange={(e) => props.onApplyCfg({ ...props.cfg, charsPerMinute: Number(e.target.value) })}
                  />
                </label>
              </div>
              <div className="uiSettingControlRow">
                <label className="uiSettingControlLabel">
                  <span className="uiSettingControlText">翻页步长 {props.cfg.rows} 行</span>
                  <input
                    className="uiRange"
                    type="range"
                    min={1}
                    max={20}
                    step={1}
                    value={props.cfg.rows}
                    onChange={(e) => props.onApplyCfg({ ...props.cfg, rows: Number(e.target.value) })}
                  />
                </label>
              </div>
              <div className="uiHint">提示：翻页/暂停后手动操作会按“步长”推进。</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

