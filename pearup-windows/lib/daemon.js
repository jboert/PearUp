import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { readConfig, writePid, removePid, storePathForRoom } from './config.js'
import { MessageStore } from './store.js'
import { setupProtocol } from './protocol.js'
import { deriveTopicFromMnemonic } from './topic.js'
import { IPCServer } from './ipc-server.js'
import { EventEmitter } from 'events'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { log } from './logger.js'

export class DaemonCore extends EventEmitter {
  constructor () {
    super()
    this.config = null
    this.rooms = new Map() // roomId -> { topic, discovery, store }
    this.swarm = null
    this.peers = new Map() // publicKey hex -> { name, displayName, protocol, connectedAt, lastPong, rooms }
    this.seen = new Map() // msgId -> Set of peer names that have seen it
    this.pendingQueue = new Map() // peerName -> [messages]
    this.ipc = null
    this.running = false
    this._syncInterval = null
    this._discoveryInterval = null
    this._pingInterval = null
    this._networkWatchInterval = null
    this._lastClaudeResume = 0
    this._claudeResumeMinInterval = 30000 // 30s minimum between resumes
    this._lastPeerCount = 0
    this._noPeersSince = 0
    this._reconnecting = false
  }

  // Get store for a room (defaults to defaultRoom)
  _storeForRoom (roomId) {
    const rid = roomId || this.config.defaultRoom || 'default'
    const room = this.rooms.get(rid)
    return room ? room.store : this.rooms.get(this.config.defaultRoom || 'default')?.store
  }

  async start () {
    this.config = readConfig()
    if (!this.config) throw new Error('Not initialized. Run: pearup init --name <name>')

    // Initialize stores for each room
    const rooms = this.config.rooms || [{ id: 'default', name: 'default', mnemonic: this.config.mnemonic }]
    for (const roomConfig of rooms) {
      const storagePath = storePathForRoom(roomConfig.id)
      const store = new MessageStore(storagePath)
      await store.ready()
      const topic = deriveTopicFromMnemonic(roomConfig.mnemonic)
      this.rooms.set(roomConfig.id, { topic, discovery: null, store, config: roomConfig })
    }

    // Start IPC first so CLI can connect immediately
    this.ipc = new IPCServer((req) => this._handleIPC(req))
    await this.ipc.start()
    writePid()
    this.running = true
    log('info', 'Daemon started, pid:', process.pid, 'name:', this.config.name, 'rooms:', rooms.map(r => r.id).join(','))
    this.emit('started')

    // Then start swarm (discovery flush can take several seconds)
    this.swarm = new Hyperswarm()
    this.swarm.on('connection', (socket, peerInfo) => this._onConnection(socket, peerInfo))

    // Join all room topics
    for (const [roomId, room] of this.rooms) {
      room.discovery = this.swarm.join(room.topic, { server: true, client: true })
      await room.discovery.flushed()
      log('info', 'Joined room:', roomId)
    }

    this._startSyncInterval()
    this._startDiscoveryRefresh()
    this._startPingInterval()
    this._startNetworkWatch()
  }

  async stop () {
    this.running = false
    log('info', 'Daemon stopping')
    if (this._syncInterval) { clearInterval(this._syncInterval); this._syncInterval = null }
    if (this._discoveryInterval) { clearInterval(this._discoveryInterval); this._discoveryInterval = null }
    if (this._pingInterval) { clearInterval(this._pingInterval); this._pingInterval = null }
    if (this._networkWatchInterval) { clearInterval(this._networkWatchInterval); this._networkWatchInterval = null }
    if (this.ipc) await this.ipc.stop()
    if (this.swarm) await this.swarm.destroy()
    for (const [, room] of this.rooms) {
      if (room.store) await room.store.close()
    }
    removePid()
    log('info', 'Daemon stopped')
    this.emit('stopped')
  }

  _startSyncInterval () {
    // Every 60s, re-exchange message IDs with each peer to catch missed messages
    this._syncInterval = setInterval(async () => {
      if (this.peers.size === 0) return
      try {
        // Sync each room separately
        for (const [roomId, room] of this.rooms) {
          const recent = await room.store.getRecent(100)
          const ids = recent.map(m => m.id)
          for (const [, peer] of this.peers) {
            peer.protocol.sendSync({ type: 'have', ids, room: roomId })
          }
        }
        log('info', 'Sync interval: exchanged IDs with', this.peers.size, 'peers')

        // Also flush pending queues during sync
        this._flushAllPending()
      } catch (err) {
        log('error', 'Sync interval error:', err.message)
      }
    }, 60000)
  }

