import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import { STORE_PATH } from './config.js'

export class MessageStore {
  constructor (storagePath) {
    this.corestore = new Corestore(storagePath || STORE_PATH)
    this.core = this.corestore.get({ name: 'pearup-messages' })
    this.db = new Hyperbee(this.core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    this.messages = this.db.sub('messages')
    this.unread = this.db.sub('unread')
    this.meta = this.db.sub('meta')
  }

  async ready () {
    await this.db.ready()
  }

  async close () {
    await this.db.close()
    await this.corestore.close()
  }

  _msgKey (ts, id) {
    return `${String(ts).padStart(16, '0')}:${id}`
  }

  async put (msg) {
    const key = this._msgKey(msg.ts, msg.id)
    await this.messages.put(key, msg)
    await this.unread.put(key, { id: msg.id, ts: msg.ts })
  }

  async markRead (msgId) {
    // scan unread for this msgId
    for await (const entry of this.unread.createReadStream()) {
      if (entry.value.id === msgId) {
        await this.unread.del(entry.key)
        break
      }
    }
  }

  async markAllRead () {
    const batch = this.unread.batch()
    for await (const entry of this.unread.createReadStream()) {
      await batch.del(entry.key)
    }
    await batch.flush()
  }

  async getUnread () {
    const msgs = []
    for await (const entry of this.unread.createReadStream()) {
      const msg = await this.messages.get(entry.key)
      if (msg) msgs.push(msg.value)
    }
    return msgs
  }

  async getRecent (n = 50) {
    const msgs = []
    for await (const entry of this.messages.createReadStream({ reverse: true, limit: n })) {
      msgs.push(entry.value)
    }
    return msgs.reverse()
  }

  async getFrom (peerId, n = 10) {
    const msgs = []
    for await (const entry of this.messages.createReadStream({ reverse: true })) {
      if (entry.value.from === peerId) {
        msgs.push(entry.value)
        if (msgs.length >= n) break
      }
    }
    return msgs.reverse()
  }

  async getTotal () {
    let count = 0
    for await (const _ of this.messages.createReadStream()) count++
    return count
  }

  async getUnreadCount () {
    let count = 0
    for await (const _ of this.unread.createReadStream()) count++
    return count
  }

  async clearAll () {
    const msgBatch = this.messages.batch()
    for await (const entry of this.messages.createReadStream()) {
      await msgBatch.del(entry.key)
    }
    await msgBatch.flush()

    const unreadBatch = this.unread.batch()
    for await (const entry of this.unread.createReadStream()) {
      await unreadBatch.del(entry.key)
    }
    await unreadBatch.flush()
  }
}
