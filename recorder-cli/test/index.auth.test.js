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

describe('startRecording (auth state resolution)', () => {
  let logSpy
  let exitSpy
  let fakeServerInstance
  let fakeBrowser

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {})

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

  function loggedText() {
    return logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
  }

  it('loads an existing loadAuth file as storageState', async () => {
    fs.existsSync.mockReturnValue(true)
    fs.statSync.mockReturnValue({ isFile: () => true, isDirectory: () => false })

    const promise = startRecording({ ...baseOptions, loadAuth: './auth/state.json' })
    promise.catch(() => {})
    await flushAll(5)

    expect(fakeBrowser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ storageState: expect.stringContaining('state.json') })
    )
    expect(loggedText()).toContain('Loaded device cookies from:')
  })

  it('ignores loadAuth when the file does not exist', async () => {
    fs.existsSync.mockReturnValue(false)

    const promise = startRecording({ ...baseOptions, loadAuth: './auth/missing.json' })
    promise.catch(() => {})
    await flushAll(5)

    const args = fakeBrowser.newContext.mock.calls[0][0]
    expect(args.storageState).toBeUndefined()
    expect(loggedText()).not.toContain('Loaded device cookies from:')
  })

  it('finds a matching device-cookie file inside a saveAuth directory by hostname', async () => {
    fs.existsSync.mockReturnValue(true)
    fs.statSync.mockReturnValue({ isFile: () => false, isDirectory: () => true })
    fs.readdirSync.mockReturnValue(['other.json', 'example.com---jdoe.json'])

    const promise = startRecording({ ...baseOptions, saveAuth: './auth-dir' })
    promise.catch(() => {})
    await flushAll(5)

    expect(fakeBrowser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ storageState: expect.stringContaining('example.com---jdoe.json') })
    )
  })

  it('finds no match inside a saveAuth directory and proceeds without storage state', async () => {
    fs.existsSync.mockReturnValue(true)
    fs.statSync.mockReturnValue({ isFile: () => false, isDirectory: () => true })
    fs.readdirSync.mockReturnValue(['unrelated.json'])

    const promise = startRecording({ ...baseOptions, saveAuth: './auth-dir' })
    promise.catch(() => {})
    await flushAll(5)

    const args = fakeBrowser.newContext.mock.calls[0][0]
    expect(args.storageState).toBeUndefined()
  })

  it('skips the directory scan when the recording URL cannot be parsed as a URL', async () => {
    fs.existsSync.mockReturnValue(true)
    fs.statSync.mockReturnValue({ isFile: () => false, isDirectory: () => true })

    const promise = startRecording({ ...baseOptions, url: 'not-a-valid-url', saveAuth: './auth-dir' })
    promise.catch(() => {})
    await flushAll(5)

    expect(fs.readdirSync).not.toHaveBeenCalled()
    const args = fakeBrowser.newContext.mock.calls[0][0]
    expect(args.storageState).toBeUndefined()
  })

  it('treats saveAuth as a direct file path when it is not a directory', async () => {
    fs.existsSync.mockReturnValue(true)
    fs.statSync.mockReturnValue({ isFile: () => true, isDirectory: () => false })

    const promise = startRecording({ ...baseOptions, saveAuth: './auth-dir/single.json' })
    promise.catch(() => {})
    await flushAll(5)

    expect(fakeBrowser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ storageState: expect.stringContaining('single.json') })
    )
  })

  it('proceeds without storage state when saveAuth points at nothing that exists', async () => {
    fs.existsSync.mockReturnValue(false)

    const promise = startRecording({ ...baseOptions, saveAuth: './nowhere' })
    promise.catch(() => {})
    await flushAll(5)

    const args = fakeBrowser.newContext.mock.calls[0][0]
    expect(args.storageState).toBeUndefined()
  })
})

