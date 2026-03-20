// Text colors for sender labels
const PEER_COLORS = [
  '#7c5cbf', '#e06c75', '#61afef', '#98c379', '#e5c07b',
  '#c678dd', '#56b6c2', '#d19a66', '#f472b6', '#a3e635'
]
// Darker versions for bubble backgrounds
const BUBBLE_COLORS = [
  '#2a2046', '#3a2029', '#1e2d3e', '#1f2e1f', '#2e2a1a',
  '#2d1e36', '#1a2e30', '#2e241a', '#301a28', '#1e2e10'
]

let myName = ''
let myDisplayName = ''
let knownPeers = [] // [{ name, displayName }]
let sendTarget = '*' // '*' = broadcast, or peer name
let currentRoom = 'default'
let allRooms = [] // [{ id, name }]
let unreadPerRoom = {} // roomId -> count
const colorMap = {}
const bubbleMap = {}
let colorIdx = 0
let lastDateStr = ''
let messagesById = new Map()
let sidebarOpen = true

function getColor (name) {
  if (name === myName) return PEER_COLORS[0]
  if (!colorMap[name]) {
    colorIdx = (colorIdx + 1) % PEER_COLORS.length
    if (colorIdx === 0) colorIdx = 1
    colorMap[name] = PEER_COLORS[colorIdx]
    bubbleMap[name] = BUBBLE_COLORS[colorIdx]
  }
  return colorMap[name]
}

function getBubbleBg (name) {
  getColor(name) // ensure assigned
  return bubbleMap[name] || '#222240'
}

