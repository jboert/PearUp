const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pearup', {
  getHistory: (room) => ipcRenderer.invoke('get-history', room),
  sendMessage: (body, to, room) => ipcRenderer.invoke('send-message', body, to, room),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getRooms: () => ipcRenderer.invoke('get-rooms'),
  clearHistory: (room) => ipcRenderer.invoke('clear-history', room),
  onMessage: (callback) => {
    ipcRenderer.on('new-message', (event, msg) => callback(msg))
  },
  onAck: (callback) => {
    ipcRenderer.on('message-ack', (event, ack) => callback(ack))
  },
  onPeerJoined: (callback) => {
    ipcRenderer.on('peer-joined', (event, info) => callback(info))
  },
  onPeerLeft: (callback) => {
    ipcRenderer.on('peer-left', (event, info) => callback(info))
  }
})
