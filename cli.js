#!/usr/bin/env node

import { readConfig, writeConfig, isDaemonRunning, ensureDir, SOCKET_PATH, storePathForRoom } from './lib/config.js'
import { generateRoom, validateRoom, deriveTopicFromMnemonic } from './lib/topic.js'
import fs from 'fs'
import { ipcRequest } from './lib/ipc-client.js'
import { enableAutostart, disableAutostart, isAutostartEnabled } from './lib/autostart.js'
import { log } from './lib/logger.js'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const cmd = args[0]

function parseFlags (args) {
  const flags = {}
  const positional = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i]
      } else {
        flags[key] = true
      }
    } else {
      positional.push(args[i])
    }
  }
  return { flags, positional }
}

const { flags, positional } = parseFlags(args.slice(1))

async function ensureDaemon () {
  if (isDaemonRunning()) return true

  // Clean up stale PID/socket files from a crashed daemon
  const { removePid: rmPid, removeSocket: rmSock } = await import('./lib/config.js')
  rmPid()
  rmSock()

  // Auto-start daemon in background
  const child = spawn(process.execPath, [path.join(__dirname, 'daemon-entry.js')], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()

  // Wait for socket to appear (Hyperswarm discovery can take a few seconds)
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 300))
    try {
      await ipcRequest({ cmd: 'status' }, 2000)
      return true
    } catch {}
  }
  console.error('Failed to start daemon')
  return false
}

function requireDaemon () {
  if (!isDaemonRunning()) {
    console.error('Daemon not running. Start PearUp tray app or run: pearup daemon start')
    process.exit(1)
  }
}

function timeAgo (ts) {
  const diff = Date.now() - ts
  if (diff < 60000) return Math.floor(diff / 1000) + 's ago'
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago'
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago'
  return Math.floor(diff / 86400000) + 'd ago'
}