  _startDiscoveryRefresh () {
    // Every 2 minutes, refresh discovery to re-announce and help NAT traversal
    this._discoveryInterval = setInterval(() => {
      this._refreshDiscovery()
    }, 120000)
  }

  _refreshDiscovery () {
    for (const [roomId, room] of this.rooms) {
      if (!room.discovery) continue
      try {
        room.discovery.refresh()
      } catch (err) {
        log('error', 'Discovery refresh error for room', roomId, ':', err.message)
      }
    }
    log('info', 'Discovery refreshed for', this.rooms.size, 'rooms')
  }

  _startNetworkWatch () {
    // Every 15s check if we've lost all peers and aggressively try to reconnect
    this._networkWatchInterval = setInterval(async () => {
      if (!this.running || this._reconnecting) return

      const currentPeerCount = this.peers.size

      // Track when we lost all peers
      if (currentPeerCount === 0 && this._lastPeerCount > 0) {
        this._noPeersSince = Date.now()
        log('warn', 'All peers lost, will attempt recovery')
      }

      // If we had peers but now have none, aggressively refresh
      if (currentPeerCount === 0 && this._noPeersSince > 0) {
        const elapsed = Date.now() - this._noPeersSince
        // Refresh every 15s for the first 2 minutes, then every 30s
        const shouldRefresh = elapsed < 120000 || (elapsed % 30000 < 15000)
        if (shouldRefresh) {
          log('info', 'No peers for', Math.round(elapsed / 1000) + 's, refreshing discovery')
          this._refreshDiscovery()
        }

        // After 5 minutes with no peers, do a full swarm rejoin
        if (elapsed > 300000 && !this._reconnecting) {
          log('warn', 'No peers for 5 minutes, rebuilding swarm connection')
          await this._rejoinSwarm()
        }
      }

      if (currentPeerCount > 0) {
        this._noPeersSince = 0
      }

      this._lastPeerCount = currentPeerCount
    }, 15000)
  }

  async _rejoinSwarm () {
    if (this._reconnecting) return
    this._reconnecting = true
    try {
      // Leave and rejoin all room topics
      for (const [roomId, room] of this.rooms) {
        if (room.discovery) {
          try { await room.discovery.destroy() } catch {}
        }
        room.discovery = this.swarm.join(room.topic, { server: true, client: true })
        await room.discovery.flushed()
      }
      log('info', 'Swarm rejoined successfully for all rooms')
    } catch (err) {
      log('error', 'Swarm rejoin failed:', err.message)
      try {
        await this._rebuildSwarm()
      } catch (err2) {
        log('error', 'Swarm rebuild failed:', err2.message)
      }
    } finally {
      this._reconnecting = false
    }
  }

  async _rebuildSwarm () {
    log('warn', 'Rebuilding entire swarm')
    try {
      if (this.swarm) await this.swarm.destroy()
    } catch {}

    this.peers.clear()
    this.swarm = new Hyperswarm()
    this.swarm.on('connection', (socket, peerInfo) => this._onConnection(socket, peerInfo))

    for (const [roomId, room] of this.rooms) {
      room.discovery = this.swarm.join(room.topic, { server: true, client: true })
      await room.discovery.flushed()
    }
    log('info', 'Swarm rebuilt successfully for all rooms')
  }

  _startPingInterval () {
    // Every 15s, send ping to each peer to keep NAT mappings alive.
    // Require 3 consecutive misses (45s) before declaring dead.
    this._pingInterval = setInterval(() => {
      const now = Date.now()
      for (const [pubKeyHex, peer] of this.peers) {
        // Check if peer missed pings — need 2 consecutive misses (60s total) before cleanup
        if (peer._pingSent && peer.lastPong < peer._pingSent) {
          peer._missedPings = (peer._missedPings || 0) + 1
          if (peer._missedPings >= 3) {
            log('warn', 'Peer', peer.name, 'missed', peer._missedPings, 'pings, cleaning up')
            try { peer.protocol.close() } catch {}
            this.peers.delete(pubKeyHex)
            this.emit('peer-left', { name: peer.name, publicKey: pubKeyHex })
            continue
          }
          log('info', 'Peer', peer.name, 'missed ping', peer._missedPings + '/3')
        } else {
          peer._missedPings = 0
        }
        try {
          peer.protocol.sendPing()
          peer._pingSent = now
        } catch (err) {
          log('error', 'Ping failed for', peer.name, ':', err.message)
        }
      }
    }, 15000)
  }

