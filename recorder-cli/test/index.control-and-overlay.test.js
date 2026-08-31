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

describe('startRecording (control messages and overlay actions)', () => {
  let logSpy
  let exitSpy
  let fakeServerInstance
  let fakeBrowser

  beforeEach(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {})

    fs.existsSync.mockReturnValue(true)
    buildInjectedScript.mockResolvedValue('/* injected */')
    fakeServerInstance = createFakeServerInstance()
    createServer.mockResolvedValue(fakeServerInstance)
    chromium.executablePath.mockReturnValue('/path/to/chromium')
    fakeBrowser = createFakeBrowser()
    chromium.launch.mockResolvedValue(fakeBrowser)
    convertToPlaywright.mockResolvedValue('// playwright script')

    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)
  })

  afterEach(() => {
    logSpy.mockRestore()
    exitSpy.mockRestore()
    jest.clearAllMocks()
  })

  function loggedText() {
    return logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
  }

  async function writtenUserFlow() {
    fakeServerInstance.events.emit('overlay-action', { action: 'STOP' })
    await flushAll(5)
    const call = fs.writeFileSync.mock.calls.find(([p]) => p.endsWith('recording.json'))
    return JSON.parse(call[1])
  }

  it('ignores an EVENT_RECORDER_STARTED control message', async () => {
    fakeServerInstance.events.emit('message', { control: 'EVENT_RECORDER_STARTED' })
    const flow = await writtenUserFlow()

    expect(flow.steps).toHaveLength(2)
    expect(flow.steps[0].type).toBe('setViewport')
    expect(flow.steps[1].type).toBe('navigate')
  })

  it('does not push a duplicate viewport for GET_VIEWPORT_SIZE when one was already recorded', async () => {
    fakeServerInstance.events.emit('message', { control: 'GET_VIEWPORT_SIZE' })
    const flow = await writtenUserFlow()

    expect(flow.steps.filter((s) => s.type === 'setViewport')).toHaveLength(1)
  })

  it('re-records the viewport for GET_VIEWPORT_SIZE after a RESTART cleared it', async () => {
    fakeServerInstance.events.emit('overlay-action', { action: 'RESTART' })
    fakeServerInstance.events.emit('message', { control: 'GET_VIEWPORT_SIZE' })
    const flow = await writtenUserFlow()

    expect(flow.steps).toHaveLength(1)
    expect(flow.steps[0].type).toBe('setViewport')
    expect(loggedText()).toContain('Recording restarted')
  })

  it('marks GOTO as already recorded via GET_CURRENT_URL, enabling later navigation tracking', async () => {
    fakeServerInstance.events.emit('overlay-action', { action: 'RESTART' })
    fakeServerInstance.events.emit('message', { control: 'GET_CURRENT_URL' })

    const { _page: page, _cdpSession: cdpSession } = fakeBrowser._context
    page.title.mockClear()
    cdpSession.emit('Page.frameNavigated', { frame: { parentId: undefined, url: 'https://example.com/after-restart' } })
    await flushAll(5)

    expect(page.title).toHaveBeenCalled()
  })

  it('records a screenshot step with a selector when GET_SCREENSHOT carries a value', async () => {
    fakeServerInstance.events.emit('message', { control: 'GET_SCREENSHOT', value: 'shot-1' })
    const flow = await writtenUserFlow()

    expect(flow.steps).toContainEqual({ type: 'screenshot', target: 'main', selector: 'shot-1' })
  })

  it('records a screenshot step without a selector when GET_SCREENSHOT carries no value', async () => {
    fakeServerInstance.events.emit('message', { control: 'GET_SCREENSHOT' })
    const flow = await writtenUserFlow()

    expect(flow.steps).toContainEqual({ type: 'screenshot', target: 'main' })
  })

  it('drops incoming messages while paused, and resumes recording after UNPAUSE', async () => {
    fakeServerInstance.events.emit('overlay-action', { action: 'PAUSE' })
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#while-paused']], tagName: 'BUTTON', eventTime: Date.now()
    })
    fakeServerInstance.events.emit('overlay-action', { action: 'UNPAUSE' })
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#after-unpause']], tagName: 'BUTTON', eventTime: Date.now()
    })

    const flow = await writtenUserFlow()

    const clicks = flow.steps.filter((s) => s.type === 'click')
    expect(clicks).toHaveLength(1)
    expect(clicks[0].selectors).toEqual([['#after-unpause']])
    const text = loggedText()
    expect(text).toContain('Recording paused')
    expect(text).toContain('Recording resumed')
  })

  it('clears all prior state on RESTART', async () => {
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#before-restart']], tagName: 'BUTTON', eventTime: Date.now()
    })
    fakeServerInstance.events.emit('overlay-action', { action: 'RESTART' })

    const flow = await writtenUserFlow()

    expect(flow.steps).toHaveLength(0)
  })
})
