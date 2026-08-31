jest.mock('playwright', () => ({
  chromium: { executablePath: jest.fn(), launch: jest.fn(), launchPersistentContext: jest.fn() }
}))
jest.mock('../src/server.js', () => ({ createServer: jest.fn() }))
jest.mock('../src/build.js', () => ({ buildInjectedScript: jest.fn() }))
jest.mock('../src/playwright-converter.js', () => ({ convertToPlaywright: jest.fn() }))
jest.mock('../src/sf-cli.js', () => ({ getFrontdoorUrl: jest.fn(), sanitizeFrontdoor: jest.fn() }))
jest.mock('child_process', () => ({ execFileSync: jest.fn() }))
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  statSync: jest.fn(),
  readdirSync: jest.fn()
}))
jest.mock('chalk', () => ({ gray: (s) => s, yellow: (s) => s, green: (s) => s, blue: (s) => s }))

import { chromium } from 'playwright'
import fs from 'fs'
import { createServer } from '../src/server.js'
import { buildInjectedScript } from '../src/build.js'
import { convertToPlaywright } from '../src/playwright-converter.js'
import { startRecording } from '../src/index.js'
import { createFakeBrowser, createFakeServerInstance, flushAll, baseOptions } from './helpers/fakePlaywright.js'

describe('startRecording (CDP Page.frameNavigated handling)', () => {
  let exitSpy
  let fakeServerInstance
  let fakeBrowser

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {})
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {})

    fs.existsSync.mockReturnValue(true)
    buildInjectedScript.mockResolvedValue('/* injected */')
    fakeServerInstance = createFakeServerInstance()
    createServer.mockResolvedValue(fakeServerInstance)
    chromium.executablePath.mockReturnValue('/path/to/chromium')
    fakeBrowser = createFakeBrowser()
    chromium.launch.mockResolvedValue(fakeBrowser)
    convertToPlaywright.mockResolvedValue('// playwright script')
  })

  afterEach(() => {
    console.log.mockRestore()
    exitSpy.mockRestore()
    jest.clearAllMocks()
  })

  async function writtenUserFlow() {
    fakeServerInstance.events.emit('overlay-action', { action: 'STOP' })
    await flushAll(5)
    const call = fs.writeFileSync.mock.calls.find(([p]) => p.endsWith('recording.json'))
    return JSON.parse(call[1])
  }

  it('records a NAVIGATION assertion with the page title on a genuine top-frame navigation', async () => {
    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)

    const { _page: page, _cdpSession: cdpSession } = fakeBrowser._context
    page.title.mockClear()

    cdpSession.emit('Page.frameNavigated', { frame: { parentId: undefined, url: 'https://example.com/next-page' } })
    await flushAll(5)

    expect(page.title).toHaveBeenCalled()
    const flow = await writtenUserFlow()
    const gotoStep = flow.steps.find((s) => s.type === 'navigate')
    expect(gotoStep.assertedEvents[0]).toEqual({ type: 'navigation', url: 'https://example.com/next-page', title: 'Page Title' })
  })

  it('does not double-record a navigation to the same URL as the initial GOTO', async () => {
    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)

    const { _page: page, _cdpSession: cdpSession } = fakeBrowser._context
    page.title.mockClear()

    cdpSession.emit('Page.frameNavigated', { frame: { parentId: undefined, url: baseOptions.url } })
    await flushAll(5)

    expect(page.title).not.toHaveBeenCalled()
  })

  it('ignores a navigation to about:blank', async () => {
    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)

    const { _page: page, _cdpSession: cdpSession } = fakeBrowser._context
    page.title.mockClear()

    cdpSession.emit('Page.frameNavigated', { frame: { parentId: undefined, url: 'about:blank' } })
    await flushAll(5)

    expect(page.title).not.toHaveBeenCalled()
  })

  it('ignores navigations before the initial GOTO has been marked as recorded', async () => {
    const promise = startRecording({ ...baseOptions, url: 'about:blank' })
    promise.catch(() => {})
    await flushAll(5)

    const { _page: page, _cdpSession: cdpSession } = fakeBrowser._context
    page.title.mockClear()

    cdpSession.emit('Page.frameNavigated', { frame: { parentId: undefined, url: 'https://example.com/other' } })
    await flushAll(5)

    expect(page.title).not.toHaveBeenCalled()
  })

  it('ignores navigations inside a non-top-level frame', async () => {
    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)

    const { _page: page, _cdpSession: cdpSession } = fakeBrowser._context
    page.title.mockClear()

    cdpSession.emit('Page.frameNavigated', { frame: { parentId: 'parent-frame-1', url: 'https://example.com/in-iframe' } })
    await flushAll(5)

    expect(page.title).not.toHaveBeenCalled()
  })

  it('swallows an error from page.title() while the page is still loading and records an empty title', async () => {
    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)

    const { _page: page, _cdpSession: cdpSession } = fakeBrowser._context
    page.title.mockRejectedValueOnce(new Error('still loading'))

    cdpSession.emit('Page.frameNavigated', { frame: { parentId: undefined, url: 'https://example.com/next-page' } })
    await flushAll(5)

    const flow = await writtenUserFlow()
    const gotoStep = flow.steps.find((s) => s.type === 'navigate')
    expect(gotoStep.assertedEvents[0]).toEqual({ type: 'navigation', url: 'https://example.com/next-page', title: '' })
  })
})
