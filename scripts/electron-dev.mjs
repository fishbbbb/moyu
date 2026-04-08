import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// A small wrapper to avoid relying on `cross-env` binary in node_modules/.bin.
const require = createRequire(import.meta.url)
const electronPath = require('electron')

// Keep the behavior equivalent to the previous `cross-env ELECTRON_RUN_AS_NODE= ELECTRON_DEV=1 electron .`
// 注意：Electron 只要检测到该环境变量“存在”，就会进入 run-as-node 模式（即便值为空字符串）。
// 这里必须彻底移除它，否则主进程里 `require('electron')` 会变成返回可执行文件路径而不是 Electron API。
delete process.env.ELECTRON_RUN_AS_NODE
process.env.ELECTRON_DEV = '1'

const args = process.argv.slice(2)
const child = spawn(electronPath, args, { stdio: 'inherit' })

child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error(err)
  process.exit(1)
})

