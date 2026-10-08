import { EventEmitter } from 'events'

export function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

export async function flushAll(times = 3) {
  for (let i = 0; i < times; i++) await flush()
}

export function createFakeCdpSession({ frameId = 'frame-1', url = 'about:blank', loaderId = 'loader-1' } = {}) {
  const emitter = new EventEmitter()
  const frame = { id: frameId, url, loaderId }
  const send = jest.fn(async (method) => {
    switch (method) {
      case 'Page.getFrameTree':
        return { frameTree: { frame: { ...frame } } }
      case 'Page.createIsolatedWorld':
        return { executionContextId: 1 }
      default:
        return {}
    }
  })
  return {
    send,
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    _frame: frame
  }
}

export function createFakePage(cdpSession = createFakeCdpSession(), { url = 'about:blank' } = {}) {
  const emitter = new EventEmitter()
  let currentUrl = url
  let closed = false
  const page = {
    _cdpSession: cdpSession,
    title: jest.fn().mockResolvedValue('Page Title'),
    goto: jest.fn(async (nextUrl) => { currentUrl = nextUrl }),
    waitForLoadState: jest.fn().mockResolvedValue(undefined),
    newCDPSession: jest.fn().mockResolvedValue(cdpSession),
    url: jest.fn(() => currentUrl),
    isClosed: jest.fn(() => closed),
    opener: jest.fn().mockResolvedValue(null),
    close: jest.fn(async () => {
      if (closed) return
      closed = true
      emitter.emit('close')
    }),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    _setUrl(nextUrl) {
      currentUrl = nextUrl
      cdpSession._frame.url = nextUrl
    }
  }
  return page
}

export function createFakeContext({ pages = [] } = {}) {
  const emitter = new EventEmitter()
  const cdpSession = createFakeCdpSession()
  const page = createFakePage(cdpSession)
  const currentPages = [...pages]
  const context = {
    _cdpSession: cdpSession,
    _page: page,
    _pages: currentPages,
    pages: jest.fn(() => currentPages),
    newPage: jest.fn(async () => {
      if (!currentPages.includes(page)) currentPages.push(page)
      return page
    }),
    newCDPSession: jest.fn(async (targetPage) => targetPage?._cdpSession || cdpSession),
    storageState: jest.fn().mockResolvedValue({ cookies: [], origins: [] }),
    close: jest.fn().mockResolvedValue(undefined),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    openPopup({
      url = 'about:blank',
      loaderId = `loader-${currentPages.length + 2}`,
      opener = page
    } = {}) {
      const popupCdpSession = createFakeCdpSession({
        frameId: `frame-${currentPages.length + 2}`,
        url,
        loaderId
      })
      const popup = createFakePage(popupCdpSession, { url })
      popup.opener.mockResolvedValue(opener)
      currentPages.push(popup)
      emitter.emit('page', popup)
      return popup
    }
  }
  return context
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
