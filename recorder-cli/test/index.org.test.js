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
import { getFrontdoorUrl, sanitizeFrontdoor } from '../src/sf-cli.js'
import { createServer } from '../src/server.js'
import { buildInjectedScript } from '../src/build.js'
import { startRecording } from '../src/index.js'
import { createFakeBrowser, createFakeServerInstance, flushAll, baseOptions } from './helpers/fakePlaywright.js'

describe('startRecording (org login / navigation target resolution)', () => {
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
    getFrontdoorUrl.mockResolvedValue('https://org.my.salesforce.com/secur/frontdoor.jsp?sid=TOKEN')
    sanitizeFrontdoor.mockReturnValue('https://org.my.salesforce.com/secur/frontdoor.jsp?sid=***')
  })

  afterEach(() => {
    logSpy.mockRestore()
    exitSpy.mockRestore()
    jest.clearAllMocks()
  })

  it('derives the org path from a full URL and navigates via the frontdoor URL', async () => {
    const promise = startRecording({ ...baseOptions, url: 'https://example.com/lightning/o/Account/list?x=1#hash', org: 'myOrg' })
    promise.catch(() => {})
    await flushAll(5)

    expect(getFrontdoorUrl).toHaveBeenCalledWith('myOrg', { path: '/lightning/o/Account/list?x=1#hash' })
    expect(fakeBrowser._context._page.goto).toHaveBeenCalledWith('https://org.my.salesforce.com/secur/frontdoor.jsp?sid=TOKEN')
    const text = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(text).toContain('Logging in via Salesforce CLI org: myOrg')
    expect(text).toContain('Logged in as myOrg')
    expect(text).not.toContain('sid=TOKEN')
  })

  it('treats a non-URL string as a bare path when deriving the org path', async () => {
    const promise = startRecording({ ...baseOptions, url: '/lightning/o/Account/list', org: 'myOrg' })
    promise.catch(() => {})
    await flushAll(5)

    expect(getFrontdoorUrl).toHaveBeenCalledWith('myOrg', { path: '/lightning/o/Account/list' })
  })

  it('omits the path option when logging into an org starting from about:blank', async () => {
    const promise = startRecording({ ...baseOptions, url: 'about:blank', org: 'myOrg' })
    promise.catch(() => {})
    await flushAll(5)

    expect(getFrontdoorUrl).toHaveBeenCalledWith('myOrg', {})
  })

  it('injects the recorder directly without navigating when the URL is about:blank and no org is given', async () => {
    const promise = startRecording({ ...baseOptions, url: 'about:blank' })
    promise.catch(() => {})
    await flushAll(5)

    expect(fakeBrowser._context._page.goto).not.toHaveBeenCalled()
    expect(fakeBrowser._context._cdpSession.send).toHaveBeenCalledWith('Page.getFrameTree')
  })
})