  _flushPending (peerName) {
    const queued = this.pendingQueue.get(peerName)
    if (!queued || queued.length === 0) return
    // Find peer by name
    for (const [, peer] of this.peers) {
      if (peer.name === peerName) {
        for (const msg of queued) {
          try { peer.protocol.send(msg) } catch {}
        }
        log('info', 'Flushed', queued.length, 'queued messages to', peerName)
        break
      }
    }
    this.pendingQueue.delete(peerName)
  }

  _flushAllPending () {
    for (const peerName of this.pendingQueue.keys()) {
      this._flushPending(peerName)
    }
  }

  _onConnection (socket, peerInfo) {
    const pubKeyHex = b4a.toString(peerInfo.publicKey, 'hex')

    // Handle socket-level errors so they don't crash the daemon
    socket.on('error', (err) => {
      log('warn', 'Socket error for', pubKeyHex.slice(0, 8) + ':', err.message)
      const peer = this.peers.get(pubKeyHex)
      if (peer) {
        this.peers.delete(pubKeyHex)
        this.emit('peer-left', { name: peer.name, publicKey: pubKeyHex })
      }
    })

    const proto = setupProtocol(socket, {
      name: this.config.name,
      displayName: this.config.displayName,
      rooms: [...this.rooms.keys()],
      onidentity: async (handshake) => {
        const peerName = handshake?.name || pubKeyHex.slice(0, 8)
        const peerDisplayName = handshake?.displayName || null
        const peerRooms = handshake?.rooms || ['default']
        this.peers.set(pubKeyHex, {
          name: peerName,
          displayName: peerDisplayName,
          rooms: peerRooms,
          protocol: proto,
          connectedAt: Date.now(),
          lastPong: Date.now(),
          _pingSent: 0,
          _missedPings: 0
        })
        log('info', 'Peer connected:', peerName, 'rooms:', peerRooms.join(','))
        this.emit('peer-joined', { name: peerName, publicKey: pubKeyHex })

        // Send immediate keepalive ping to hold NAT mapping open
        try { proto.sendPing() } catch {}

        // Schedule rapid keepalive pings for the first 2 minutes (every 10s)
        let earlyPings = 0
        const earlyPingInterval = setInterval(() => {
          const peer = this.peers.get(pubKeyHex)
          if (!peer || ++earlyPings >= 12) {
            clearInterval(earlyPingInterval)
            return
          }
          try { peer.protocol.sendPing() } catch {}
        }, 10000)

        // Flush any queued messages for this peer
        this._flushPending(peerName)

        // Send our recent message IDs per room so the peer can fill in gaps
        for (const [roomId, room] of this.rooms) {
          const recent = await room.store.getRecent(100)
          const ids = recent.map(m => m.id)
          proto.sendSync({ type: 'have', ids, room: roomId })
        }
      },
      onmessage: async (msg) => {
        // Route to correct room store (default to 'default' for backwards compat)
        const roomId = msg.room || 'default'
        const store = this._storeForRoom(roomId)
        if (!store) {
          log('warn', 'Received message for unknown room:', roomId)
          proto.sendAck(msg.id, this.config.name)
          return
        }

        // Dedup guard
        const existing = await store.getRecent(200)
        const existingIds = new Set(existing.map(m => m.id))
        if (existingIds.has(msg.id)) {
          log('info', 'Dedup: skipping already-stored message', msg.id)
          proto.sendAck(msg.id, this.config.name)
          return
        }

        // Store ALL messages (so viewer shows full conversation)
        msg.via = msg.via || 'peer'
        await store.put(msg)
        log('info', 'Message received in room', roomId, 'from', msg.from, ':', msg.body.slice(0, 50))
        this.emit('message', msg)
        proto.sendAck(msg.id, this.config.name)

        // Only notify Claude if the message is addressed to us or broadcast
        if (msg.to === '*' || msg.to === this.config.name) {
          this._notifyClaude(msg)
        }
      },
      onack: (ackData) => {
        // Track who has seen this message
        if (!this.seen.has(ackData.id)) {
          this.seen.set(ackData.id, new Set())
        }
        this.seen.get(ackData.id).add(ackData.seenBy)
        this.emit('ack', ackData)
      },
      onsync: async (data) => {
        if (data.type === 'have') {
          // Peer told us which messages they have — send them ones they're missing
          const roomId = data.room || 'default'
          const store = this._storeForRoom(roomId)
          if (!store) return
          const peerIds = new Set(data.ids)
          const recent = await store.getRecent(100)
          for (const msg of recent) {
            if (!peerIds.has(msg.id)) {
              proto.send(msg)
            }
          }
          log('info', 'Sync: processed have list from peer for room', roomId)
        }
      },
      onping: (data) => {
        if (data.type === 'ping') {
          log('info', 'Ping received from peer, sending pong')
          proto.sendPong(data.ts)
        } else if (data.type === 'pong') {
          log('info', 'Pong received from peer')
          const peer = this.peers.get(pubKeyHex)
          if (peer) {
            peer.lastPong = Date.now()
            peer._missedPings = 0
          }
        }
      },
      onclose: () => {
        const peer = this.peers.get(pubKeyHex)
        this.peers.delete(pubKeyHex)
        if (peer) {
          log('info', 'Peer disconnected:', peer.name)
          this.emit('peer-left', { name: peer.name, publicKey: pubKeyHex })
        }
      }
    })
  }

