import net from 'net'
import { SOCKET_PATH } from './config.js'

function ipcRequestOnce (cmd, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCKET_PATH)
    let buf = ''
    let done = false

    const timer = setTimeout(() => {
      if (!done) {
        done = true
        conn.destroy()
        reject(new Error('ipc timeout'))
      }
    }, timeout)

    conn.on('connect', () => {
      conn.write(JSON.stringify(cmd) + '\n')
    })

    conn.on('data', (data) => {
      buf += data.toString()
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        done = true
        clearTimeout(timer)
        conn.destroy()
        try {
          resolve(JSON.parse(line))
        } catch {
          reject(new Error('invalid response'))
        }
        return
      }
    })

    conn.on('error', (err) => {
      if (!done) {
        done = true
        clearTimeout(timer)
        reject(err)
      }
    })
  })
}

export async function ipcRequest (cmd, timeout = 5000) {
  try {
    return await ipcRequestOnce(cmd, timeout)
  } catch (firstErr) {
    // One retry after 500ms backoff
    await new Promise(r => setTimeout(r, 500))
    return ipcRequestOnce(cmd, timeout)
  }
}
