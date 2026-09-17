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
import { execFileSync } from 'child_process'
import { createServer } from '../src/server.js'
import { buildInjectedScript } from '../src/build.js'
import { startRecording } from '../src/index.js'
import { createFakeBrowser, createFakeServerInstance, flushAll, baseOptions } from './helpers/fakePlaywright.js'

// Simulates Playwright's real "channel not installed" error — the only
// launch failure that should make launchWithBrowserFallback try the next
// candidate instead of propagating.
function channelNotFoundError(channel) {
  return new Error(`browserType.launch: Chromium distribution '${channel}' is not found at /fake/path\nRun "npx playwright install ${channel}"`)
}

describe('startRecording (chromium install)', () => {
  let logSpy

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    buildInjectedScript.mockResolvedValue('/* injected */')
    createServer.mockResolvedValue(createFakeServerInstance())
    chromium.executablePath.mockReturnValue('/path/to/chromium')
    fs.existsSync.mockReturnValue(false)
  })

  afterEach(() => {
    logSpy.mockRestore()
    jest.clearAllMocks()
  })

  it('installs chromium when missing and continues launching the browser', async () => {
    execFileSync.mockReturnValue(undefined)
    const fakeBrowser = createFakeBrowser()
    chromium.launch.mockImplementation(async (opts) => {
      if (opts.channel) throw channelNotFoundError(opts.channel)
      return fakeBrowser
    })

    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)

    const calls = chromium.launch.mock.calls.map((c) => c[0])
    expect(calls[0]).toEqual(expect.objectContaining({ channel: 'chrome' }))
    expect(calls[1]).toEqual(expect.objectContaining({ channel: 'msedge' }))
    expect(calls[2].channel).toBeUndefined()
    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['install', 'chromium']),
      { stdio: 'inherit' }
    )
    const text = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(text).toContain('Chromium not found at:')
    expect(text).toContain('Chromium installed')
  })

  it('rejects with a helpful message when the chromium install itself fails', async () => {
    chromium.launch.mockImplementation(async (opts) => {
      if (opts.channel) throw channelNotFoundError(opts.channel)
      return undefined
    })
    execFileSync.mockImplementation(() => {
      throw new Error('spawn EACCES')
    })

    await expect(startRecording({ ...baseOptions })).rejects.toThrow(
      'Failed to install Chromium: spawn EACCES. Run "npx playwright install chromium" manually.'
    )
    expect(chromium.launch).toHaveBeenCalledTimes(2)
  })
})

describe('startRecording (browser channel fallback)', () => {
  let logSpy

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    buildInjectedScript.mockResolvedValue('/* injected */')
    createServer.mockResolvedValue(createFakeServerInstance())
    chromium.executablePath.mockReturnValue('/path/to/chromium')
  })

  afterEach(() => {
    logSpy.mockRestore()
    jest.clearAllMocks()
  })

  it('uses system Chrome without ever checking for the bundled Chromium install', async () => {
    const fakeBrowser = createFakeBrowser()
    chromium.launch.mockImplementation(async (opts) => {
      if (opts.channel === 'chrome') return fakeBrowser
      throw channelNotFoundError(opts.channel)
    })

    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)

    expect(chromium.launch).toHaveBeenCalledTimes(1)
    expect(chromium.launch).toHaveBeenCalledWith(expect.objectContaining({ channel: 'chrome' }))
    expect(fs.existsSync).not.toHaveBeenCalled()
    expect(execFileSync).not.toHaveBeenCalled()
    const text = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(text).toContain('Using system Google Chrome')
  })

  it('falls back to system Edge when Chrome is not installed', async () => {
    const fakeBrowser = createFakeBrowser()
    chromium.launch.mockImplementation(async (opts) => {
      if (opts.channel === 'chrome') throw channelNotFoundError('chrome')
      if (opts.channel === 'msedge') return fakeBrowser
      throw new Error('should not reach bundled chromium')
    })

    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)

    expect(chromium.launch).toHaveBeenCalledTimes(2)
    expect(fs.existsSync).not.toHaveBeenCalled()
    const text = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(text).toContain('Using system Microsoft Edge')
  })

  it('propagates a genuine launch failure immediately, without trying the next browser', async () => {
    chromium.launch.mockImplementation(async (opts) => {
      if (opts.channel === 'chrome') throw new Error('Target page, context or browser has been closed')
      throw new Error('should not have tried another channel')
    })

    await expect(startRecording({ ...baseOptions })).rejects.toThrow(
      'Target page, context or browser has been closed'
    )
    expect(chromium.launch).toHaveBeenCalledTimes(1)
  })
})
