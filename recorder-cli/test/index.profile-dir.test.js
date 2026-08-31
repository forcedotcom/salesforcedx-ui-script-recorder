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
import { createFakeContext, createFakeServerInstance, flushAll, baseOptions } from './helpers/fakePlaywright.js'

describe('startRecording (profileDir / persistent context)', () => {
  let logSpy
  let exitSpy
  let fakeServerInstance

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {})

    fs.existsSync.mockReturnValue(true)
    buildInjectedScript.mockResolvedValue('/* injected */')
    fakeServerInstance = createFakeServerInstance()
    createServer.mockResolvedValue(fakeServerInstance)
    chromium.executablePath.mockReturnValue('/path/to/chromium')
    convertToPlaywright.mockResolvedValue('// playwright script')
  })

  afterEach(() => {
    logSpy.mockRestore()
    exitSpy.mockRestore()
    jest.clearAllMocks()
  })

  it('reuses an already-open page from the persistent context instead of opening a new one', async () => {
    const context = createFakeContext({ pages: [{ existing: true }] })
    chromium.launchPersistentContext.mockResolvedValue(context)

    const promise = startRecording({ ...baseOptions, profileDir: './my-profile' })
    promise.catch(() => {})
    await flushAll(5)

    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('my-profile'), { recursive: true })
    expect(chromium.launchPersistentContext).toHaveBeenCalledWith(
      expect.stringContaining('my-profile'),
      expect.objectContaining({ headless: true, viewport: { width: 1280, height: 720 } })
    )
    expect(context.newPage).not.toHaveBeenCalled()
    expect(context.newCDPSession).toHaveBeenCalled()

    fakeServerInstance.events.emit('overlay-action', { action: 'STOP' })
    await flushAll(5)

    expect(context.close).toHaveBeenCalled()
    expect(fakeServerInstance.server.close).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('opens a new page when the persistent context has none yet, and saves the recording when the context closes on its own', async () => {
    const context = createFakeContext({ pages: [] })
    chromium.launchPersistentContext.mockResolvedValue(context)

    const promise = startRecording({ ...baseOptions, profileDir: './my-profile' })
    promise.catch(() => {})
    await flushAll(5)

    expect(context.newPage).toHaveBeenCalled()

    context.emit('close')
    await flushAll(5)

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('recording.json'),
      expect.stringContaining('"type": "setViewport"')
    )
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('recording.spec.js'),
      '// playwright script'
    )
    const text = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(text).toContain('Browser closed. Saving recording')
    expect(fakeServerInstance.server.close).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})
