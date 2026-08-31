import { EventEmitter } from 'events'

export function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

export async function flushAll(times = 3) {
  for (let i = 0; i < times; i++) await flush()
}

export function createFakeCdpSession() {
  const emitter = new EventEmitter()
  const send = jest.fn(async (method) => {
    switch (method) {
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'frame-1' } } }
      case 'Page.createIsolatedWorld':
        return { executionContextId: 1 }
      default:
        return {}
    }
  })
  return {
    send,
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter)
  }
}

export function createFakePage(cdpSession) {
  return {
    title: jest.fn().mockResolvedValue('Page Title'),
    goto: jest.fn().mockResolvedValue(undefined),
    newCDPSession: jest.fn().mockResolvedValue(cdpSession)
  }
}

export function createFakeContext({ pages = [] } = {}) {
  const emitter = new EventEmitter()
  const cdpSession = createFakeCdpSession()
  const page = createFakePage(cdpSession)
  return {
    _cdpSession: cdpSession,
    _page: page,
    pages: jest.fn(() => pages),
    newPage: jest.fn().mockResolvedValue(page),
    newCDPSession: jest.fn().mockResolvedValue(cdpSession),
    storageState: jest.fn().mockResolvedValue({ cookies: [], origins: [] }),
    close: jest.fn().mockResolvedValue(undefined),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter)
  }
}

export function createFakeBrowser() {
  const emitter = new EventEmitter()
  const context = createFakeContext()
  return {
    _context: context,
    newContext: jest.fn().mockResolvedValue(context),
    close: jest.fn().mockResolvedValue(undefined),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter)
  }
}

export function createFakeServerInstance() {
  const events = new EventEmitter()
  return {
    server: { close: jest.fn() },
    port: 54321,
    events,
    broadcast: jest.fn(),
    clients: new Set()
  }
}

export const baseOptions = {
  url: 'https://example.com/start',
  output: './out/recording.json',
  headless: true,
  browser: 'chromium',
  dataAttribute: '',
  viewportWidth: '1280',
  viewportHeight: '720'
}
