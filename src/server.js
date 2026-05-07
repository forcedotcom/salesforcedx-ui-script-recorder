import { WebSocketServer } from 'ws'
import { EventEmitter } from 'events'
import http from 'http'

/**
 * Creates a WebSocket server that the injected page scripts connect to
 * for sending recorded events back to the CLI process.
 */
export async function createServer() {
  const events = new EventEmitter()

  const httpServer = http.createServer()
  const wss = new WebSocketServer({ server: httpServer })

  const clients = new Set()

  wss.on('connection', (ws) => {
    clients.add(ws)

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())

        if (msg._type === 'overlay-action') {
          events.emit('overlay-action', msg)
        } else {
          events.emit('message', msg)
        }
      } catch (err) {
        // Ignore malformed messages
      }
    })

    ws.on('close', () => {
      clients.delete(ws)
    })
  })

  // Broadcast a message to all connected clients (injected pages)
  function broadcast(msg) {
    const data = JSON.stringify(msg)
    for (const client of clients) {
      if (client.readyState === 1) { // OPEN
        client.send(data)
      }
    }
  }

  // Find an available port
  const port = await new Promise((resolve, reject) => {
    httpServer.listen(0, '127.0.0.1', () => {
      resolve(httpServer.address().port)
    })
    httpServer.on('error', reject)
  })

  return {
    server: httpServer,
    wss,
    port,
    events,
    broadcast,
    clients
  }
}