  _notifyClaude (msg) {
    // Rate limit: don't spam Claude sessions
    const now = Date.now()
    if (now - this._lastClaudeResume < this._claudeResumeMinInterval) {
      log('info', 'Claude resume throttled (too recent)')
      return
    }

    // Re-read config each time so enable/disable takes effect without restart
    let fresh
    try {
      fresh = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pearup', 'config.json'), 'utf-8'))
      if (!fresh.claudeNotify) return
    } catch {
      return
    }

    this._lastClaudeResume = now

    const sessionFile = path.join(os.homedir(), '.pearup', 'claude-session')
    let sessionArg = '--continue' // default: continue most recent session

    try {
      const sid = fs.readFileSync(sessionFile, 'utf-8').trim()
      if (sid) sessionArg = '--resume ' + sid
    } catch {}

    const toContext = msg.to === '*' ? ' (broadcast)' : ` (directed to ${msg.to})`
    const roomContext = msg.room && msg.room !== 'default' ? ` [room: ${msg.room}]` : ''
    const prompt = `[PearUp]${roomContext} Message from ${msg.from}${toContext}: ${msg.body}

You have received a PearUp message. Read it and respond appropriately. To reply, use:
  node ${path.join(os.homedir(), process.platform === 'win32' ? 'PearUp' : 'pearup', 'cli.js')} send --to ${msg.from} "your reply"

If the message is part of an ongoing conversation, continue it naturally. If it requires action, take it.`

    // Find claude executable — tray app doesn't inherit shell PATH
    let claude = null
    const searchPaths = process.platform === 'win32'
      ? [
          path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
          path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
          path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
          'C:\\Program Files\\nodejs\\claude.cmd',
        ]
      : [
          path.join(os.homedir(), '.local', 'bin', 'claude'),
          '/usr/local/bin/claude',
          '/opt/homebrew/bin/claude',
          path.join(os.homedir(), '.nvm', 'versions', 'node', process.version, 'bin', 'claude'),
        ]
    for (const p of searchPaths) {
      try { if (fs.statSync(p).isFile()) { claude = p; break } } catch {}
    }
    if (!claude) {
      log('error', 'Claude executable not found in any search path')
      return
    }

    const args = ['-p', prompt]
    if (sessionArg.startsWith('--resume')) {
      args.push('--resume', sessionArg.split(' ')[1])
    } else {
      args.push('--continue')
    }

    // Allow skipping permissions for the spawned Claude process
    if (fresh.claudeNotifyDangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions')
    }

    log('info', 'Resuming Claude session with PearUp message from', msg.from)

    execFile(claude, args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        log('error', 'Claude resume failed:', err.message)
        return
      }
      if (stdout.trim()) {
        log('info', 'Claude responded:', stdout.trim().slice(0, 200))
      }
    })
  }

  getSeenBy (msgId) {
    const s = this.seen.get(msgId)
    return s ? [...s] : []
  }

  async sendMessage (body, to = '*', replyTo = null, via = 'cli', room = null) {
    const roomId = room || this.config.defaultRoom || 'default'
    const store = this._storeForRoom(roomId)
    if (!store) throw new Error('Unknown room: ' + roomId)

    const msg = {
      id: b4a.toString(crypto.randomBytes(8), 'hex'),
      from: this.config.name,
      to,
      ts: Date.now(),
      body,
      re: replyTo,
      via, // 'cli' = Claude/terminal, 'ui' = chat window, 'peer' = remote
      room: roomId
    }
    // Attach human's display name when message is from UI
    if (via === 'ui' && this.config.displayName) {
      msg.displayName = this.config.displayName
    }

    // Store our own message
    await store.put(msg)

    // Send to peers, count how many we reached
    let peersReached = 0
    let targetPeerConnected = false

    for (const [, peer] of this.peers) {
      if (to === '*' || to === peer.name) {
        peer.protocol.send(msg)
        peersReached++
        targetPeerConnected = true
      }
    }

    // If target peer is not connected and message is directed, queue it
    if (to !== '*' && !targetPeerConnected) {
      if (!this.pendingQueue.has(to)) {
        this.pendingQueue.set(to, [])
      }
      this.pendingQueue.get(to).push(msg)
      log('info', 'Message queued for offline peer:', to)
    }

    log('info', 'Message sent:', msg.id, 'to:', to, 'peersReached:', peersReached)
    this.emit('message', msg)
    return { ...msg, peersReached }
  }

  async _handleIPC (req) {
    switch (req.cmd) {
      case 'send': {
        const result = await this.sendMessage(req.body, req.to || '*', req.replyTo || null, req.via || 'cli', req.room || null)
        return { ok: true, id: result.id, peersReached: result.peersReached }
      }

      case 'read': {
        const store = this._storeForRoom(req.room)
        if (!store) return { ok: false, error: 'unknown room' }
        let messages
        if (req.unread) {
          messages = await store.getUnread()
        } else if (req.from) {
          messages = await store.getFrom(req.from, req.last || 10)
        } else {
          messages = await store.getRecent(req.last || 50)
        }
        if (req.markRead) {
          await store.markAllRead()
        }
        messages = messages.map(m => ({
          ...m,
          seenBy: this.getSeenBy(m.id)
        }))
        return { ok: true, messages }
      }

      case 'status': {
        const peers = []
        for (const [key, peer] of this.peers) {
          peers.push({ name: peer.name, displayName: peer.displayName, publicKey: key, connectedAt: peer.connectedAt, rooms: peer.rooms })
        }
        const defaultStore = this._storeForRoom()
        const unread = defaultStore ? await defaultStore.getUnreadCount() : 0
        const total = defaultStore ? await defaultStore.getTotal() : 0
        const roomList = [...this.rooms.keys()].map(id => {
          const r = this.rooms.get(id)
          return { id, name: r.config.name }
        })
        return {
          ok: true,
          name: this.config.name,
          room: this.config.mnemonic,
          rooms: roomList,
          defaultRoom: this.config.defaultRoom || 'default',
          peers,
          unread,
          total
        }
      }

      case 'history': {
        const store = this._storeForRoom(req.room)
        if (!store) return { ok: false, error: 'unknown room' }
        let messages = await store.getRecent(req.limit || 200)
        messages = messages.map(m => ({
          ...m,
          seenBy: this.getSeenBy(m.id)
        }))
        const peers = []
        for (const [key, peer] of this.peers) {
          peers.push({ name: peer.name, displayName: peer.displayName, publicKey: key, connectedAt: peer.connectedAt })
        }
        return { ok: true, messages, peers, name: this.config.name, displayName: this.config.displayName, room: req.room || this.config.defaultRoom || 'default' }
      }

      case 'rooms': {
        const roomList = [...this.rooms.keys()].map(id => {
          const r = this.rooms.get(id)
          return { id, name: r.config.name }
        })
        return { ok: true, rooms: roomList, defaultRoom: this.config.defaultRoom || 'default' }
      }

      case 'clear': {
        const store = this._storeForRoom(req.room)
        if (store) await store.clearAll()
        this.seen.clear()
        return { ok: true }
      }

      case 'shutdown': {
        setTimeout(() => this.stop().then(() => process.exit(0)), 100)
        return { ok: true }
      }

      default:
        return { ok: false, error: 'unknown command: ' + req.cmd }
    }
  }
}
