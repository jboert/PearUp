import Protomux from 'protomux'
import c from 'compact-encoding'

const PROTOCOL = 'pearup/v1'

export function setupProtocol (stream, { name, displayName, rooms, onidentity, onmessage, onack, onsync, onping, onclose }) {
  const mux = Protomux.from(stream)

  const channel = mux.createChannel({
    protocol: PROTOCOL,
    handshake: c.json,
    onopen (remoteHandshake) {
      if (onidentity) onidentity(remoteHandshake)
    },
    onclose () {
      if (onclose) onclose()
    }
  })

  const chat = channel.addMessage({
    encoding: c.json,
    onmessage (msg) {
      if (onmessage) onmessage(msg)
    }
  })

  const ack = channel.addMessage({
    encoding: c.json,
    onmessage (data) {
      if (onack) onack(data)
    }
  })

  // Sync message type — exchange message IDs on connect
  const sync = channel.addMessage({
    encoding: c.json,
    onmessage (data) {
      if (onsync) onsync(data)
    }
  })

  // Ping/pong message type for liveness checking
  const ping = channel.addMessage({
    encoding: c.json,
    onmessage (data) {
      if (onping) onping(data)
    }
  })

  const handshake = { name }
  if (displayName) handshake.displayName = displayName
  if (rooms) handshake.rooms = rooms
  channel.open(handshake)

  return {
    channel,
    send (msg) {
      chat.send(msg)
    },
    sendAck (msgId, seenBy) {
      ack.send({ id: msgId, seenBy, ts: Date.now() })
    },
    sendSync (data) {
      sync.send(data)
    },
    sendPing () {
      ping.send({ type: 'ping', ts: Date.now() })
    },
    sendPong (pingTs) {
      ping.send({ type: 'pong', ts: Date.now(), pingTs })
    },
    close () {
      channel.close()
    }
  }
}
