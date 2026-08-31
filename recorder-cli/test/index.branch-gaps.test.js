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

describe('startRecording (remaining generateUserFlow / filterSteps branch coverage)', () => {
  let exitSpy
  let fakeServerInstance
  let fakeBrowser

  beforeEach(async () => {
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

    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)
  })

  afterEach(() => {
    console.log.mockRestore()
    exitSpy.mockRestore()
    jest.clearAllMocks()
  })

  function emit(event) {
    fakeServerInstance.events.emit('message', { eventTime: Date.now(), ...event })
  }

  async function writtenUserFlow() {
    fakeServerInstance.events.emit('overlay-action', { action: 'STOP' })
    await flushAll(5)
    const call = fs.writeFileSync.mock.calls.find(([p]) => p.endsWith('recording.json'))
    return JSON.parse(call[1])
  }

  it('falls back to an empty selectors array for click/dblclick/assert events that carry none', async () => {
    emit({ action: 'click', tagName: 'BUTTON' })
    emit({ action: 'dblclick', tagName: 'DIV' })
    emit({ action: 'assert', tagName: 'SPAN' })

    const flow = await writtenUserFlow()

    expect(flow.steps.find((s) => s.type === 'click')).toMatchObject({ selectors: [] })
    expect(flow.steps.find((s) => s.type === 'doubleClick')).toMatchObject({ selectors: [] })
    expect(flow.steps.find((s) => s.type === 'assert')).toMatchObject({ selectors: [] })
  })

  it('records frameSelectors and frame index for a SELECT change that omits selectors', async () => {
    emit({ action: 'change', tagName: 'SELECT', value: 'opt2', frameSelectors: ['#f'], frameIndex: 4 })

    const flow = await writtenUserFlow()

    expect(flow.steps.find((s) => s.type === 'change' && s.tagName === 'SELECT')).toMatchObject({
      selectors: [],
      frameSelectors: ['#f'],
      frame: 4
    })
  })

  it('records frameSelectors and frame index for a plain (non-select) change that omits selectors', async () => {
    emit({ action: 'change', tagName: 'INPUT', inputType: 'text', value: 'plain', frameSelectors: ['#f'], frameIndex: 4 })

    const flow = await writtenUserFlow()

    expect(flow.steps.find((s) => s.type === 'change' && s.tagName === 'INPUT')).toMatchObject({
      selectors: [],
      frameSelectors: ['#f'],
      frame: 4
    })
  })

  it('records frameSelectors and frame index for a Tab-triggered keydown change that omits selectors', async () => {
    emit({ action: 'keydown', key: 'x', keyCode: 9, value: 'tabbed', tagName: 'INPUT', frameSelectors: ['#f'], frameIndex: 4 })

    const flow = await writtenUserFlow()

    expect(flow.steps.find((s) => s.type === 'change')).toMatchObject({
      selectors: [],
      frameSelectors: ['#f'],
      frame: 4
    })
  })

  it('records frameSelectors and frame index for a keyup value-change that omits selectors', async () => {
    emit({ action: 'keyup', key: 'y', value: 'restored', tagName: 'INPUT', frameSelectors: ['#f'], frameIndex: 4 })

    const flow = await writtenUserFlow()

    expect(flow.steps.find((s) => s.type === 'change')).toMatchObject({
      selectors: [],
      frameSelectors: ['#f'],
      frame: 4
    })
  })

  it('records frameSelectors and frame index for an input change that omits selectors', async () => {
    emit({ action: 'input', tagName: 'TEXTAREA', value: 'typed', frameSelectors: ['#f'], frameIndex: 4 })

    const flow = await writtenUserFlow()

    expect(flow.steps.find((s) => s.type === 'change')).toMatchObject({
      selectors: [],
      frameSelectors: ['#f'],
      frame: 4
    })
  })

  it('treats isSpecialKey(undefined) as false and still records a value-carrying keyup with no key', async () => {
    emit({ action: 'keyup', value: 'no-key-here', tagName: 'INPUT', selectors: [['#nokey']] })

    const flow = await writtenUserFlow()

    expect(flow.steps.find((s) => s.type === 'change')).toMatchObject({ value: 'no-key-here' })
  })

  it('keeps a standalone special-key keyUp that has no immediately-preceding matching keyDown', async () => {
    emit({ action: 'keyup', key: 'Escape' })

    const flow = await writtenUserFlow()

    expect(flow.steps).toContainEqual({ type: 'keyUp', target: 'main', key: 'Escape' })
  })

  it('ignores a NAVIGATION event when there are no prior steps at all (RESTART wiped everything, no viewport re-recorded)', async () => {
    fakeServerInstance.events.emit('overlay-action', { action: 'RESTART' })
    emit({ action: 'NAVIGATION', value: 'https://example.com/too-early', title: 'Too early' })

    const flow = await writtenUserFlow()

    expect(flow.steps).toEqual([])
  })

  it('ignores a WINDOW_OR_TAB_CLOSED event when there are no prior steps at all (RESTART wiped everything, no viewport re-recorded)', async () => {
    fakeServerInstance.events.emit('overlay-action', { action: 'RESTART' })
    emit({ action: 'WINDOW_OR_TAB_CLOSED', tabId: 'tab-1' })

    const flow = await writtenUserFlow()

    expect(flow.steps).toEqual([])
  })

  it('ignores a WINDOW_OR_TAB_CLOSED event when the only preceding step is the initial viewport', async () => {
    fakeServerInstance.events.emit('overlay-action', { action: 'RESTART' })
    fakeServerInstance.events.emit('message', { control: 'GET_VIEWPORT_SIZE' })
    emit({ action: 'WINDOW_OR_TAB_CLOSED', tabId: 'tab-1' })

    const flow = await writtenUserFlow()

    expect(flow.steps).toEqual([
      { type: 'setViewport', width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: false }
    ])
  })
})

