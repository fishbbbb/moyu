import React from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { MainView } from './views/MainView'
import { OverlayView } from './views/OverlayView'
import { OverlayToolbarView } from './views/OverlayToolbarView'
import { OverlaySettingsView } from './views/OverlaySettingsView'

export function App() {
  return (
    <Routes>
      <Route path="/" element={<MainView />} />
      <Route path="/overlay" element={<OverlayView />} />
      <Route path="/overlay-toolbar" element={<OverlayToolbarView />} />
      <Route path="/overlay-settings" element={<OverlaySettingsView />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

