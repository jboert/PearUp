import { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, nativeTheme, dialog } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { DaemonCore } from './lib/daemon.js'
import { readConfig, writeConfig, ensureDir, isDaemonRunning } from './lib/config.js'
import { generateRoom, validateRoom } from './lib/topic.js'
import { enableAutostart, disableAutostart, isAutostartEnabled } from './lib/autostart.js'

import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const _debugLog = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.pearup', 'debug.log')
function _dbg (msg) { try { fs.appendFileSync(_debugLog, new Date().toISOString() + ' ' + msg + '\n') } catch {} }
process.on('uncaughtException', (err) => { _dbg('UNCAUGHT: ' + err.stack); app.quit() })
process.on('unhandledRejection', (err) => { _dbg('UNHANDLED: ' + (err && err.stack || err)) })

let tray = null
let chatWindow = null
let daemon = null

function createTrayIcon (connected) {
  const size = 22
  const scale = 2
  const s = size * scale
  const buf = Buffer.alloc(s * s * 4)
  const cx = s / 2
  const cy = s / 2
  const r = s * 0.3

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = x - cx + 0.5
      const dy = y - cy + 0.5
      const dist = Math.sqrt(dx * dx + dy * dy)
      const idx = (y * s + x) * 4

      if (dist <= r) {
        const aa = Math.min(1, Math.max(0, r - dist + 1))
        const alpha = Math.round(aa * 255)
        if (connected) {
          // Green
          buf[idx] = 76
          buf[idx + 1] = 217
          buf[idx + 2] = 100
          buf[idx + 3] = alpha
        } else {
          // Gray
          buf[idx] = 128
          buf[idx + 1] = 128
          buf[idx + 2] = 128
          buf[idx + 3] = alpha
        }
      }
    }
  }

  const img = nativeImage.createFromBuffer(buf, { width: s, height: s, scaleFactor: scale })
  if (process.platform === 'darwin') img.setTemplateImage(false)
  return img
}

function updateTray () {
  if (!tray || !daemon) return

  const peerCount = daemon.peers.size
  const connected = peerCount > 0
  tray.setImage(createTrayIcon(connected))

  const peerItems = []
  for (const [, peer] of daemon.peers) {
    const ago = timeAgo(peer.connectedAt)
    peerItems.push({ label: `  ${peer.name} (${ago})`, enabled: false })
  }

  const autostart = isAutostartEnabled()

  const contextMenu = Menu.buildFromTemplate([
    { label: 'PearUp', enabled: false },
    { type: 'separator' },
    {
      label: connected ? `${peerCount} peer${peerCount > 1 ? 's' : ''} connected` : 'No peers connected',
      enabled: false
    },
    ...peerItems,
    { type: 'separator' },
    {
      label: 'View History',
      click: () => openChatWindow()
    },
    { type: 'separator' },
    {
      label: 'Start on Login',
      type: 'checkbox',
      checked: autostart,
      click: (item) => {
        if (item.checked) enableAutostart('tray')
        else disableAutostart()
      }
    },
    { type: 'separator' },
    {
      label: 'Quit PearUp',
      click: async () => {
        await daemon.stop()
        app.quit()
      }
    }
  ])
  tray.setContextMenu(contextMenu)
  tray.setToolTip(connected ? `PearUp — ${peerCount} peer${peerCount > 1 ? 's' : ''}` : 'PearUp — no peers')
}

function timeAgo (ts) {
  const diff = Date.now() - ts
  if (diff < 60000) return Math.floor(diff / 1000) + 's ago'
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago'
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago'
  return Math.floor(diff / 86400000) + 'd ago'
}

