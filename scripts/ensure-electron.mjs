import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

function main() {
  const electronPkg = path.join(process.cwd(), 'node_modules', 'electron')
  const installJs = path.join(electronPkg, 'install.js')
  const distDir = path.join(electronPkg, 'dist')

  // Platform-specific binary location inside `node_modules/electron/dist/`
  // so we can detect incomplete installs.
  const electronBinary = (() => {
    if (process.platform === 'darwin') {
      return path.join(
        distDir,
        'Electron.app',
        'Contents',
        'MacOS',
        'Electron'
      )
    }
    if (process.platform === 'win32') {
      return path.join(distDir, 'electron.exe')
    }
    // Linux/others
    return path.join(distDir, 'electron')
  })()

  // If electron isn't installed yet, do nothing (npm will handle it).
  if (!exists(electronPkg) || !exists(installJs)) return

  // If the binary exists, assume OK.
  if (exists(electronBinary)) return

  // If the binary is missing, run electron's installer.
  // Prefer mirror via npm config or env.
  const mirror =
    process.env.ELECTRON_MIRROR ||
    process.env.npm_config_electron_mirror ||
    'https://npmmirror.com/mirrors/electron/'
  process.env.ELECTRON_MIRROR = mirror

  // eslint-disable-next-line no-console
  console.log(`[ensure-electron] electron dist missing, running install.js (mirror=${mirror})`)

  // electron/install.js is CommonJS; use createRequire under ESM.
  const require = createRequire(import.meta.url)
  require(installJs)
}

main()

