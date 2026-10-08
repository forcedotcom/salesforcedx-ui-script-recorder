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

  it('records a navigation marker before its asynchronous title lookup resolves', async () => {
    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#trigger-navigation']], tagName: 'A', eventTime: firstEventTime
    })

    const { _page: page, _cdpSession: cdpSession } = fakeBrowser._context
    let resolveTitle
    page.title.mockReturnValueOnce(new Promise((resolve) => { resolveTitle = resolve }))
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(firstEventTime + 1000)
    cdpSession.emit('Page.frameNavigated', {
      frame: { parentId: undefined, url: 'https://example.com/loaded' }
    })
    await flushAll(1)
    nowSpy.mockRestore()

    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#after-navigation']], tagName: 'BUTTON', eventTime: firstEventTime + 5000
    })
    resolveTitle('Loaded')
    await flushAll(2)

    const flow = await writtenUserFlow()
    const trigger = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#trigger-navigation')
    const afterNavigation = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#after-navigation')

    expect(trigger.assertedEvents).toEqual([
      { type: 'navigation', url: 'https://example.com/loaded', title: 'Loaded' }
    ])
    expect(afterNavigation.assertedEvents).toBeUndefined()
    expect(afterNavigation.duration).toBe(4000)
  })

  it('attaches navigation to an earlier action whose WebSocket message arrives late', async () => {
    const firstEventTime = Date.now()
    const { _cdpSession: cdpSession } = fakeBrowser._context
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(firstEventTime + 1000)

    cdpSession.emit('Page.frameStartedLoading', { frameId: 'frame-1' })
    cdpSession.emit('Page.frameNavigated', {
      frame: {
        id: 'frame-1',
        parentId: undefined,
        url: 'https://example.com/ws-overtaken',
        loaderId: 'ws-overtaken-loader'
      }
    })
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#late-trigger-message']],
      tagName: 'A',
      eventTime: firstEventTime,
      orderEventTime: firstEventTime,
      tabId: 'tab-1'
    })
    await flushAll(3)
    nowSpy.mockRestore()

    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#after-overtaken-navigation']],
      tagName: 'BUTTON',
      eventTime: firstEventTime + 2500,
      tabId: 'tab-1'
    })

    const flow = await writtenUserFlow()
    const trigger = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#late-trigger-message')
    const afterNavigation = flow.steps.find(
      (step) => step.selectors?.[0]?.[0] === '#after-overtaken-navigation'
    )

    expect(trigger.assertedEvents).toEqual([{
      type: 'navigation',
      url: 'https://example.com/ws-overtaken',
      title: 'Page Title'
    }])
    expect(afterNavigation.assertedEvents).toBeUndefined()
    expect(afterNavigation.duration).toBe(1500)
  })

  it('keeps navigation at its start position when the commit callback arrives late', async () => {
    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#trigger-delayed-commit']],
      tagName: 'A',
      eventTime: firstEventTime,
      tabId: 'tab-1'
    })

    const { _cdpSession: cdpSession } = fakeBrowser._context
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(firstEventTime + 100)
    cdpSession.emit('Page.frameStartedLoading', { frameId: 'frame-1' })
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#post-navigation-message-delivered-first']],
      tagName: 'BUTTON',
      eventTime: firstEventTime + 500,
      tabId: 'tab-1'
    })

    nowSpy.mockReturnValue(firstEventTime + 600)
    cdpSession.emit('Page.frameNavigated', {
      frame: {
        id: 'frame-1',
        parentId: undefined,
        url: 'https://example.com/delayed-commit',
        loaderId: 'delayed-commit-loader'
      }
    })
    await flushAll(3)
    nowSpy.mockRestore()

    const flow = await writtenUserFlow()
    const trigger = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#trigger-delayed-commit')
    const postNavigation = flow.steps.find(
      (step) => step.selectors?.[0]?.[0] === '#post-navigation-message-delivered-first'
    )

    expect(trigger.assertedEvents).toEqual([{
      type: 'navigation',
      url: 'https://example.com/delayed-commit',
      title: 'Page Title'
    }])
    expect(postNavigation.assertedEvents).toBeUndefined()
    expect(postNavigation.duration).toBe(0)
  })

  it('uses a superseding loader as the causal start of the surviving navigation', async () => {
    const firstEventTime = Date.now()
    const { _cdpSession: cdpSession } = fakeBrowser._context
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#first-trigger']], tagName: 'A',
      eventTime: firstEventTime + 100, tabId: 'tab-1'
    })

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(firstEventTime + 150)
    cdpSession.emit('Page.frameStartedNavigating', {
      frameId: 'frame-1', loaderId: 'superseded-loader', navigationType: 'differentDocument'
    })
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#second-trigger']], tagName: 'A',
      eventTime: firstEventTime + 200, tabId: 'tab-1'
    })

    nowSpy.mockReturnValue(firstEventTime + 250)
    cdpSession.emit('Page.frameStartedNavigating', {
      frameId: 'frame-1', loaderId: 'surviving-loader', navigationType: 'differentDocument'
    })
    nowSpy.mockReturnValue(firstEventTime + 300)
    cdpSession.emit('Page.frameNavigated', {
      frame: {
        id: 'frame-1', parentId: undefined, url: 'https://example.com/surviving',
        loaderId: 'surviving-loader'
      }
    })
    await flushAll(3)
    nowSpy.mockRestore()

    const flow = await writtenUserFlow()
    const firstTrigger = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#first-trigger')
    const secondTrigger = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#second-trigger')

    expect(firstTrigger.assertedEvents).toBeUndefined()
    expect(secondTrigger.assertedEvents).toEqual([{
      type: 'navigation',
      url: 'https://example.com/surviving',
      title: 'Page Title'
    }])
  })

  it('records popup actions and a manual close with a stable tab id', async () => {
    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#open-popup-live']],
      tagName: 'BUTTON',
      eventTime: firstEventTime,
      tabId: 'tab-1'
    })

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(firstEventTime + 100)
    const popup = fakeBrowser._context.openPopup({
      url: 'https://example.com/popup',
      loaderId: 'popup-loader'
    })
    await flushAll(5)

    // A late duplicate for the loader already discovered through getFrameTree
    // must not produce a second popup navigation assertion.
    popup._cdpSession.emit('Page.frameNavigated', {
      frame: { id: 'frame-3', url: 'https://example.com/popup', loaderId: 'popup-loader' }
    })
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#inside-live-popup']],
      tagName: 'BUTTON',
      eventTime: firstEventTime + 1000,
      tabId: 'tab-2'
    })

    nowSpy.mockReturnValue(firstEventTime + 5000)
    await popup.close()
    nowSpy.mockRestore()

    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#after-live-popup']],
      tagName: 'BUTTON',
      eventTime: firstEventTime + 6000,
      tabId: 'tab-1'
    })

    const flow = await writtenUserFlow()
    const openPopup = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#open-popup-live')
    const insidePopup = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#inside-live-popup')
    const closePopup = flow.steps.find((step) => step.type === 'close' && step.tabId === 'tab-2')
    const afterPopup = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#after-live-popup')
    const popupInjection = popup._cdpSession.send.mock.calls.find(
      ([method]) => method === 'Page.addScriptToEvaluateOnNewDocument'
    )

    expect(popupInjection[1].source).toContain('tabId: "tab-2"')
    expect(openPopup.assertedEvents).toEqual([{
      type: 'navigation',
      url: 'https://example.com/popup',
      title: 'Page Title',
      isNewTabOrWindow: true,
      targetTabId: 'tab-2'
    }])
    expect(insidePopup.assertedEvents).toBeUndefined()
    expect(closePopup).toMatchObject({ type: 'close', tabId: 'tab-2', duration: 4000 })
    expect(afterPopup.duration).toBe(1000)
  })

  it('orders a popup lifecycle around delayed WebSocket action delivery', async () => {
    const firstEventTime = Date.now()
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(firstEventTime + 100)

    // The context event can arrive before the click crosses the WebSocket.
    const popup = fakeBrowser._context.openPopup({
      url: 'https://example.com/racy-popup',
      loaderId: 'racy-popup-loader'
    })
    await flushAll(5)
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#open-racy-popup']],
      tagName: 'BUTTON',
      eventTime: firstEventTime,
      tabId: 'tab-1'
    })

    // The native close can likewise overtake the popup's last action message.
    nowSpy.mockReturnValue(firstEventTime + 5000)
    await popup.close()
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#last-racy-popup-action']],
      tagName: 'BUTTON',
      eventTime: firstEventTime + 1000,
      tabId: 'tab-2'
    })
    nowSpy.mockRestore()

    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#after-racy-popup']],
      tagName: 'BUTTON',
      eventTime: firstEventTime + 6000,
      tabId: 'tab-1'
    })

    const flow = await writtenUserFlow()
    const openPopup = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#open-racy-popup')
    const lastPopupAction = flow.steps.find(
      (step) => step.selectors?.[0]?.[0] === '#last-racy-popup-action'
    )
    const closePopup = flow.steps.find((step) => step.type === 'close' && step.tabId === 'tab-2')
    const afterPopup = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#after-racy-popup')

    expect(openPopup.assertedEvents).toEqual([{
      type: 'navigation',
      url: 'https://example.com/racy-popup',
      title: 'Page Title',
      isNewTabOrWindow: true,
      targetTabId: 'tab-2'
    }])
    expect(lastPopupAction.assertedEvents).toBeUndefined()
    expect(closePopup).toMatchObject({ type: 'close', tabId: 'tab-2', duration: 4000 })
    expect(afterPopup.duration).toBe(1000)
  })

  it('does not leave an orphan close for a popup created entirely while paused', async () => {
    fakeServerInstance.events.emit('overlay-action', { action: 'PAUSE' })
    const popup = fakeBrowser._context.openPopup({ url: 'https://example.com/ignored-popup' })
    await flushAll(3)
    await popup.close()
    fakeServerInstance.events.emit('overlay-action', { action: 'UNPAUSE' })

    const flow = await writtenUserFlow()

    expect(flow.steps.some((step) => step.type === 'close' || step.assertedEvents?.some(
      (event) => event.url === 'https://example.com/ignored-popup' || event.type === 'windowOrTabClose'
    ))).toBe(false)
  })

  it('ignores a child popup whose opener was created while recording was paused', async () => {
    fakeServerInstance.events.emit('overlay-action', { action: 'PAUSE' })
    const ignoredParent = fakeBrowser._context.openPopup({
      url: 'https://example.com/ignored-parent'
    })
    await flushAll(4)
    fakeServerInstance.events.emit('overlay-action', { action: 'UNPAUSE' })

    const ignoredChild = fakeBrowser._context.openPopup({
      url: 'https://example.com/ignored-child',
      opener: ignoredParent
    })
    await flushAll(4)
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#inside-ignored-child']],
      tagName: 'BUTTON',
      eventTime: Date.now(),
      tabId: 'tab-3'
    })
    await ignoredChild.close()
    await ignoredParent.close()

    const flow = await writtenUserFlow()

    expect(flow.steps.some((step) =>
      step.type === 'close' ||
      step.selectors?.[0]?.[0] === '#inside-ignored-child' ||
      step.assertedEvents?.some((event) =>
        event.url === 'https://example.com/ignored-parent' ||
        event.url === 'https://example.com/ignored-child'
      )
    )).toBe(false)
  })

  it('keeps a recorded popup close structural while excluding paused dwell', async () => {
    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#open-before-pause']],
      tagName: 'BUTTON',
      eventTime: firstEventTime,
      tabId: 'tab-1'
    })

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(firstEventTime + 100)
    const popup = fakeBrowser._context.openPopup({ url: 'https://example.com/pause-popup' })
    await flushAll(5)
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#inside-before-pause']],
      tagName: 'BUTTON',
      eventTime: firstEventTime + 500,
      tabId: 'tab-2'
    })

    nowSpy.mockReturnValue(firstEventTime + 1000)
    fakeServerInstance.events.emit('overlay-action', { action: 'PAUSE' })
    nowSpy.mockReturnValue(firstEventTime + 5000)
    await popup.close()
    nowSpy.mockReturnValue(firstEventTime + 6000)
    fakeServerInstance.events.emit('overlay-action', { action: 'UNPAUSE' })
    nowSpy.mockRestore()

    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#after-paused-close']],
      tagName: 'BUTTON',
      eventTime: firstEventTime + 6500,
      tabId: 'tab-1'
    })

    const flow = await writtenUserFlow()
    const insidePopup = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#inside-before-pause')
    const closePopup = flow.steps.find((step) => step.type === 'close' && step.tabId === 'tab-2')
    const afterPopup = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#after-paused-close')

    expect(insidePopup.assertedEvents).toBeUndefined()
    expect(closePopup).toMatchObject({ type: 'close', tabId: 'tab-2', duration: 500 })
    expect(afterPopup.duration).toBe(500)
  })

  it('retains navigation completion for an action recorded before a pause', async () => {
    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#before-pause-navigation']], tagName: 'A', eventTime: firstEventTime
    })

    const nowSpy = jest.spyOn(Date, 'now')
    const { _cdpSession: cdpSession } = fakeBrowser._context
    cdpSession.emit('Page.frameRequestedNavigation', { frameId: 'frame-1' })
    nowSpy.mockReturnValue(firstEventTime + 100)
    fakeServerInstance.events.emit('overlay-action', { action: 'PAUSE' })

    nowSpy.mockReturnValue(firstEventTime + 600)
    cdpSession.emit('Page.frameNavigated', {
      frame: { parentId: undefined, url: 'https://example.com/paused-load' }
    })
    await flushAll(2)

    nowSpy.mockReturnValue(firstEventTime + 1100)
    fakeServerInstance.events.emit('overlay-action', { action: 'UNPAUSE' })
    nowSpy.mockRestore()

    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#after-pause-navigation']], tagName: 'BUTTON', eventTime: firstEventTime + 1300
    })

    const flow = await writtenUserFlow()
    const trigger = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#before-pause-navigation')
    const afterNavigation = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#after-pause-navigation')

    expect(trigger.assertedEvents).toEqual([
      { type: 'navigation', url: 'https://example.com/paused-load', title: 'Page Title' }
    ])
    expect(afterNavigation.duration).toBe(200)
  })

  it('does not attach a navigation initiated while recording is paused', async () => {
    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#before-paused-navigation']], tagName: 'BUTTON', eventTime: firstEventTime
    })

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(firstEventTime + 100)
    fakeServerInstance.events.emit('overlay-action', { action: 'PAUSE' })

    const { _cdpSession: cdpSession } = fakeBrowser._context
    cdpSession.emit('Page.frameStartedLoading', { frameId: 'frame-1' })
    cdpSession.emit('Page.frameNavigated', {
      frame: { id: 'frame-1', parentId: undefined, url: 'https://example.com/paused-only' }
    })
    cdpSession.emit('Page.frameStoppedLoading', { frameId: 'frame-1' })

    nowSpy.mockReturnValue(firstEventTime + 1100)
    fakeServerInstance.events.emit('overlay-action', { action: 'UNPAUSE' })
    nowSpy.mockRestore()

    const flow = await writtenUserFlow()
    const beforePause = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#before-paused-navigation')

    expect(beforePause.assertedEvents).toBeUndefined()
  })

  it('does not attach a paused navigation that commits only after recording resumes', async () => {
    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#unrelated-before-pause']], tagName: 'BUTTON', eventTime: firstEventTime
    })

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(firstEventTime + 100)
    fakeServerInstance.events.emit('overlay-action', { action: 'PAUSE' })

    const { _cdpSession: cdpSession } = fakeBrowser._context
    cdpSession.emit('Page.frameStartedLoading', { frameId: 'frame-1' })

    nowSpy.mockReturnValue(firstEventTime + 1100)
    fakeServerInstance.events.emit('overlay-action', { action: 'UNPAUSE' })
    nowSpy.mockRestore()

    cdpSession.emit('Page.frameNavigated', {
      frame: { id: 'frame-1', parentId: undefined, url: 'https://example.com/paused-then-resumed' }
    })
    cdpSession.emit('Page.frameStoppedLoading', { frameId: 'frame-1' })

    const flow = await writtenUserFlow()
    const beforePause = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#unrelated-before-pause')

    expect(beforePause.assertedEvents).toBeUndefined()
  })

  it('clears cancelled navigation provenance before the next real navigation', async () => {
    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#before-real-navigation']], tagName: 'BUTTON', eventTime: firstEventTime
    })

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(firstEventTime + 100)
    fakeServerInstance.events.emit('overlay-action', { action: 'PAUSE' })

    const { _cdpSession: cdpSession } = fakeBrowser._context
    cdpSession.emit('Page.frameRequestedNavigation', { frameId: 'frame-1' })
    cdpSession.emit('Page.frameClearedScheduledNavigation', { frameId: 'frame-1' })

    nowSpy.mockReturnValue(firstEventTime + 200)
    fakeServerInstance.events.emit('overlay-action', { action: 'UNPAUSE' })
    nowSpy.mockRestore()

    cdpSession.emit('Page.frameStartedLoading', { frameId: 'frame-1' })
    cdpSession.emit('Page.frameNavigated', {
      frame: { id: 'frame-1', parentId: undefined, url: 'https://example.com/real-navigation' }
    })
    await flushAll(2)

    const flow = await writtenUserFlow()
    const trigger = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#before-real-navigation')

    expect(trigger.assertedEvents).toEqual([
      { type: 'navigation', url: 'https://example.com/real-navigation', title: 'Page Title' }
    ])
  })

  it('records a browser-initiated reload with separate start and completion timing', async () => {
    const firstEventTime = Date.now()
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(firstEventTime)
    const { _cdpSession: cdpSession } = fakeBrowser._context

    cdpSession.emit('Page.frameStartedNavigating', {
      frameId: 'frame-1',
      url: baseOptions.url,
      loaderId: 'reload-loader',
      navigationType: 'reload'
    })
    nowSpy.mockReturnValue(firstEventTime + 500)
    cdpSession.emit('Page.frameNavigated', {
      frame: {
        id: 'frame-1',
        parentId: undefined,
        url: baseOptions.url,
        loaderId: 'reload-loader'
      }
    })
    await flushAll(2)
    nowSpy.mockRestore()

    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#after-browser-reload']],
      tagName: 'BUTTON',
      eventTime: firstEventTime + 1000,
      tabId: 'tab-1'
    })

    const flow = await writtenUserFlow()
    const reload = flow.steps.find((step) => step.type === 'reload')
    const afterReload = flow.steps.find(
      (step) => step.selectors?.[0]?.[0] === '#after-browser-reload'
    )

    expect(reload.assertedEvents).toEqual([
      { type: 'navigation', url: baseOptions.url, title: 'Page Title' }
    ])
    expect(afterReload.duration).toBe(500)
  })

  it('does not let a non-current-tab navigation request hide a main-page browser reload', async () => {
    const { _cdpSession: cdpSession } = fakeBrowser._context
    cdpSession.emit('Page.frameRequestedNavigation', {
      frameId: 'frame-1',
      disposition: 'newWindow'
    })
    cdpSession.emit('Page.frameStartedNavigating', {
      frameId: 'frame-1',
      url: baseOptions.url,
      loaderId: 'main-reload-after-new-window',
      navigationType: 'reload'
    })

    const flow = await writtenUserFlow()

    expect(flow.steps.filter((step) => step.type === 'reload')).toHaveLength(1)
  })

  it('records a main-page reload that supersedes an unfinished renderer navigation', async () => {
    const { _cdpSession: cdpSession } = fakeBrowser._context
    cdpSession.emit('Page.frameRequestedNavigation', {
      frameId: 'frame-1', disposition: 'currentTab'
    })
    cdpSession.emit('Page.frameStartedNavigating', {
      frameId: 'frame-1', loaderId: 'renderer-loader', navigationType: 'differentDocument'
    })
    cdpSession.emit('Page.frameStartedNavigating', {
      frameId: 'frame-1', loaderId: 'superseding-reload-loader', navigationType: 'reload'
    })

    const flow = await writtenUserFlow()

    expect(flow.steps.filter((step) => step.type === 'reload')).toHaveLength(1)
  })

  it('does not let a non-current-tab navigation request hide a popup browser reload', async () => {
    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#open-reload-popup']],
      tagName: 'BUTTON',
      eventTime: firstEventTime,
      tabId: 'tab-1'
    })
    const popup = fakeBrowser._context.openPopup({ url: 'https://example.com/reload-popup' })
    await flushAll(5)

    const popupFrameId = popup._cdpSession._frame.id
    popup._cdpSession.emit('Page.frameRequestedNavigation', {
      frameId: popupFrameId,
      disposition: 'newTab'
    })
    popup._cdpSession.emit('Page.frameStartedNavigating', {
      frameId: popupFrameId,
      url: 'https://example.com/reload-popup',
      loaderId: 'popup-reload-after-new-tab',
      navigationType: 'reload'
    })

    const flow = await writtenUserFlow()

    expect(flow.steps.filter((step) => step.type === 'reload')).toHaveLength(1)
  })

  it('records a popup reload that supersedes an unfinished renderer navigation', async () => {
    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#open-superseded-popup']], tagName: 'BUTTON',
      eventTime: firstEventTime, tabId: 'tab-1'
    })
    const popup = fakeBrowser._context.openPopup({ url: 'https://example.com/reload-popup' })
    await flushAll(5)

    const popupFrameId = popup._cdpSession._frame.id
    popup._cdpSession.emit('Page.frameRequestedNavigation', {
      frameId: popupFrameId, disposition: 'currentTab'
    })
    popup._cdpSession.emit('Page.frameStartedNavigating', {
      frameId: popupFrameId, loaderId: 'popup-renderer-loader', navigationType: 'differentDocument'
    })
    popup._cdpSession.emit('Page.frameStartedNavigating', {
      frameId: popupFrameId, loaderId: 'popup-superseding-reload-loader', navigationType: 'reload'
    })

    const flow = await writtenUserFlow()

    expect(flow.steps.filter((step) => step.type === 'reload')).toHaveLength(1)
  })

  it('keeps a renderer-initiated reload attached to its triggering action', async () => {
    const firstEventTime = Date.now()
    const { _cdpSession: cdpSession } = fakeBrowser._context
    cdpSession.emit('Page.frameNavigated', {
      frame: { id: 'frame-1', parentId: undefined, url: baseOptions.url, loaderId: 'initial-loader' }
    })
    await flushAll(1)

    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#trigger-script-reload']],
      tagName: 'BUTTON',
      eventTime: firstEventTime,
      tabId: 'tab-1'
    })

    cdpSession.emit('Page.frameRequestedNavigation', {
      frameId: 'frame-1',
      reason: 'scriptInitiated',
      url: baseOptions.url
    })
    cdpSession.emit('Page.frameStartedNavigating', {
      frameId: 'frame-1',
      url: baseOptions.url,
      loaderId: 'script-reload-loader',
      navigationType: 'reload'
    })
    cdpSession.emit('Page.frameNavigated', {
      frame: {
        id: 'frame-1',
        parentId: undefined,
        url: baseOptions.url,
        loaderId: 'script-reload-loader'
      }
    })
    await flushAll(2)

    const flow = await writtenUserFlow()
    const trigger = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#trigger-script-reload')

    expect(flow.steps.some((step) => step.type === 'reload')).toBe(false)
    expect(trigger.assertedEvents).toEqual([
      { type: 'navigation', url: baseOptions.url, title: 'Page Title' }
    ])
  })

  it('falls back to event-driven waiting when recording stops before navigation completion', async () => {
    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#slow-navigation']], tagName: 'A', eventTime: firstEventTime
    })

    const { _page: page, _cdpSession: cdpSession } = fakeBrowser._context
    let resolveLoad
    page.waitForLoadState.mockReturnValueOnce(new Promise((resolve) => { resolveLoad = resolve }))
    cdpSession.emit('Page.frameNavigated', {
      frame: { parentId: undefined, url: 'https://example.com/still-loading' }
    })
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#after-slow-navigation']], tagName: 'BUTTON', eventTime: firstEventTime + 5000
    })

    const flow = await writtenUserFlow()
    const trigger = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#slow-navigation')
    const afterNavigation = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#after-slow-navigation')

    expect(trigger.assertedEvents).toEqual([
      { type: 'navigation', url: 'https://example.com/still-loading', title: '' }
    ])
    expect(afterNavigation.duration).toBe(0)
    resolveLoad()
    await flushAll(1)
  })

  it('only suppresses the startup navigation when returning to the initial URL later', async () => {
    const { _cdpSession: cdpSession } = fakeBrowser._context
    cdpSession.emit('Page.frameNavigated', {
      frame: { parentId: undefined, url: baseOptions.url }
    })

    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#return-home']], tagName: 'A', eventTime: firstEventTime
    })
    cdpSession.emit('Page.frameNavigated', {
      frame: { parentId: undefined, url: baseOptions.url }
    })
    await flushAll(2)

    const flow = await writtenUserFlow()
    const returnHome = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#return-home')

    expect(returnHome.assertedEvents).toEqual([
      { type: 'navigation', url: baseOptions.url, title: 'Page Title' }
    ])
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

  it('subtracts paused time from the delay while preserving active time around the pause', async () => {
    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#before-pause']], tagName: 'BUTTON', eventTime: firstEventTime
    })

    const nowSpy = jest.spyOn(Date, 'now')
    nowSpy.mockReturnValue(firstEventTime + 1000)
    fakeServerInstance.events.emit('overlay-action', { action: 'PAUSE' })
    nowSpy.mockReturnValue(firstEventTime + 6000)
    fakeServerInstance.events.emit('overlay-action', { action: 'UNPAUSE' })
    nowSpy.mockRestore()

    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#after-pause']], tagName: 'BUTTON', eventTime: firstEventTime + 6250
    })

    const flow = await writtenUserFlow()
    const afterPauseClick = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#after-pause')

    expect(afterPauseClick.duration).toBe(1250)
  })

  it('uses source time to retain delayed pre-pause messages and reject delayed paused messages', async () => {
    const firstEventTime = Date.now()
    const nowSpy = jest.spyOn(Date, 'now')
    nowSpy.mockReturnValue(firstEventTime + 1000)
    fakeServerInstance.events.emit('overlay-action', { action: 'PAUSE' })
    nowSpy.mockReturnValue(firstEventTime + 6000)
    fakeServerInstance.events.emit('overlay-action', { action: 'UNPAUSE' })
    nowSpy.mockRestore()

    // Both messages arrive after resume; their source times decide whether they
    // belong to active recording time.
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#delayed-before-pause']],
      tagName: 'BUTTON',
      eventTime: firstEventTime + 500,
      orderEventTime: firstEventTime + 500,
      tabId: 'tab-1'
    })
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#delayed-during-pause']],
      tagName: 'BUTTON',
      eventTime: firstEventTime + 2000,
      orderEventTime: firstEventTime + 2000,
      tabId: 'tab-1'
    })
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#after-delayed-pause-events']],
      tagName: 'BUTTON',
      eventTime: firstEventTime + 6250,
      orderEventTime: firstEventTime + 6250,
      tabId: 'tab-1'
    })

    const flow = await writtenUserFlow()
    const selectors = flow.steps.map((step) => step.selectors?.[0]?.[0]).filter(Boolean)
    const afterPause = flow.steps.find(
      (step) => step.selectors?.[0]?.[0] === '#after-delayed-pause-events'
    )

    expect(selectors).toContain('#delayed-before-pause')
    expect(selectors).not.toContain('#delayed-during-pause')
    expect(afterPause.duration).toBe(750)
  })

  it('reclassifies cross-tab messages that overtake pause controls', async () => {
    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#before-source-pause']],
      tagName: 'BUTTON',
      eventTime: firstEventTime + 500,
      orderEventTime: firstEventTime + 500,
      tabId: 'tab-1'
    })
    // These arrive first from another page, but their source timestamps place
    // one inside the pause and one after the eventual resume.
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#overtook-pause']],
      tagName: 'BUTTON',
      eventTime: firstEventTime + 1500,
      orderEventTime: firstEventTime + 1500,
      tabId: 'tab-1'
    })
    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#overtook-unpause']],
      tagName: 'BUTTON',
      eventTime: firstEventTime + 2500,
      orderEventTime: firstEventTime + 2500,
      tabId: 'tab-1'
    })
    fakeServerInstance.events.emit('overlay-action', {
      action: 'PAUSE',
      eventTime: firstEventTime + 1000
    })
    fakeServerInstance.events.emit('overlay-action', {
      action: 'UNPAUSE',
      eventTime: firstEventTime + 2000
    })

    const flow = await writtenUserFlow()
    const selectors = flow.steps.map((step) => step.selectors?.[0]?.[0]).filter(Boolean)

    expect(selectors).toContain('#before-source-pause')
    expect(selectors).not.toContain('#overtook-pause')
    expect(selectors).toContain('#overtook-unpause')
  })

  it('reclassifies a navigation lifecycle callback that overtakes pause controls', async () => {
    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#before-lifecycle-pause']], tagName: 'BUTTON',
      eventTime: firstEventTime + 500, orderEventTime: firstEventTime + 500, tabId: 'tab-1'
    })

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(firstEventTime + 1500)
    const { _cdpSession: cdpSession } = fakeBrowser._context
    cdpSession.emit('Page.frameStartedLoading', { frameId: 'frame-1' })
    cdpSession.emit('Page.frameNavigated', {
      frame: {
        id: 'frame-1', parentId: undefined, url: 'https://example.com/paused-lifecycle',
        loaderId: 'paused-lifecycle-loader'
      }
    })
    await flushAll(2)
    nowSpy.mockRestore()

    fakeServerInstance.events.emit('overlay-action', {
      action: 'PAUSE', eventTime: firstEventTime + 1000
    })
    fakeServerInstance.events.emit('overlay-action', {
      action: 'UNPAUSE', eventTime: firstEventTime + 2000
    })
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#after-lifecycle-pause']], tagName: 'BUTTON',
      eventTime: firstEventTime + 2500, orderEventTime: firstEventTime + 2500, tabId: 'tab-1'
    })

    const flow = await writtenUserFlow()
    const beforePause = flow.steps.find(
      (step) => step.selectors?.[0]?.[0] === '#before-lifecycle-pause'
    )
    const afterPause = flow.steps.find(
      (step) => step.selectors?.[0]?.[0] === '#after-lifecycle-pause'
    )

    expect(beforePause.assertedEvents).toBeUndefined()
    expect(afterPause.duration).toBe(1000)
  })

  it('renormalizes a popup close that overtakes pause controls', async () => {
    const firstEventTime = Date.now()
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#open-before-delayed-pause']], tagName: 'BUTTON',
      eventTime: firstEventTime, tabId: 'tab-1'
    })

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(firstEventTime + 100)
    const popup = fakeBrowser._context.openPopup({ url: 'https://example.com/delayed-pause-popup' })
    await flushAll(4)
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#inside-delayed-pause-popup']], tagName: 'BUTTON',
      eventTime: firstEventTime + 500, tabId: 'tab-2'
    })

    nowSpy.mockReturnValue(firstEventTime + 1500)
    await popup.close()
    nowSpy.mockRestore()
    fakeServerInstance.events.emit('overlay-action', {
      action: 'PAUSE', eventTime: firstEventTime + 1000
    })
    fakeServerInstance.events.emit('overlay-action', {
      action: 'UNPAUSE', eventTime: firstEventTime + 2000
    })
    fakeServerInstance.events.emit('message', {
      action: 'click', selectors: [['#after-delayed-pause-close']], tagName: 'BUTTON',
      eventTime: firstEventTime + 2500, tabId: 'tab-1'
    })

    const flow = await writtenUserFlow()
    const closePopup = flow.steps.find((step) => step.type === 'close' && step.tabId === 'tab-2')
    const afterClose = flow.steps.find(
      (step) => step.selectors?.[0]?.[0] === '#after-delayed-pause-close'
    )

    expect(closePopup.duration).toBe(500)
    expect(afterClose.duration).toBe(500)
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
