import { WebSocket } from 'ws'
import { createServer } from '../src/server.js'

describe('createServer', () => {
  let instance

  afterEach(async () => {
    if (instance) {
      await new Promise((resolve) => instance.server.close(resolve))
      instance = null
    }
  })

  const connect = (port) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })

  const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

  it('listens on an available port and starts with no connected clients', async () => {
    instance = await createServer()
    expect(typeof instance.port).toBe('number')
    expect(instance.port).toBeGreaterThan(0)
    expect(instance.clients.size).toBe(0)
  })

  it('tracks a connecting client and drops it again once it disconnects', async () => {
    instance = await createServer()
    const ws = await connect(instance.port)
    await wait()
    expect(instance.clients.size).toBe(1)

    ws.close()
    await wait()
    expect(instance.clients.size).toBe(0)
  })

  it('emits "message" for a regular JSON message from a client', async () => {
    instance = await createServer()
    const ws = await connect(instance.port)

    const received = new Promise((resolve) => instance.events.once('message', resolve))
    ws.send(JSON.stringify({ _type: 'click', foo: 'bar' }))

    expect(await received).toEqual({ _type: 'click', foo: 'bar' })
    ws.close()
  })

  it('emits "overlay-action" for a message flagged as an overlay action', async () => {
    instance = await createServer()
    const ws = await connect(instance.port)

    const received = new Promise((resolve) => instance.events.once('overlay-action', resolve))
    ws.send(JSON.stringify({ _type: 'overlay-action', action: 'pause' }))

    expect(await received).toEqual({ _type: 'overlay-action', action: 'pause' })
    ws.close()
  })

  it('silently ignores a malformed (non-JSON) message', async () => {
    instance = await createServer()
    const ws = await connect(instance.port)

    const messageSpy = jest.fn()
    const overlaySpy = jest.fn()
    instance.events.on('message', messageSpy)
    instance.events.on('overlay-action', overlaySpy)

    ws.send('not valid json {{{')
    await wait()

    expect(messageSpy).not.toHaveBeenCalled()
    expect(overlaySpy).not.toHaveBeenCalled()
    ws.close()
  })

  it('broadcasts a message to every connected client', async () => {
    instance = await createServer()
    const ws1 = await connect(instance.port)
    const ws2 = await connect(instance.port)

    const gotMessage1 = new Promise((resolve) => ws1.once('message', (data) => resolve(data.toString())))
    const gotMessage2 = new Promise((resolve) => ws2.once('message', (data) => resolve(data.toString())))

    instance.broadcast({ hello: 'world' })

    expect(await gotMessage1).toBe(JSON.stringify({ hello: 'world' }))
    expect(await gotMessage2).toBe(JSON.stringify({ hello: 'world' }))

    ws1.close()
    ws2.close()
  })

  it('does not send a broadcast to a tracked client that is not open', async () => {
    instance = await createServer()
    const closedClient = { readyState: 3, send: jest.fn() }
    instance.clients.add(closedClient)

    instance.broadcast({ hi: true })

    expect(closedClient.send).not.toHaveBeenCalled()
  })
})
