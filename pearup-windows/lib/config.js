import fs from 'fs'
import path from 'path'
import os from 'os'

const PEARUP_DIR = path.join(os.homedir(), '.pearup')
const CONFIG_PATH = path.join(PEARUP_DIR, 'config.json')
const STORE_PATH = path.join(PEARUP_DIR, 'store')
const SOCKET_PATH = process.platform === 'win32'
  ? '//./pipe/pearup-daemon'
  : path.join(PEARUP_DIR, 'daemon.sock')
const PID_PATH = path.join(PEARUP_DIR, 'daemon.pid')

export { PEARUP_DIR, CONFIG_PATH, STORE_PATH, SOCKET_PATH, PID_PATH }

export function ensureDir () {
  fs.mkdirSync(PEARUP_DIR, { recursive: true })
  fs.mkdirSync(STORE_PATH, { recursive: true })
}

export function migrateConfig (config) {
  if (!config) return config
  // Migrate single-room config to multi-room
  if (config.mnemonic && !config.rooms) {
    config.rooms = [
      { id: 'default', name: 'default', mnemonic: config.mnemonic }
    ]
    config.defaultRoom = 'default'
    // Keep mnemonic for backwards compat with old daemons
    writeConfig(config)
  }
  return config
}

export function readConfig () {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    return migrateConfig(config)
  } catch {
    return null
  }
}

export function storePathForRoom (roomId) {
  if (roomId === 'default') return STORE_PATH
  return path.join(PEARUP_DIR, `store-${roomId}`)
}

export function writeConfig (config) {
  ensureDir()
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}

export function isDaemonRunning () {
  try {
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim())
    process.kill(pid, 0) // signal 0 = check if alive
    return pid
  } catch {
    return false
  }
}

export function writePid () {
  ensureDir()
  fs.writeFileSync(PID_PATH, String(process.pid))
}

export function removePid () {
  try { fs.unlinkSync(PID_PATH) } catch {}
}

export function removeSocket () {
  if (process.platform === 'win32') return // named pipes don't leave files
  try { fs.unlinkSync(SOCKET_PATH) } catch {}
}