function formatTs (ts) {
  const d = new Date(ts)
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

async function main () {
  switch (cmd) {
    case 'init': {
      const name = flags.name
      if (!name) {
        console.error('Usage: pearup init --name <name> [--display-name <human>] [--room "<12 words>"]')
        process.exit(1)
      }

      let mnemonic
      if (flags.room) {
        mnemonic = flags.room
        if (!validateRoom(mnemonic)) {
          console.error('Invalid BIP39 mnemonic. Must be 12 valid words.')
          process.exit(1)
        }
      } else {
        mnemonic = generateRoom()
      }

      const config = {
        name,
        mnemonic,
        createdAt: Date.now()
      }
      if (flags['display-name']) {
        config.displayName = flags['display-name']
      }

      ensureDir()
      writeConfig(config)

      console.log(`PearUp initialized!`)
      console.log(`  Name: ${name}`)
      if (!flags.room) {
        console.log(`\nShare this phrase with your other machines:`)
        console.log(`  ${mnemonic}`)
        console.log(`\nOn other machines run:`)
        console.log(`  pearup init --name <name> --room "${mnemonic}"`)
      } else {
        console.log(`  Room: joined existing room`)
      }
      break
    }

    case 'daemon': {
      const sub = positional[0]
      if (sub === 'start') {
        if (isDaemonRunning()) {
          console.log('Daemon already running')
          return
        }
        const ok = await ensureDaemon()
        if (ok) console.log('Daemon started')
      } else if (sub === 'stop') {
        try {
          await ipcRequest({ cmd: 'shutdown' })
          console.log('Daemon stopped')
        } catch {
          // Try force kill via PID if IPC fails
          const pid = isDaemonRunning()
          if (pid) {
            try { process.kill(pid, 'SIGTERM') } catch {}
            console.log('Daemon killed (pid: ' + pid + ')')
          } else {
            console.log('Daemon not running')
          }
        }
      } else if (sub === 'restart') {
        // Stop existing daemon
        try {
          await ipcRequest({ cmd: 'shutdown' })
          // Wait for clean shutdown
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 200))
            if (!isDaemonRunning()) break
          }
        } catch {
          const pid = isDaemonRunning()
          if (pid) {
            try { process.kill(pid, 'SIGTERM') } catch {}
            await new Promise(r => setTimeout(r, 1000))
          }
        }
        // Clean up stale files
        const { removePid: rmPid, removeSocket: rmSock } = await import('./lib/config.js')
        rmPid()
        rmSock()
        // Start fresh
        const ok = await ensureDaemon()
        if (ok) console.log('Daemon restarted')
        else console.error('Failed to restart daemon')
      } else if (sub === 'status') {
        try {
          const res = await ipcRequest({ cmd: 'status' })
          if (res.ok) {
            console.log(`Daemon running`)
            console.log(`  Name: ${res.name}`)
            console.log(`  Peers: ${res.peers.length} connected`)
            for (const p of res.peers) {
              console.log(`    - ${p.name} (${timeAgo(p.connectedAt)})`)
            }
            console.log(`  Messages: ${res.unread} unread, ${res.total} total`)
          }
        } catch {
          console.log('Daemon not running')
        }
      } else {
        console.error('Usage: pearup daemon <start|stop|restart|status>')
      }
      break
    }

    case 'send': {
      if (!readConfig()) {
        console.error('Not initialized. Run: pearup init --name <name>')
        process.exit(1)
      }
      const body = positional[0]
      if (!body) {
        // Check stdin
        const chunks = []
        if (!process.stdin.isTTY) {
          for await (const chunk of process.stdin) chunks.push(chunk)
          const stdinBody = Buffer.concat(chunks).toString().trim()
          if (stdinBody) {
            requireDaemon()
            try {
              const res = await ipcRequest({ cmd: 'send', body: stdinBody, to: flags.to || '*', replyTo: flags['reply-to'] || null, room: flags.room || null })
              if (res.ok) {
                if (res.peersReached === 0) {
                  process.stderr.write('Message queued (no peers connected)\n')
                }
                process.exit(0)
              } else {
                console.error('Send failed: ' + (res.error || 'unknown error'))
                process.exit(1)
              }
            } catch (err) {
              log('error', 'CLI send error:', err.message)
              console.error('Failed to send message: ' + err.message)
              process.exit(1)
            }
            return
          }
        }
        console.error('Usage: pearup send [--to <name>] [--room <room>] [--reply-to <id>] "<message>"')
        process.exit(1)
      }
      requireDaemon()
      try {
        const res = await ipcRequest({ cmd: 'send', body, to: flags.to || '*', replyTo: flags['reply-to'] || null, room: flags.room || null })
        if (res.ok) {
          if (res.peersReached === 0) {
            process.stderr.write('Message queued (no peers connected)\n')
          }
          // Otherwise silent success for Claude hook friendliness
        } else {
          console.error('Send failed: ' + (res.error || 'unknown error'))
          process.exit(1)
        }
      } catch (err) {
        log('error', 'CLI send error:', err.message)
        console.error('Failed to send message: ' + err.message)
        process.exit(1)
      }
      break
    }

    case 'read': {
      if (!readConfig()) {
        console.error('Not initialized. Run: pearup init --name <name>')
        process.exit(1)
      }
      requireDaemon()
      try {
        const req = { cmd: 'read' }
        if (flags.unread) req.unread = true
        if (flags.from) req.from = flags.from
        if (flags.last) req.last = parseInt(flags.last)
        if (flags['mark-read']) req.markRead = true
        if (flags.room) req.room = flags.room

        const res = await ipcRequest(req)
        if (!res.ok) {
          console.error('Read failed: ' + (res.error || 'unknown error'))
          process.exit(1)
        }

        if (flags.brief) {
          // Token-efficient format for Claude Code hooks
          // Filter out own messages (we only want messages from others)
          const config = readConfig()
          const others = res.messages.filter(m => m.from !== config.name)
          if (others.length === 0) {
            // Output nothing — zero tokens
            process.exit(0)
          }
          if (others.length === 1) {
            const m = others[0]
            console.log(`[PearUp] 1 message from ${m.from} at ${formatTs(m.ts)} (${timeAgo(m.ts)}):`)
            console.log(`> ${m.body}`)
            console.log(`(reply: pearup send --to ${m.from} "message")`)
          } else {
            console.log(`[PearUp] ${others.length} messages:`)
            for (const m of others) {
              console.log(`  ${m.from} [${formatTs(m.ts)}] (${timeAgo(m.ts)}): ${m.body}`)
            }
            const senders = [...new Set(others.map(m => m.from))]
            console.log(`(reply: pearup send --to <${senders.join('|')}> "message" | broadcast: pearup send "message")`)
          }
        } else {
          // Human-readable format
          if (res.messages.length === 0) {
            console.log('No messages')
            process.exit(0)
          }
          for (const m of res.messages) {
            const dir = m.to === '*' ? 'broadcast' : `-> ${m.to}`
            const re = m.re ? ` [re: ${m.re.slice(0, 4)}]` : ''
            const seen = m.seenBy && m.seenBy.length > 0 ? ` seen by ${m.seenBy.join(', ')}` : ''
            console.log(`-- ${m.from} ${dir} at ${formatTs(m.ts)} (${timeAgo(m.ts)})${re} -----`)
            console.log(`| ${m.body}`)
            console.log(`-- [msg:${m.id.slice(0, 4)}]${seen}`)
            console.log()
          }
        }
      } catch (err) {
        log('error', 'CLI read error:', err.message)
        console.error('Failed to read messages: ' + err.message)
        process.exit(1)
      }
      break
    }

    case 'status': {
      if (!readConfig()) {
        console.error('Not initialized. Run: pearup init --name <name>')
        process.exit(1)
      }
      requireDaemon()
      try {
        const res = await ipcRequest({ cmd: 'status' })
        if (res.ok) {
          console.log(`Identity: ${res.name}`)
          if (res.rooms && res.rooms.length > 1) {
            console.log(`Rooms: ${res.rooms.map(r => r.id === res.defaultRoom ? `${r.name}*` : r.name).join(', ')}`)
          } else {
            const words = res.room.split(' ')
            const truncated = words.slice(0, 4).join(' ') + ' ...'
            console.log(`Room: ${truncated}`)
          }
          console.log(`Peers: ${res.peers.length} connected`)
          for (const p of res.peers) {
            const pRooms = p.rooms && p.rooms.length > 1 ? ` [${p.rooms.join(',')}]` : ''
            console.log(`  - ${p.name} (${timeAgo(p.connectedAt)})${pRooms}`)
          }
          console.log(`Messages: ${res.unread} unread, ${res.total} total`)
        } else {
          console.error('Status failed: ' + (res.error || 'unknown error'))
          process.exit(1)
        }
      } catch (err) {
        log('error', 'CLI status error:', err.message)
        console.error('Failed to get status: ' + err.message)
        process.exit(1)
      }
      break
    }

    case 'autostart': {
      const sub = positional[0]
      if (sub === 'enable') {
        const mode = flags.headless ? 'daemon' : 'tray'
        const p = enableAutostart(mode)
        console.log(`Autostart enabled (${mode} mode): ${p}`)
      } else if (sub === 'disable') {
        disableAutostart()
        console.log('Autostart disabled')
      } else if (sub === 'status') {
        console.log(isAutostartEnabled() ? 'Autostart enabled' : 'Autostart disabled')
      } else {
        console.error('Usage: pearup autostart <enable|disable|status> [--headless]')
      }
      break
    }

    case 'claude-notify': {
      const config = readConfig()
      if (!config) {
        console.error('Not initialized. Run: pearup init --name <name>')
        process.exit(1)
      }
      const sub = positional[0]
      if (sub === 'enable') {
        config.claudeNotify = true
        writeConfig(config)
        console.log('Claude auto-notify enabled')
        console.log('When a PearUp message arrives, the daemon will resume your Claude session.')
        console.log('')
        console.log('Optional: pin to a specific session:')
        console.log('  pearup claude-notify session <session-id>')
        console.log('')
        console.log('By default, continues the most recent Claude session (--continue).')
      } else if (sub === 'disable') {
        config.claudeNotify = false
        writeConfig(config)
        console.log('Claude auto-notify disabled')
      } else if (sub === 'session') {
        const sid = positional[1]
        if (!sid) {
          // Show current session
          const sessionFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.pearup', 'claude-session')
          try {
            const homedir = await import('os').then(m => m.default.homedir())
            const sf = path.join(homedir, '.pearup', 'claude-session')
            const current = await import('fs').then(m => m.default.readFileSync(sf, 'utf-8').trim())
            console.log('Current session:', current || '(none — using --continue)')
          } catch {
            console.log('No session pinned (using --continue for most recent)')
          }
          console.log('Usage: pearup claude-notify session <session-id>')
        } else {
          const { default: os } = await import('os')
          const { default: fs } = await import('fs')
          const sf = path.join(os.homedir(), '.pearup', 'claude-session')
          fs.writeFileSync(sf, sid + '\n')
          console.log('Claude session pinned:', sid)
        }
      } else if (sub === 'skip-permissions') {
        const toggle = positional[1]
        if (toggle === 'on') {
          config.claudeNotifyDangerouslySkipPermissions = true
          writeConfig(config)
          console.log('Skip permissions enabled for claude-notify')
          console.log('The spawned Claude will run with --dangerously-skip-permissions')
        } else if (toggle === 'off') {
          config.claudeNotifyDangerouslySkipPermissions = false
          writeConfig(config)
          console.log('Skip permissions disabled for claude-notify')
        } else {
          console.log('Skip permissions:', config.claudeNotifyDangerouslySkipPermissions ? 'on' : 'off')
          console.log('Usage: pearup claude-notify skip-permissions <on|off>')
        }
      } else if (sub === 'status') {
        console.log('Claude auto-notify:', config.claudeNotify ? 'enabled' : 'disabled')
        if (config.claudeNotify) {
          console.log('  Skip permissions:', config.claudeNotifyDangerouslySkipPermissions ? 'on' : 'off')
        }
      } else {
        console.log(`pearup claude-notify — Auto-resume Claude when messages arrive

Usage:
  pearup claude-notify enable              Enable auto-resume
  pearup claude-notify disable             Disable auto-resume
  pearup claude-notify status              Show current status
  pearup claude-notify session <id>        Pin to specific Claude session
  pearup claude-notify session             Show current session
  pearup claude-notify skip-permissions <on|off>  Skip permissions for spawned Claude`)
      }
      break
    }

    case 'room': {
      const config = readConfig()
      if (!config) {
        console.error('Not initialized. Run: pearup init --name <name>')
        process.exit(1)
      }
      const sub = positional[0]
      if (sub === 'add') {
        const roomName = flags.name
        if (!roomName) {
          console.error('Usage: pearup room add --name <name> [--mnemonic "<12 words>"]')
          process.exit(1)
        }
        const roomId = roomName.toLowerCase().replace(/[^a-z0-9-]/g, '-')
        if (config.rooms && config.rooms.find(r => r.id === roomId)) {
          console.error('Room already exists:', roomId)
          process.exit(1)
        }
        let mnemonic
        if (flags.mnemonic) {
          mnemonic = flags.mnemonic
          if (!validateRoom(mnemonic)) {
            console.error('Invalid BIP39 mnemonic.')
            process.exit(1)
          }
        } else {
          mnemonic = generateRoom()
        }
        if (!config.rooms) config.rooms = []
        config.rooms.push({ id: roomId, name: roomName, mnemonic })
        // Ensure store directory exists
        const storePath = storePathForRoom(roomId)
        fs.mkdirSync(storePath, { recursive: true })
        writeConfig(config)
        console.log(`Room added: ${roomName} (${roomId})`)
        if (!flags.mnemonic) {
          console.log(`\nShare this phrase with peers for this room:`)
          console.log(`  ${mnemonic}`)
        }
        console.log('\nRestart daemon to join: pearup daemon restart')
      } else if (sub === 'list') {
        const rooms = config.rooms || []
        if (rooms.length === 0) {
          console.log('No rooms configured')
        } else {
          console.log('Rooms:')
          for (const r of rooms) {
            const def = r.id === (config.defaultRoom || 'default') ? ' (default)' : ''
            console.log(`  - ${r.name} [${r.id}]${def}`)
          }
        }
      } else if (sub === 'remove') {
        const roomId = flags.id || flags.name
        if (!roomId) {
          console.error('Usage: pearup room remove --id <room-id>')
          process.exit(1)
        }
        if (roomId === 'default') {
          console.error('Cannot remove the default room')
          process.exit(1)
        }
        config.rooms = (config.rooms || []).filter(r => r.id !== roomId && r.name !== roomId)
        writeConfig(config)
        console.log(`Room removed: ${roomId}`)
        console.log('Restart daemon to apply: pearup daemon restart')
      } else if (sub === 'set-default') {
        const roomId = flags.id || flags.name
        if (!roomId) {
          console.error('Usage: pearup room set-default --id <room-id>')
          process.exit(1)
        }
        const found = (config.rooms || []).find(r => r.id === roomId || r.name === roomId)
        if (!found) {
          console.error('Room not found:', roomId)
          process.exit(1)
        }
        config.defaultRoom = found.id
        writeConfig(config)
        console.log(`Default room set to: ${found.name} [${found.id}]`)
      } else {
        console.log(`pearup room — Manage chat rooms

Usage:
  pearup room list                                    List rooms
  pearup room add --name <name> [--mnemonic "<12w>"]  Add a room
  pearup room remove --id <room-id>                   Remove a room
  pearup room set-default --id <room-id>              Set default room`)
      }
      break
    }

    case 'tray': {
      if (!readConfig()) {
        console.error('Not initialized. Run: pearup init --name <name>')
        process.exit(1)
      }
      const electronPath = path.join(__dirname, 'node_modules', '.bin', 'electron')
      const child = spawn(electronPath, [path.join(__dirname, 'main.js')], {
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
      console.log('Tray app launched')
      break
    }

    default:
      console.log(`PearUp — P2P inter-Claude messaging

Usage:
  pearup init --name <name> [--display-name <human>] [--room "<12 words>"]
  pearup send [--to <name>] [--room <room>] "<message>"
  pearup read [--unread] [--brief] [--mark-read] [--room <room>]
  pearup read [--last <n>] [--from <name>] [--room <room>]
  pearup status                                      Show peers & room info
  pearup daemon <start|stop|restart|status>           Manage daemon
  pearup room <list|add|remove|set-default>          Manage rooms
  pearup tray                                        Launch tray app
  pearup autostart <enable|disable|status>           Start on login
  pearup claude-notify <enable|disable|status>       Auto-resume Claude on message
  pearup claude-notify session <id>                  Pin to a Claude session`)
      break
  }
}

main().catch((err) => {
  log('error', 'CLI fatal error:', err.message)
  console.error(err.message)
  process.exit(1)
})
