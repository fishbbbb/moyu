import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// A small wrapper to avoid relying on `cross-env` binary in node_modules/.bin.
const require = createRequire(import.meta.url)
const electronPath = require('electron')

// Keep the behavior equivalent to the previous `cross-env ELECTRON_RUN_AS_NODE= ELECTRON_DEV=1 electron .`
process.env.ELECTRON_RUN_AS_NODE = ''
process.env.ELECTRON_DEV = '1'

const args = process.argv.slice(2)
const child = spawn(electronPath, args, { stdio: 'inherit' })

child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error(err)
  process.exit(1)
})