function formatTime (ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDate (ts) {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
}

function addDayDivider (ts) {
  const dateStr = new Date(ts).toDateString()
  if (dateStr !== lastDateStr) {
    lastDateStr = dateStr
    const div = document.createElement('div')
    div.className = 'day-divider'
    div.textContent = formatDate(ts)
    document.getElementById('messages').appendChild(div)
  }
}

function renderMessage (msg) {
  if (messagesById.has(msg.id)) return
  messagesById.set(msg.id, msg)

  const container = document.getElementById('messages')
  addDayDivider(msg.ts)

  const el = document.createElement('div')
  const isSelf = msg.from === myName && msg.via === 'ui'
  el.className = isSelf ? 'msg self' : 'msg other'
  el.dataset.id = msg.id

  if (!isSelf) {
    el.style.background = getBubbleBg(msg.from)
  }

  buildMessageHTML(el, msg, isSelf)

  container.appendChild(el)
  container.scrollTop = container.scrollHeight
}

function buildMessageHTML (el, msg, isSelf) {
  let html = ''

  if (msg.re) {
    const original = messagesById.get(msg.re)
    const refText = original ? original.body.slice(0, 60) + (original.body.length > 60 ? '...' : '') : msg.re.slice(0, 8)
    html += `<div class="reply-ref">${escapeHtml(refText)}</div>`
  }

  const color = getColor(msg.from)
  let label = msg.from
  let labelClass = 'sender'
  if (isSelf) {
    label = 'You'
  } else if (msg.via === 'ui') {
    label = msg.displayName ? `${msg.displayName}@${msg.from}` : `${msg.from} (human)`
    labelClass = 'sender sender-human'
  } else if (msg.via === 'cli') {
    label = `${msg.from} (claude)`
    labelClass = 'sender sender-claude'
  } else if (msg.from === myName && msg.via === 'cli') {
    label = `${msg.from} (claude)`
    labelClass = 'sender sender-claude'
  }
  html += `<div class="${labelClass}" style="color: ${color}">${escapeHtml(label)}</div>`

  html += `<div class="body">${renderBody(msg.body)}</div>`

  const target = msg.to === '*' ? '' : ` to ${msg.to}`
  const seen = msg.seenBy && msg.seenBy.length > 0 ? ` · ✓ ${msg.seenBy.join(', ')}` : ''
  html += `<div class="meta">${formatTime(msg.ts)}${target}${seen}</div>`

  el.innerHTML = html
}

function escapeHtml (str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

function renderBody (text) {
  let html = escapeHtml(text)
  const allNames = [myName, ...knownPeers.map(p => p.name)]
  html = html.replace(/@(\w[\w-]*)/g, (match, name) => {
    const isMe = myName && name.toLowerCase() === myName.toLowerCase()
    const isKnown = allNames.some(n => n.toLowerCase() === name.toLowerCase())
    if (isKnown) {
      const cls = isMe ? 'mention mention-me' : 'mention'
      return `<span class="${cls}">${match}</span>`
    }
    return `<span class="mention">${match}</span>`
  })
  return html
}

function updateStatus (peerCount) {
  const dot = document.getElementById('status-dot')
  const text = document.getElementById('status-text')

  if (peerCount > 0) {
    dot.className = 'status-dot connected'
    text.textContent = `${peerCount} peer${peerCount > 1 ? 's' : ''} connected`
  } else {
    dot.className = 'status-dot disconnected'
    text.textContent = 'no peers connected'
  }

  const subtitle = document.getElementById('room-subtitle')
  if (subtitle) {
    subtitle.textContent = peerCount > 0
      ? `${peerCount} peer${peerCount > 1 ? 's' : ''} online`
      : 'no peers online'
  }
}

// ═══════════ SIDEBAR ═══════════

function toggleSidebar () {
  const sidebar = document.getElementById('sidebar')
  const toggle = document.getElementById('sidebar-toggle')
  sidebarOpen = !sidebarOpen

  if (sidebarOpen) {
    sidebar.classList.remove('collapsed')
    toggle.style.display = 'none'
  } else {
    sidebar.classList.add('collapsed')
    toggle.style.display = 'flex'
  }
}

function renderRoomList () {
  const list = document.getElementById('room-list')
  if (!list) return

  list.innerHTML = ''
  for (const room of allRooms) {
    const item = document.createElement('button')
    item.className = 'room-item' + (room.id === currentRoom ? ' active' : '')

    const icon = document.createElement('span')
    icon.className = 'room-icon'
    icon.textContent = '#'

    const name = document.createElement('span')
    name.className = 'room-name'
    name.textContent = room.name

    item.appendChild(icon)
    item.appendChild(name)

    if (unreadPerRoom[room.id]) {
      const badge = document.createElement('span')
      badge.className = 'room-badge'
      badge.textContent = unreadPerRoom[room.id]
      item.appendChild(badge)
    }

    item.addEventListener('click', () => switchRoom(room.id))
    list.appendChild(item)
  }

  const current = allRooms.find(r => r.id === currentRoom)
  const title = document.getElementById('room-title')
  if (title && current) {
    title.textContent = `# ${current.name}`
  }
}

async function switchRoom (roomId) {
  if (roomId === currentRoom) return
  currentRoom = roomId
  messagesById.clear()
  lastDateStr = ''
  document.getElementById('messages').innerHTML = ''
  unreadPerRoom[roomId] = 0
  renderRoomList()

  const data = await window.pearup.getHistory(roomId)
  for (const msg of data.messages) {
    renderMessage(msg)
  }
  if (data.messages.length === 0) {
    document.getElementById('messages').innerHTML = `
      <div id="empty-state">
        <div class="icon">&#127824;</div>
        <div class="text">No messages yet</div>
        <div class="subtext">Your Claudes will show up here</div>
      </div>
    `
  }
}

// ═══════════ INIT ═══════════

async function init () {
  const data = await window.pearup.getHistory()
  myName = data.name
  myDisplayName = data.displayName || ''
  knownPeers = data.peers || []
  allRooms = data.rooms || [{ id: 'default', name: 'default' }]
  currentRoom = data.currentRoom || 'default'
  updateStatus(data.peers.length)
  updateRecipientPicker()
  renderRoomList()

  for (const msg of data.messages) {
    renderMessage(msg)
  }

  if (data.messages.length === 0) {
    const container = document.getElementById('messages')
    container.innerHTML = `
      <div id="empty-state">
        <div class="icon">&#127824;</div>
        <div class="text">No messages yet</div>
        <div class="subtext">Your Claudes will show up here</div>
      </div>
    `
  }
}

// Sidebar toggle buttons
document.getElementById('sidebar-close').addEventListener('click', toggleSidebar)
document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar)

// Peer connection status toasts
function addSystemMessage (text) {
  const container = document.getElementById('messages')
  const empty = document.getElementById('empty-state')
  if (empty) empty.remove()

  const el = document.createElement('div')
  el.className = 'system-msg'
  el.textContent = text
  container.appendChild(el)
  container.scrollTop = container.scrollHeight
}

window.pearup.onPeerJoined((info) => {
  addSystemMessage(info.name + ' connected')
  window.pearup.getHistory().then((data) => {
    knownPeers = data.peers || []
    updateStatus(knownPeers.length)
    updateRecipientPicker()
  })
})

window.pearup.onPeerLeft((info) => {
  addSystemMessage(info.name + ' disconnected')
  window.pearup.getHistory().then((data) => {
    knownPeers = data.peers || []
    updateStatus(knownPeers.length)
    updateRecipientPicker()
  })
})

// Live ACK updates
window.pearup.onAck((ack) => {
  const el = document.querySelector(`.msg[data-id="${ack.id}"]`)
  if (!el) return
  const meta = el.querySelector('.meta')
  if (!meta) return
  const current = meta.textContent
  if (current.includes(ack.seenBy)) return
  const seenText = current.includes('✓') ? `, ${ack.seenBy}` : ` · ✓ ${ack.seenBy}`
  meta.textContent = current + seenText
})

// Live updates
window.pearup.onMessage((msg) => {
  const msgRoom = msg.room || 'default'
  if (msgRoom !== currentRoom) {
    unreadPerRoom[msgRoom] = (unreadPerRoom[msgRoom] || 0) + 1
    renderRoomList()
    return
  }

  const empty = document.getElementById('empty-state')
  if (empty) empty.remove()

  renderMessage(msg)

  window.pearup.getStatus().then((s) => updateStatus(s.peers))
})

// Send from input
const input = document.getElementById('msg-input')
const sendBtn = document.getElementById('send-btn')

function updateRecipientPicker () {
  const picker = document.getElementById('recipient-picker')
  if (!picker) return
  const current = picker.value
  picker.innerHTML = '<option value="*">everyone</option>'
  if (myName) {
    const selfOpt = document.createElement('option')
    selfOpt.value = myName
    selfOpt.textContent = `${myName} (self)`
    picker.appendChild(selfOpt)
  }
  for (const p of knownPeers) {
    const opt = document.createElement('option')
    opt.value = p.name
    opt.textContent = p.displayName ? `${p.displayName}@${p.name}` : p.name
    picker.appendChild(opt)
  }
  if (current && [...picker.options].some(o => o.value === current)) {
    picker.value = current
  }
  sendTarget = picker.value
}

async function sendFromInput () {
  const body = input.value.trim()
  if (!body) return
  input.value = ''
  const picker = document.getElementById('recipient-picker')
  const to = picker ? picker.value : '*'
  await window.pearup.sendMessage(body, to, currentRoom)
}

sendBtn.addEventListener('click', sendFromInput)
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    const popup = document.getElementById('mention-popup')
    if (popup && popup.classList.contains('visible')) return
    e.preventDefault()
    sendFromInput()
  }
})

