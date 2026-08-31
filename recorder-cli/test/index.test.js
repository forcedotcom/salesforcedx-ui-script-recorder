jest.mock('playwright', () => ({
  chromium: {
    executablePath: jest.fn(),
    launch: jest.fn(),
    launchPersistentContext: jest.fn()
  }
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
jest.mock('chalk', () => ({
  gray: (s) => s,
  yellow: (s) => s,
  green: (s) => s,
  blue: (s) => s
}))

import { chromium } from 'playwright'
import fs from 'fs'
import { execFileSync } from 'child_process'
import { createServer } from '../src/server.js'
import { buildInjectedScript } from '../src/build.js'
import { convertToPlaywright } from '../src/playwright-converter.js'
import { startRecording } from '../src/index.js'
import { createFakeBrowser, createFakeServerInstance, flushAll, baseOptions } from './helpers/fakePlaywright.js'

describe('startRecording (happy path, regular browser launch)', () => {
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

  it('launches chromium, injects the recorder, navigates, and records a full session ending in STOP', async () => {
    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)

    expect(execFileSync).not.toHaveBeenCalled()
    expect(chromium.launch).toHaveBeenCalledWith(expect.objectContaining({ headless: true }))
    expect(fakeBrowser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: { width: 1280, height: 720 }, permissions: expect.any(Array) })
    )
    const context = fakeBrowser._context
    expect(context.newPage).toHaveBeenCalled()
    expect(context.newCDPSession).toHaveBeenCalled()
    expect(context._cdpSession.send).toHaveBeenCalledWith('Page.enable')
    expect(context._cdpSession.send).toHaveBeenCalledWith(
      'Page.addScriptToEvaluateOnNewDocument',
      expect.objectContaining({ worldName: 'SalesforceRecorderIsolated' })
    )
    expect(context._page.goto).toHaveBeenCalledWith('https://example.com/start')
    expect(context._page.title).toHaveBeenCalled()

    const text = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(text).toContain('Recording started! Interact with the page.')

    fakeServerInstance.events.emit('message', {
      action: 'click',
      selectors: [['#btn']],
      tagName: 'BUTTON',
      coordinates: { x: 1, y: 2 },
      frameSelectors: ['#frame'],
      parentSelectors: ['#list'],
      componentType: 'lightning-button',
      frameIndex: 2,
      eventTime: Date.now()
    })
    fakeServerInstance.events.emit('message', {
      action: 'change',
      selectors: [['select#s']],
      tagName: 'SELECT',
      value: 'opt1',
      eventTime: Date.now()
    })
    fakeServerInstance.events.emit('message', {
      action: 'assert',
      selectors: [['#assert']],
      assertionType: 'visible',
      textContent: 'Hi',
      tagName: 'SPAN',
      eventTime: Date.now()
    })

    fakeServerInstance.events.emit('overlay-action', { action: 'STOP' })
    await flushAll(5)

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('recording.json'),
      expect.stringContaining('"type": "click"')
    )
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('recording.spec.js'),
      '// playwright script'
    )
    expect(context.close).not.toHaveBeenCalled()
    expect(fakeBrowser.close).toHaveBeenCalled()
    expect(fakeServerInstance.server.close).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})
