#!/usr/bin/env node

import { DaemonCore } from './lib/daemon.js'
import { isDaemonRunning, removePid, removeSocket, PID_PATH } from './lib/config.js'
import { ipcRequest } from './lib/ipc-client.js'
import fs from 'fs'

// If another daemon is running, gracefully shut it down first
const existingPid = isDaemonRunning()
if (existingPid) {
  console.log('Existing daemon found (pid: ' + existingPid + '), shutting it down...')
  try {
    await ipcRequest({ cmd: 'shutdown' }, 3000)
    // Wait briefly for clean shutdown
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200))
      if (!isDaemonRunning()) break
    }
  } catch {
    // IPC failed — force kill
    try { process.kill(existingPid, 'SIGTERM') } catch {}
    await new Promise(r => setTimeout(r, 1000))
    try { process.kill(existingPid, 'SIGKILL') } catch {}
  }
  // Clean up stale files
  removePid()
  removeSocket()
}

// Also clean up stale PID file if process is dead
try {
  const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim())
  try { process.kill(pid, 0) } catch { removePid(); removeSocket() }
} catch {}

const daemon = new DaemonCore()

daemon.on('started', () => {
  console.log('PearUp daemon started (pid: ' + process.pid + ')')
})

daemon.on('peer-joined', ({ name }) => {
  console.log('Peer joined: ' + name)
})

daemon.on('peer-left', ({ name }) => {
  console.log('Peer left: ' + name)
})

daemon.on('message', (msg) => {
  if (msg.from !== daemon.config.name) {
    console.log(`[${msg.from}] ${msg.body}`)
  }
})

process.on('SIGINT', async () => {
  await daemon.stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await daemon.stop()
  process.exit(0)
})

try {
  await daemon.start()
} catch (err) {
  console.error('Failed to start daemon:', err.message)
  process.exit(1)
}
