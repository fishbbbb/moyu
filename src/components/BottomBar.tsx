import React from 'react'

export function BottomBar(props: {
  playing: boolean
  hasSession: boolean
  activeBookId: string | null
  pageStep: number
  settingsOpen: boolean
  onTogglePlay: () => void
  onPrevPage: () => void
  onNextPage: () => void
  onToggleSettings: () => void
}) {
  const canPrevNext = props.hasSession
  const label = props.playing ? '暂停阅读条' : props.hasSession ? '继续阅读条' : '启动阅读条'
  return (
    <div className="uiBottomBar" role="region" aria-label="全局控制条">
      <div className="uiBottomBarLeft">
        <button className="uiBtn uiBtnPrimary uiBtnLg" onClick={props.onTogglePlay} disabled={!(props.activeBookId || props.hasSession)}>
          {label}
        </button>
      </div>
      <div className="uiBottomBarMid">
        <button className="uiBtn uiBtnSecondary uiBtnIcon" onClick={props.onPrevPage} disabled={!canPrevNext} title="上一页">
          ←
        </button>
        <button className="uiBtn uiBtnSecondary uiBtnIcon" onClick={props.onNextPage} disabled={!canPrevNext} title="下一页">
          →
        </button>
      </div>
      <div className="uiBottomBarRight">
        <button
          className={`uiBtn uiBtnSecondary uiBtnLg ${props.settingsOpen ? 'uiBtnSecondaryActive' : ''}`}
          onClick={props.onToggleSettings}
          title="展开阅读设置"
        >
          设置
        </button>
      </div>
    </div>
  )
}