function openChatWindow () {
  if (chatWindow) {
    chatWindow.focus()
    return
  }

  chatWindow = new BrowserWindow({
    width: 600,
    height: 700,
    title: 'PearUp — Chat History',
    backgroundColor: '#0f0f1a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  chatWindow.loadFile(path.join(__dirname, 'ui', 'index.html'))

  chatWindow.on('closed', () => {
    chatWindow = null
  })
}

// IPC handlers for chat window
ipcMain.handle('get-history', async (event, room) => {
  if (!daemon) return { messages: [], peers: [], name: '', displayName: '', rooms: [], currentRoom: 'default' }
  const roomId = room || daemon.config.defaultRoom || 'default'
  const store = daemon._storeForRoom(roomId)
  const messages = store ? await store.getRecent(200) : []
  const peers = []
  for (const [key, peer] of daemon.peers) {
    peers.push({ name: peer.name, displayName: peer.displayName, publicKey: key, connectedAt: peer.connectedAt })
  }
  const rooms = [...daemon.rooms.keys()].map(id => {
    const r = daemon.rooms.get(id)
    return { id, name: r.config.name }
  })
  return { messages, peers, name: daemon.config.name, displayName: daemon.config.displayName, rooms, currentRoom: roomId }
})

ipcMain.handle('get-rooms', async () => {
  if (!daemon) return { rooms: [], defaultRoom: 'default' }
  const rooms = [...daemon.rooms.keys()].map(id => {
    const r = daemon.rooms.get(id)
    return { id, name: r.config.name }
  })
  return { rooms, defaultRoom: daemon.config.defaultRoom || 'default' }
})

ipcMain.handle('send-message', async (event, body, to, room) => {
  if (!daemon) return { ok: false, error: 'daemon not running' }
  const msg = await daemon.sendMessage(body, to || '*', null, 'ui', room || null)
  return { ok: true, id: msg.id }
})

ipcMain.handle('get-status', async () => {
  if (!daemon) return { peers: 0, name: '' }
  return { peers: daemon.peers.size, name: daemon.config.name }
})

ipcMain.handle('clear-history', async (event, room) => {
  if (!daemon) return { ok: false }
  const store = daemon._storeForRoom(room)
  if (store) await store.clearAll()
  daemon.seen.clear()
  return { ok: true }
})

async function showSetupDialog () {
  // Step 1: Ask for machine name
  const setupWin = new BrowserWindow({
    width: 480,
    height: 400,
    resizable: false,
    title: 'PearUp Setup',
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload-setup.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  setupWin.loadFile(path.join(__dirname, 'ui', 'setup.html'))

  return new Promise((resolve) => {
    ipcMain.once('setup-complete', (event, data) => {
      let mnemonic
      if (data.room && data.room.trim()) {
        mnemonic = data.room.trim()
        if (!validateRoom(mnemonic)) {
          dialog.showErrorBox('Invalid Room Phrase', 'The 12-word phrase is not valid. Please check and try again.')
          app.quit()
          return
        }
      } else {
        mnemonic = generateRoom()
      }

      ensureDir()
      writeConfig({
        name: data.name.trim(),
        mnemonic,
        createdAt: Date.now()
      })

      setupWin.close()
      resolve({ name: data.name.trim(), mnemonic, isNew: !data.room })
    })

    setupWin.on('closed', () => {
      if (!readConfig()) app.quit()
    })
  })
}

async function startApp () {
  _dbg('startApp called')
  let config = readConfig()
  _dbg('config: ' + (config ? 'found' : 'null'))
  if (!config) {
    const result = await showSetupDialog()
    if (!result) return

    // Show the mnemonic to the user if they created a new room
    if (result.isNew) {
      dialog.showMessageBoxSync({
        type: 'info',
        title: 'Room Created',
        message: 'Share this phrase with your other machines:',
        detail: result.mnemonic + '\n\nOn other machines, paste this phrase in the "Room Phrase" field during setup.'
      })
    }

    config = readConfig()
  }

  // Check if headless daemon is already running
  if (isDaemonRunning()) {
    dialog.showErrorBox('Already Running', 'PearUp daemon is already running. Stop it first: pearup daemon stop')
    app.quit()
    return
  }

  daemon = new DaemonCore()

  daemon.on('peer-joined', (info) => {
    updateTray()
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('peer-joined', info)
    }
  })
  daemon.on('peer-left', (info) => {
    updateTray()
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('peer-left', info)
    }
  })
  daemon.on('message', (msg) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('new-message', msg)
    }
    updateTray()
  })

  daemon.on('ack', (ack) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('message-ack', ack)
    }
  })

  // Create tray icon immediately so user sees it while daemon connects
  try {
    const icon = createTrayIcon(false)
    _dbg('icon created: ' + JSON.stringify(icon.getSize()))
    tray = new Tray(icon)
    _dbg('tray created OK')
  } catch (err) {
    _dbg('tray creation FAILED: ' + err.stack)
  }
  updateTray()

  // Refresh tray every 30 seconds for time-ago updates
  setInterval(() => updateTray(), 30000)

  try {
    _dbg('starting daemon...')
    await daemon.start()
    _dbg('daemon started OK')
    updateTray()
  } catch (err) {
    _dbg('daemon start FAILED: ' + err.stack)
    app.quit()
    return
  }
}

app.whenReady().then(startApp)

app.on('window-all-closed', (e) => {
  // Don't quit when chat window closes — tray keeps running
  e.preventDefault?.()
})

app.on('before-quit', async () => {
  if (daemon) await daemon.stop()
})

// Hide dock icon on macOS (tray-only app)
if (process.platform === 'darwin') {
  app.dock?.hide()
}
