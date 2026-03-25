import fs from 'node:fs'
import path from 'node:path'

const distDir = path.join(process.cwd(), 'dist-electron')
fs.mkdirSync(distDir, { recursive: true })

const pkgPath = path.join(distDir, 'package.json')
const pkg = { type: 'commonjs' }
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8')

