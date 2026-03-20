import fs from 'fs'
import path from 'path'
import os from 'os'

const LOG_PATH = path.join(os.homedir(), '.pearup', 'debug.log')
const MAX_SIZE = 1024 * 1024 // 1MB
const TRUNCATE_TO = 512 * 1024 // 500KB

function ensureLogDir () {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
}

function rotate () {
  try {
    const stat = fs.statSync(LOG_PATH)
    if (stat.size > MAX_SIZE) {
      const buf = fs.readFileSync(LOG_PATH)
      const keep = buf.slice(buf.length - TRUNCATE_TO)
      // Find first newline to avoid partial line
      const nl = keep.indexOf(10) // '\n'
      const clean = nl >= 0 ? keep.slice(nl + 1) : keep
      fs.writeFileSync(LOG_PATH, clean)
    }
  } catch {}
}

export function log (level, ...args) {
  try {
    ensureLogDir()
    rotate()
    const ts = new Date().toISOString()
    const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    const line = `[${ts}] [${level.toUpperCase()}] ${msg}\n`
    fs.appendFileSync(LOG_PATH, line)
  } catch {
    // Logging should never crash the app
  }
}