describe('startRecording (GOTO title-update race and onBrowserClose conversion failure)', () => {
  let logSpy
  let exitSpy
  let fakeServerInstance
  let fakeBrowser

  beforeEach(() => {
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
  })

  afterEach(() => {
    logSpy.mockRestore()
    exitSpy.mockRestore()
    jest.clearAllMocks()
  })

  it('skips the GOTO title update when a competing event lands between page.goto() and page.title() resolving', async () => {
    const { _page: page } = fakeBrowser._context
    page.goto.mockImplementation(async () => {
      fakeServerInstance.events.emit('message', {
        action: 'click', selectors: [['#race']], tagName: 'BUTTON', eventTime: Date.now()
      })
    })

    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)

    fakeServerInstance.events.emit('overlay-action', { action: 'STOP' })
    await flushAll(5)

    const call = fs.writeFileSync.mock.calls.find(([p]) => p.endsWith('recording.json'))
    const flow = JSON.parse(call[1])

    expect(flow.steps.some((s) => s.type === 'click')).toBe(true)
    const gotoStep = flow.steps.find((s) => s.type === 'navigate')
    expect(gotoStep.assertedEvents[0].title).toBe('')
  })

  it('skips saving entirely on an abrupt close when RESTART left the recording empty', async () => {
    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)

    fakeServerInstance.events.emit('overlay-action', { action: 'RESTART' })
    fakeBrowser.emit('disconnected')
    await flushAll(5)

    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(fakeServerInstance.server.close).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
    const text = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(text).not.toContain('Browser closed. Saving recording')
  })

  it('re-injects the recorder as a safety net 100ms after a frame navigation', async () => {
    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)

    const { _cdpSession: cdpSession } = fakeBrowser._context
    cdpSession.send.mockClear()
    cdpSession.emit('Page.frameNavigated', { frame: { parentId: undefined, url: 'https://example.com/next-page' } })
    await flushAll(5)
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(cdpSession.send).toHaveBeenCalledWith('Page.getFrameTree')
    expect(cdpSession.send).toHaveBeenCalledWith(
      'Page.createIsolatedWorld',
      expect.objectContaining({ worldName: 'SalesforceRecorderIsolated' })
    )
  })

  it('warns but still saves the JSON when Playwright conversion fails during an abrupt browser close', async () => {
    convertToPlaywright.mockRejectedValue(new Error('conversion service unavailable'))

    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)

    fakeBrowser.emit('disconnected')
    await flushAll(5)

    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('recording.json'), expect.any(String))
    expect(fs.writeFileSync).not.toHaveBeenCalledWith(expect.stringContaining('recording.spec.js'), expect.any(String))
    const text = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(text).toContain('Playwright conversion failed: conversion service unavailable')
  })
})

// index.js:467 (`if (gotoStep) gotoStep.title = title`) is structurally dead on its
// false side: the enclosing guard at line 465 only enters this block when
// `recording[recording.length - 1]` or `recording[0]` already has `action === 'GOTO'`,
// and `recording.find(r => r.action === 'GOTO')` searches that same array - so it is
// guaranteed to find at least the very entry the guard already matched. There is no
// way to make the outer guard true while `gotoStep` comes back undefined.