// Clear history
document.getElementById('clear-btn').addEventListener('click', async () => {
  await window.pearup.clearHistory(currentRoom)
  document.getElementById('messages').innerHTML = `
    <div id="empty-state">
      <div class="icon">&#127824;</div>
      <div class="text">No messages yet</div>
      <div class="subtext">Your Claudes will show up here</div>
    </div>
  `
  messagesById.clear()
  lastDateStr = ''
})

// ═══════════ @MENTION AUTOCOMPLETE ═══════════

const mentionPopup = document.getElementById('mention-popup')
let mentionSelectedIdx = -1

function getMentionCandidates () {
  const candidates = []
  if (myName) {
    candidates.push({ name: myName, label: 'self' })
  }
  for (const p of knownPeers) {
    candidates.push({ name: p.name, label: p.displayName || '' })
  }
  return candidates
}

function getMentionContext () {
  const val = input.value
  const pos = input.selectionStart
  const before = val.slice(0, pos)
  const match = before.match(/@(\w*)$/)
  if (!match) return null
  return { query: match[1].toLowerCase(), start: match.index, end: pos }
}

function showMentionPopup () {
  const ctx = getMentionContext()
  if (!ctx) {
    mentionPopup.classList.remove('visible')
    return
  }

  const candidates = getMentionCandidates().filter(c =>
    c.name.toLowerCase().startsWith(ctx.query)
  )

  if (candidates.length === 0) {
    mentionPopup.classList.remove('visible')
    return
  }

  mentionPopup.innerHTML = ''
  mentionSelectedIdx = 0

  candidates.forEach((c, i) => {
    const btn = document.createElement('button')
    btn.className = 'mention-option' + (i === 0 ? ' selected' : '')
    btn.innerHTML = `<span class="mention-name">@${escapeHtml(c.name)}</span>` +
      (c.label ? `<span class="mention-label">${escapeHtml(c.label)}</span>` : '')
    btn.addEventListener('click', () => completeMention(c.name))
    mentionPopup.appendChild(btn)
  })

  mentionPopup.classList.add('visible')
}

function completeMention (name) {
  const ctx = getMentionContext()
  if (!ctx) return
  const before = input.value.slice(0, ctx.start)
  const after = input.value.slice(ctx.end)
  input.value = before + '@' + name + ' ' + after
  input.focus()
  const newPos = ctx.start + name.length + 2
  input.setSelectionRange(newPos, newPos)
  mentionPopup.classList.remove('visible')
}

input.addEventListener('input', () => {
  showMentionPopup()
})

input.addEventListener('keydown', (e) => {
  if (!mentionPopup.classList.contains('visible')) return

  const options = mentionPopup.querySelectorAll('.mention-option')
  if (options.length === 0) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    options[mentionSelectedIdx]?.classList.remove('selected')
    mentionSelectedIdx = (mentionSelectedIdx + 1) % options.length
    options[mentionSelectedIdx]?.classList.add('selected')
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    options[mentionSelectedIdx]?.classList.remove('selected')
    mentionSelectedIdx = (mentionSelectedIdx - 1 + options.length) % options.length
    options[mentionSelectedIdx]?.classList.add('selected')
  } else if (e.key === 'Tab' || (e.key === 'Enter' && mentionPopup.classList.contains('visible'))) {
    if (mentionSelectedIdx >= 0 && options[mentionSelectedIdx]) {
      e.preventDefault()
      e.stopPropagation()
      const name = options[mentionSelectedIdx].querySelector('.mention-name').textContent.slice(1)
      completeMention(name)
    }
  } else if (e.key === 'Escape') {
    mentionPopup.classList.remove('visible')
  }
})

document.addEventListener('click', (e) => {
  if (!mentionPopup.contains(e.target) && e.target !== input) {
    mentionPopup.classList.remove('visible')
  }
})

// Periodic status refresh
setInterval(async () => {
  const s = await window.pearup.getStatus()
  updateStatus(s.peers)
}, 15000)

init()
