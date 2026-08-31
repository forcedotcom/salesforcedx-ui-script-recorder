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
    chromium.launch.mockResolvedValue(fakeBrowser)

    const promise = startRecording({ ...baseOptions })
    promise.catch(() => {})
    await flushAll(5)

    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['install', 'chromium']),
      { stdio: 'inherit' }
    )
    expect(chromium.launch).toHaveBeenCalled()
    const text = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(text).toContain('Chromium not found at:')
    expect(text).toContain('Chromium installed')
  })

  it('rejects with a helpful message when the chromium install itself fails', async () => {
    execFileSync.mockImplementation(() => {
      throw new Error('spawn EACCES')
    })

    await expect(startRecording({ ...baseOptions })).rejects.toThrow(
      'Failed to install Chromium: spawn EACCES. Run "npx playwright install chromium" manually.'
    )
    expect(chromium.launch).not.toHaveBeenCalled()
  })
})
