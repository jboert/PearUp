import net from 'net'
import { SOCKET_PATH, removeSocket } from './config.js'
import { log } from './logger.js'

export class IPCServer {
  constructor (handler) {
    this.handler = handler
    this.server = null
  }

  start () {
    return new Promise((resolve, reject) => {
      removeSocket()
      this.server = net.createServer((conn) => {
        let buf = ''
        conn.on('data', (data) => {
          buf += data.toString()
          const lines = buf.split('\n')
          buf = lines.pop()
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const req = JSON.parse(line)
              log('info', 'IPC request:', req.cmd)
              this.handler(req).then((res) => {
                conn.write(JSON.stringify(res) + '\n')
              }).catch((err) => {
                log('error', 'IPC handler error:', err.message)
                conn.write(JSON.stringify({ ok: false, error: err.message }) + '\n')
              })
            } catch (err) {
              log('error', 'IPC parse error:', err.message)
              conn.write(JSON.stringify({ ok: false, error: 'invalid json' }) + '\n')
            }
          }
        })
      })
      this.server.listen(SOCKET_PATH, () => resolve())
      this.server.on('error', reject)
    })
  }

  stop () {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          removeSocket()
          resolve()
        })
      } else {
        resolve()
      }
    })
  }
}