describe('startRecording (saving device-identity cookies on finish)', () => {
  let logSpy
  let exitSpy
  let fakeServerInstance
  let fakeBrowser

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {})

    fs.existsSync.mockReturnValue(false)
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

  function loggedText() {
    return logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
  }

  it('saves device-identity cookies (deriving a username from a recorded email input) when the recording stops', async () => {
    fakeBrowser._context.storageState.mockResolvedValue({
      cookies: [
        { name: 'sfdc_lv2', value: 'device-token' },
        { name: 'sid', value: 'session-token' }
      ],
      origins: [{ origin: 'https://example.com', localStorage: [] }]
    })

    const promise = startRecording({ ...baseOptions, saveAuth: './auth-dir' })
    promise.catch(() => {})
    await flushAll(5)

    fakeServerInstance.events.emit('message', {
      action: 'change',
      selectors: [['input#email']],
      tagName: 'INPUT',
      inputType: 'email',
      value: 'jdoe@example.com',
      eventTime: Date.now()
    })
    fakeServerInstance.events.emit('overlay-action', { action: 'STOP' })
    await flushAll(5)

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(`example.com---jdoe@example.com.json`),
      expect.stringContaining('sfdc_lv2')
    )
    expect(loggedText()).toContain('Device identity cookies saved to:')
    expect(loggedText()).toContain('sfdc_lv2')
  })

  it('warns when no device-identity cookies are present to save', async () => {
    fakeBrowser._context.storageState.mockResolvedValue({ cookies: [], origins: [] })

    const promise = startRecording({ ...baseOptions, saveAuth: './auth-dir' })
    promise.catch(() => {})
    await flushAll(5)

    fakeServerInstance.events.emit('overlay-action', { action: 'STOP' })
    await flushAll(5)

    expect(loggedText()).toContain('No device identity cookies found to save.')
  })

  it('falls back to "unknown" as the hostname when the recorded URL cannot be parsed', async () => {
    fakeBrowser._context.storageState.mockResolvedValue({
      cookies: [{ name: 'sfdc_lv2', value: 'device-token' }],
      origins: []
    })

    const promise = startRecording({ ...baseOptions, url: '/bare/path', saveAuth: './auth-dir' })
    promise.catch(() => {})
    await flushAll(5)

    fakeServerInstance.events.emit('overlay-action', { action: 'STOP' })
    await flushAll(5)

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('unknown---default.json'),
      expect.stringContaining('sfdc_lv2')
    )
  })

  it('logs a warning instead of throwing when saving auth state fails', async () => {
    fakeBrowser._context.storageState.mockRejectedValue(new Error('context destroyed'))

    const promise = startRecording({ ...baseOptions, saveAuth: './auth-dir' })
    promise.catch(() => {})
    await flushAll(5)

    fakeServerInstance.events.emit('overlay-action', { action: 'STOP' })
    await flushAll(5)

    expect(loggedText()).toContain('Could not save auth state: context destroyed')
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('saves device-identity cookies when the browser disconnects unexpectedly', async () => {
    fakeBrowser._context.storageState.mockResolvedValue({
      cookies: [{ name: 'sfdc_lv2', value: 'device-token' }],
      origins: []
    })

    const promise = startRecording({ ...baseOptions, saveAuth: './auth-dir' })
    promise.catch(() => {})
    await flushAll(5)

    fakeBrowser.emit('disconnected')
    await flushAll(5)

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('example.com---default.json'),
      expect.stringContaining('sfdc_lv2')
    )
    expect(loggedText()).toContain('Browser closed. Saving recording')
    expect(loggedText()).toContain('Device identity cookies saved to:')
  })

  it('logs a warning instead of throwing when saving auth state fails during an abrupt browser close', async () => {
    fakeBrowser._context.storageState.mockRejectedValue(new Error('context destroyed'))

    const promise = startRecording({ ...baseOptions, saveAuth: './auth-dir' })
    promise.catch(() => {})
    await flushAll(5)

    fakeBrowser.emit('disconnected')
    await flushAll(5)

    expect(loggedText()).toContain('Could not save auth state (browser closed abruptly)')
  })

  it('treats a missing cookies array on storageState as empty', async () => {
    fakeBrowser._context.storageState.mockResolvedValue({ origins: [] })

    const promise = startRecording({ ...baseOptions, saveAuth: './auth-dir' })
    promise.catch(() => {})
    await flushAll(5)

    fakeServerInstance.events.emit('overlay-action', { action: 'STOP' })
    await flushAll(5)

    expect(loggedText()).toContain('No device identity cookies found to save.')
  })

  it('skips events that fail the tagName/inputType/value checks and falls back to the username-hint match', async () => {
    fakeBrowser._context.storageState.mockResolvedValue({
      cookies: [{ name: 'sfdc_lv2', value: 'device-token' }],
      origins: []
    })

    const promise = startRecording({ ...baseOptions, saveAuth: './auth-dir' })
    promise.catch(() => {})
    await flushAll(5)

    fakeServerInstance.events.emit('message', { action: 'change', tagName: 'SELECT', inputType: 'text', value: 'x', eventTime: Date.now() })
    fakeServerInstance.events.emit('message', { action: 'change', tagName: 'INPUT', inputType: 'password', value: 'secret', eventTime: Date.now() })
    fakeServerInstance.events.emit('message', { action: 'change', tagName: 'INPUT', inputType: 'text', value: '', eventTime: Date.now() })
    fakeServerInstance.events.emit('message', {
      action: 'input', tagName: 'INPUT', inputType: 'text', value: 'nohint', selectors: [['#plain-field']], eventTime: Date.now()
    })
    fakeServerInstance.events.emit('message', { action: 'input', tagName: 'INPUT', inputType: 'text', value: 'anonuser', eventTime: Date.now() })
    fakeServerInstance.events.emit('message', {
      action: 'change', tagName: 'INPUT', inputType: 'text', value: 'carol', selectors: [['#login-name']], eventTime: Date.now()
    })
    fakeServerInstance.events.emit('overlay-action', { action: 'STOP' })
    await flushAll(5)

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('example.com---carol.json'),
      expect.stringContaining('sfdc_lv2')
    )
  })

  it('matches the username hint via inputType email even when no selector hints at it', async () => {
    fakeBrowser._context.storageState.mockResolvedValue({
      cookies: [{ name: 'sfdc_lv2', value: 'device-token' }],
      origins: []
    })

    const promise = startRecording({ ...baseOptions, saveAuth: './auth-dir' })
    promise.catch(() => {})
    await flushAll(5)

    fakeServerInstance.events.emit('message', {
      action: 'change', tagName: 'INPUT', inputType: 'email', value: 'finaluser2', selectors: [['#field9']], eventTime: Date.now()
    })
    fakeServerInstance.events.emit('overlay-action', { action: 'STOP' })
    await flushAll(5)

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('example.com---finaluser2.json'),
      expect.stringContaining('sfdc_lv2')
    )
  })
})
