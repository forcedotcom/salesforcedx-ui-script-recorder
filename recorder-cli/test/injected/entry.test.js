/**
 * @jest-environment jsdom
 */
jest.mock('../../src/injected/recorder.js', () => ({
  Recorder: jest.fn().mockImplementation(() => ({ init: jest.fn() }))
}))
jest.mock('../../src/injected/overlay.js', () => ({
  Overlay: jest.fn().mockImplementation(() => ({ mount: jest.fn() }))
}))
jest.mock('../../src/injected/controller.js', () => ({
  Controller: jest.fn().mockImplementation(() => ({ handleMessage: jest.fn() }))
}))

class FakeWebSocket {
  constructor(url) {
    this.url = url
    this.readyState = FakeWebSocket.OPEN
    this.onopen = null
    this.onclose = null
    this.onerror = null
    this.onmessage = null
    this.sent = []
    FakeWebSocket.instances.push(this)
  }

  send(data) {
    this.sent.push(data)
  }
}
FakeWebSocket.OPEN = 1
FakeWebSocket.instances = []

async function loadEntry() {
  jest.resetModules()
  FakeWebSocket.instances = []
  global.WebSocket = FakeWebSocket

  await import('../../src/injected/entry.js')

  const [{ Recorder }, { Overlay }, { Controller }] = await Promise.all([
    import('../../src/injected/recorder.js'),
    import('../../src/injected/overlay.js'),
    import('../../src/injected/controller.js')
  ])

  return {
    Recorder,
    Overlay,
    Controller,
    recorderOpts: Recorder.mock.calls[0][0],
    overlayOpts: Overlay.mock.calls[0][0],
    controllerOpts: Controller.mock.calls[0][0],
    ws: FakeWebSocket.instances[0]
  }
}

describe('injected entry point', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    delete window.__sfRecorderInjected
    delete window.__sfRecorderConfig
    delete global.WebSocket
  })

  it('does nothing on a second injection into the same page', async () => {
    await loadEntry()
    expect(FakeWebSocket.instances.length).toBe(1)

    jest.resetModules()
    await import('../../src/injected/entry.js')

    expect(FakeWebSocket.instances.length).toBe(1)
  })

  it('opens a WebSocket to the configured port and mounts immediately when the DOM is already ready', async () => {
    window.__sfRecorderConfig = { wsPort: 4321, dataAttribute: 'data-rec' }

    const { ws, Overlay, Recorder, overlayOpts } = await loadEntry()

    expect(ws.url).toBe('ws://127.0.0.1:4321')
    expect(overlayOpts.state.dataAttribute).toBe('data-rec')
    expect(Overlay.mock.results[0].value.mount).toHaveBeenCalled()
    expect(Recorder.mock.results[0].value.init).toHaveBeenCalled()
  })

  it('defaults dataAttribute to an empty string when no config is present on the window', async () => {
    const { overlayOpts } = await loadEntry()

    expect(overlayOpts.state.dataAttribute).toBe('')
  })

  it('flushes queued messages once the socket opens', async () => {
    const { ws, overlayOpts } = await loadEntry()

    overlayOpts.sendOverlayAction('PAUSE')
    expect(ws.sent).toEqual([])

    ws.onopen()

    expect(ws.sent).toEqual([JSON.stringify({ _type: 'overlay-action', action: 'PAUSE' })])
  })

  it('sends immediately once the socket is open and ready', async () => {
    const { ws, overlayOpts } = await loadEntry()
    ws.onopen()

    overlayOpts.sendOverlayAction('STOP')

    expect(ws.sent).toEqual([JSON.stringify({ _type: 'overlay-action', action: 'STOP' })])
  })

  it('queues again after the socket closes, and reconnects after a delay', async () => {
    const { ws, overlayOpts } = await loadEntry()
    ws.onopen()
    ws.onclose()

    overlayOpts.sendOverlayAction('PAUSE')
    expect(ws.sent).toEqual([])
    expect(FakeWebSocket.instances.length).toBe(1)

    jest.advanceTimersByTime(1000)

    expect(FakeWebSocket.instances.length).toBe(2)
  })

  it('does not throw when onerror fires', async () => {
    const { ws } = await loadEntry()

    expect(() => ws.onerror()).not.toThrow()
  })

  it('dispatches a parsed message to the controller', async () => {
    const { ws, controllerOpts, Controller } = await loadEntry()

    ws.onmessage({ data: JSON.stringify({ action: 'PAUSE' }) })

    expect(Controller.mock.results[0].value.handleMessage).toHaveBeenCalledWith({ action: 'PAUSE' })
    expect(controllerOpts.state.isPaused).toBe(false)
  })

  it('silently ignores a message that is not valid JSON', async () => {
    const { ws, Controller } = await loadEntry()

    expect(() => ws.onmessage({ data: 'not json' })).not.toThrow()
    expect(Controller.mock.results[0].value.handleMessage).not.toHaveBeenCalled()
  })

  describe('DOM readiness', () => {
    let bodyDescriptor
    let readyStateDescriptor

    beforeEach(() => {
      bodyDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'body')
      readyStateDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'readyState')
    })

    afterEach(() => {
      delete document.body
      delete document.readyState
      if (bodyDescriptor) Object.defineProperty(Document.prototype, 'body', bodyDescriptor)
      if (readyStateDescriptor) Object.defineProperty(Document.prototype, 'readyState', readyStateDescriptor)
    })

    it('waits for DOMContentLoaded when the DOM is still loading', async () => {
      Object.defineProperty(document, 'body', { value: null, configurable: true })
      Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })

      const { Overlay, Recorder } = await loadEntry()

      expect(Overlay.mock.results[0].value.mount).not.toHaveBeenCalled()

      Object.defineProperty(document, 'body', { value: document.createElement('body'), configurable: true })
      document.dispatchEvent(new window.Event('DOMContentLoaded'))

      expect(Overlay.mock.results[0].value.mount).toHaveBeenCalled()
      expect(Recorder.mock.results[0].value.init).toHaveBeenCalled()
    })

    it('polls until the body appears when readyState is already interactive/complete', async () => {
      Object.defineProperty(document, 'body', { value: null, configurable: true })
      Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true })

      const { Overlay, Recorder } = await loadEntry()

      jest.advanceTimersByTime(10)
      expect(Overlay.mock.results[0].value.mount).not.toHaveBeenCalled()

      Object.defineProperty(document, 'body', { value: document.createElement('body'), configurable: true })
      jest.advanceTimersByTime(10)

      expect(Overlay.mock.results[0].value.mount).toHaveBeenCalledTimes(1)
      expect(Recorder.mock.results[0].value.init).toHaveBeenCalledTimes(1)

      jest.advanceTimersByTime(50)
      expect(Overlay.mock.results[0].value.mount).toHaveBeenCalledTimes(1)
    })
  })
})
