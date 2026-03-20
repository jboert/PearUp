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
  // Self = only messages sent from this chat window (via: 'ui')
  // Everything else (cli, peer, unknown) = other
  const isSelf = msg.from === myName && msg.via === 'ui'
  el.className = isSelf ? 'msg self' : 'msg other'
  el.dataset.id = msg.id

  // Per-peer bubble background for non-self messages
  if (!isSelf) {
    el.style.background = getBubbleBg(msg.from)
  }

  buildMessageHTML(el, msg, isSelf)

  container.appendChild(el)
  container.scrollTop = container.scrollHeight
}

function buildMessageHTML (el, msg, isSelf) {
  let html = ''

  // Reply reference
  if (msg.re) {
    const original = messagesById.get(msg.re)
    const refText = original ? original.body.slice(0, 60) + (original.body.length > 60 ? '...' : '') : msg.re.slice(0, 8)
    html += `<div class="reply-ref">${escapeHtml(refText)}</div>`
  }

  // Sender label with human/claude identity
  const color = getColor(msg.from)
  let label = msg.from
  let labelClass = 'sender'
  if (isSelf) {
    label = 'You'
  } else if (msg.via === 'ui') {
    // Human message from another peer
    label = msg.displayName ? `${msg.displayName}@${msg.from}` : `${msg.from} (human)`
    labelClass = 'sender sender-human'
  } else if (msg.via === 'cli') {
    // Claude message
    label = `${msg.from} (claude)`
    labelClass = 'sender sender-claude'
  } else if (msg.from === myName && msg.via === 'cli') {
    // Our own Claude
    label = `${msg.from} (claude)`
    labelClass = 'sender sender-claude'
  }
  html += `<div class="${labelClass}" style="color: ${color}">${escapeHtml(label)}</div>`

  // Body with @mention highlighting
  html += `<div class="body">${highlightMentions(msg.body)}</div>`

  // Meta
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

function highlightMentions (body) {
  // Split on @name patterns, highlight matches against known peers + self
  const allNames = [myName, ...knownPeers.map(p => p.name)]
  const escaped = escapeHtml(body)
  return escaped.replace(/@(\w[\w-]*)/g, (match, name) => {
    const isKnown = allNames.some(n => n.toLowerCase() === name.toLowerCase())
    const isMe = myName && name.toLowerCase() === myName.toLowerCase()
    if (isKnown) {
      const cls = isMe ? 'mention mention-me' : 'mention'
      return `<span class="${cls}">${match}</span>`
    }
    return match
  })
}

function updateStatus (peerCount) {
  const dot = document.getElementById('status-dot')
  const text = document.getElementById('status-text')

  if (peerCount > 0) {
    dot.className = 'dot connected'
    text.textContent = `${peerCount} peer${peerCount > 1 ? 's' : ''} connected`
  } else {
    dot.className = 'dot disconnected'
    text.textContent = 'no peers connected'
  }
}

function renderRoomTabs () {
  const tabBar = document.getElementById('room-tabs')
  if (!tabBar) return
  if (allRooms.length <= 1) {
    tabBar.style.display = 'none'
    return
  }
  tabBar.style.display = 'flex'
  tabBar.innerHTML = ''
  for (const room of allRooms) {
    const tab = document.createElement('button')
    tab.className = 'room-tab' + (room.id === currentRoom ? ' active' : '')
    const badge = unreadPerRoom[room.id] ? ` <span class="room-badge">${unreadPerRoom[room.id]}</span>` : ''
    tab.innerHTML = escapeHtml(room.name) + badge
    tab.addEventListener('click', () => switchRoom(room.id))
    tabBar.appendChild(tab)
  }
}

async function switchRoom (roomId) {
  if (roomId === currentRoom) return
  currentRoom = roomId
  messagesById.clear()
  lastDateStr = ''
  document.getElementById('messages').innerHTML = ''
  unreadPerRoom[roomId] = 0
  renderRoomTabs()

  const data = await window.pearup.getHistory(roomId)
  for (const msg of data.messages) {
    renderMessage(msg)
  }
  if (data.messages.length === 0) {
    document.getElementById('messages').innerHTML = `
      <div id="empty-state">
        <div class="icon">&#127824;</div>
        <div class="text">No messages yet. Your Claudes will show up here.</div>
      </div>
    `
  }
}

// Load history
async function init () {
  const data = await window.pearup.getHistory()
  myName = data.name
  myDisplayName = data.displayName || ''
  knownPeers = data.peers || []
  allRooms = data.rooms || [{ id: 'default', name: 'default' }]
  currentRoom = data.currentRoom || 'default'
  updateStatus(data.peers.length)
  updateRecipientPicker()
  renderRoomTabs()

  for (const msg of data.messages) {
    renderMessage(msg)
  }

  if (data.messages.length === 0) {
    const container = document.getElementById('messages')
    container.innerHTML = `
      <div id="empty-state">
        <div class="icon">&#127824;</div>
        <div class="text">No messages yet. Your Claudes will show up here.</div>
      </div>
    `
  }
}

// Peer connection status toasts
function addSystemMessage (text) {
  const container = document.getElementById('messages')
  // Remove empty state if present
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

// Live ACK updates (seen indicators)
window.pearup.onAck((ack) => {
  const el = document.querySelector(`.msg[data-id="${ack.id}"]`)
  if (!el) return
  const meta = el.querySelector('.meta')
  if (!meta) return
  // Update seen text
  const current = meta.textContent
  if (current.includes(ack.seenBy)) return
  const seenText = current.includes('✓') ? `, ${ack.seenBy}` : ` · ✓ ${ack.seenBy}`
  meta.textContent = current + seenText
})

// Live updates
window.pearup.onMessage((msg) => {
  const msgRoom = msg.room || 'default'
  if (msgRoom !== currentRoom) {
    // Track unread for other rooms
    unreadPerRoom[msgRoom] = (unreadPerRoom[msgRoom] || 0) + 1
    renderRoomTabs()
    return
  }

  // Remove empty state if present
  const empty = document.getElementById('empty-state')
  if (empty) empty.remove()

  renderMessage(msg)

  // Refresh peer count
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
  for (const p of knownPeers) {
    const opt = document.createElement('option')
    opt.value = p.name
    opt.textContent = p.displayName ? `${p.displayName}@${p.name}` : p.name
    picker.appendChild(opt)
  }
  // Restore selection if still valid
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
  // Autocomplete navigation
  const ac = document.getElementById('autocomplete')
  if (ac && ac.style.display !== 'none') {
    const items = ac.querySelectorAll('.ac-item')
    const active = ac.querySelector('.ac-item.active')
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!active && items.length) { items[0].classList.add('active'); return }
      if (active && active.nextElementSibling) { active.classList.remove('active'); active.nextElementSibling.classList.add('active') }
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (active && active.previousElementSibling) { active.classList.remove('active'); active.previousElementSibling.classList.add('active') }
      return
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      const sel = ac.querySelector('.ac-item.active') || items[0]
      if (sel) {
        e.preventDefault()
        applyAutocomplete(sel.dataset.name)
        return
      }
    }
    if (e.key === 'Escape') {
      ac.style.display = 'none'
      return
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendFromInput()
  }
})

input.addEventListener('input', () => {
  const val = input.value
  const cursor = input.selectionStart
  // Find @word at cursor
  const before = val.slice(0, cursor)
  const match = before.match(/@(\w*)$/)
  const ac = document.getElementById('autocomplete')
  if (!match) { ac.style.display = 'none'; return }
  const query = match[1].toLowerCase()
  const allNames = [myName, ...knownPeers.map(p => p.name)]
  const matches = allNames.filter(n => n.toLowerCase().startsWith(query))
  if (matches.length === 0) { ac.style.display = 'none'; return }

  ac.innerHTML = ''
  for (const name of matches) {
    const item = document.createElement('div')
    item.className = 'ac-item'
    item.dataset.name = name
    item.textContent = '@' + name
    item.addEventListener('mousedown', (e) => {
      e.preventDefault()
      applyAutocomplete(name)
    })
    ac.appendChild(item)
  }
  ac.style.display = 'block'
})

function applyAutocomplete (name) {
  const val = input.value
  const cursor = input.selectionStart
  const before = val.slice(0, cursor)
  const after = val.slice(cursor)
  const replaced = before.replace(/@(\w*)$/, '@' + name + ' ')
  input.value = replaced + after
  input.selectionStart = input.selectionEnd = replaced.length
  document.getElementById('autocomplete').style.display = 'none'
  input.focus()
}

// Clear history
document.getElementById('clear-btn').addEventListener('click', async () => {
  await window.pearup.clearHistory(currentRoom)
  document.getElementById('messages').innerHTML = `
    <div id="empty-state">
      <div class="icon">&#127824;</div>
      <div class="text">No messages yet. Your Claudes will show up here.</div>
    </div>
  `
  messagesById.clear()
  lastDateStr = ''
})

// Periodic status refresh
setInterval(async () => {
  const s = await window.pearup.getStatus()
  updateStatus(s.peers)
}, 15000)

init()
