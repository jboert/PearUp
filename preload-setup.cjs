const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pearup', {
  completeSetup: (data) => ipcRenderer.send('setup-complete', data)
})
