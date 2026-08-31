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

describe('startRecording -> generateUserFlow / filterSteps (via recorded message events)', () => {
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

  it('handles RELOAD, WINDOW_OR_TAB_CLOSED (with and without a tabId match), dblclick, and multi-tab GOTOs', async () => {
    emit({ action: 'RELOAD' })
    // Auto GOTO's tabId is undefined; this doesn't match, so it should NOT pop tabIds.
    emit({ action: 'WINDOW_OR_TAB_CLOSED', tabId: 'other-tab' })
    emit({
      action: 'dblclick',
      selectors: [['#dbl']],
      tagName: 'DIV',
      frameSelectors: ['#f'],
      coordinates: { x: 5, y: 6 },
      frameIndex: 3
    })
    emit({ action: 'GOTO', href: 'https://example.com/tab2', title: '', tabId: 'tab-2' })
    // Matches the tab-2 GOTO above, so this one SHOULD pop tabIds back down.
    emit({ action: 'WINDOW_OR_TAB_CLOSED', tabId: 'tab-2' })
    emit({ action: 'GOTO', href: 'https://example.com/tab4', title: '', tabId: 'tab-4' })
    // Same tabId as the current tab — not a new tab/window.
    emit({ action: 'GOTO', href: 'https://example.com/tab4-again', title: '', tabId: 'tab-4' })

    const flow = await writtenUserFlow()

    const reloadStep = flow.steps.find((s) => s.type === 'reload')
    expect(reloadStep.assertedEvents).toEqual([{ type: 'windowOrTabClose' }])

    const dblStep = flow.steps.find((s) => s.type === 'doubleClick')
    expect(dblStep).toMatchObject({
      selectors: [['#dbl']],
      frameSelectors: ['#f'],
      offsetX: 5,
      offsetY: 6,
      tagName: 'DIV',
      frame: 3
    })

    const gotos = flow.steps.filter((s) => s.type === 'navigate')
    expect(gotos).toHaveLength(4)
    // The tab-2 GOTO's assertedEvents get overwritten by the WINDOW_OR_TAB_CLOSED that follows it.
    expect(gotos[1].assertedEvents).toEqual([{ type: 'windowOrTabClose' }])
    expect(gotos[2].assertedEvents[0].isNewTabOrWindow).toBe(true)
    expect(gotos[3].assertedEvents[0].isNewTabOrWindow).toBeUndefined()
  })

  it('records a change on a non-select input only when it carries a value, and dedupes consecutive changes to the same field', async () => {
    emit({ action: 'change', selectors: [['input#i']], tagName: 'INPUT', inputType: 'text', value: 'hello' })
    emit({ action: 'change', selectors: [['input#i']], tagName: 'INPUT', inputType: 'text', value: 'hello2' })
    emit({ action: 'change', selectors: [['input#empty']], tagName: 'INPUT', inputType: 'text', value: '' })

    const flow = await writtenUserFlow()

    const changes = flow.steps.filter((s) => s.type === 'change' && s.tagName === 'INPUT')
    expect(changes).toHaveLength(1)
    expect(changes[0].value).toBe('hello2')
  })

  it('handles special-key keyDown/keyUp pairing, Tab-triggered change, and plain keys with no value', async () => {
    emit({ action: 'keydown', key: 'Enter' })
    emit({ action: 'keyup', key: 'Enter' })
    emit({ action: 'keydown', key: 'x', keyCode: 9, value: 'tabbed', tagName: 'INPUT', selectors: [['#tab']] })
    emit({ action: 'keydown', key: 'z', keyCode: 65 })
    emit({ action: 'keyup', key: 'z' })
    emit({ action: 'keyup', key: 'y', value: 'restored', tagName: 'INPUT', selectors: [['#y']] })
    emit({ action: 'keydown', key: 'Escape' })
    emit({
      action: 'assert',
      selectors: [['#assert-default']],
      tagName: 'SPAN'
    })

    const flow = await writtenUserFlow()

    const keyDowns = flow.steps.filter((s) => s.type === 'keyDown')
    expect(keyDowns).toEqual([{ type: 'keyDown', target: 'main', key: 'Enter' }, { type: 'keyDown', target: 'main', key: 'Escape' }])
    expect(flow.steps.some((s) => s.type === 'keyUp')).toBe(false)

    const tabChange = flow.steps.find((s) => s.selectors?.[0]?.[0] === '#tab')
    expect(tabChange).toMatchObject({ type: 'change', value: 'tabbed' })

    const yChange = flow.steps.find((s) => s.selectors?.[0]?.[0] === '#y')
    expect(yChange).toMatchObject({ type: 'change', value: 'restored' })

    const assertStep = flow.steps.find((s) => s.type === 'assert')
    expect(assertStep).toMatchObject({ assertionType: 'visible', textContent: null })
  })

  it('records input changes only for INPUT/TEXTAREA tags with a non-empty value', async () => {
    emit({ action: 'input', tagName: 'TEXTAREA', value: 'multi-line text', selectors: [['textarea#t']] })
    emit({ action: 'input', tagName: 'DIV', value: 'ignored', selectors: [['div#d']] })
    emit({ action: 'input', tagName: 'INPUT', value: '', selectors: [['input#empty2']] })

    const flow = await writtenUserFlow()

    const inputChanges = flow.steps.filter((s) => s.type === 'change')
    expect(inputChanges).toHaveLength(1)
    expect(inputChanges[0]).toMatchObject({ tagName: 'TEXTAREA', value: 'multi-line text' })
  })

  it('marks a raw NAVIGATION event with a new tabId as a new tab/window, distinct from the current one', async () => {
    emit({ action: 'dblclick', selectors: [['#anchor']], tagName: 'DIV' })
    emit({ action: 'NAVIGATION', value: 'https://example.com/tab3', title: 'Tab 3', tabId: 'tab-3' })

    const flow = await writtenUserFlow()

    const anchorStep = flow.steps.find((s) => s.type === 'doubleClick')
    expect(anchorStep.assertedEvents).toEqual([{ type: 'navigation', url: 'https://example.com/tab3', title: 'Tab 3', isNewTabOrWindow: true }])
  })

  it('ignores a NAVIGATION event when the only preceding step is the initial viewport', async () => {
    // Force a fresh session where the only step so far is the re-recorded viewport.
    fakeServerInstance.events.emit('overlay-action', { action: 'RESTART' })
    fakeServerInstance.events.emit('message', { control: 'GET_VIEWPORT_SIZE' })
    emit({ action: 'NAVIGATION', value: 'https://example.com/too-early', title: 'Too early' })

    const flow = await writtenUserFlow()

    expect(flow.steps).toEqual([
      { type: 'setViewport', width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: false }
    ])
  })

  it('warns and still preserves the JSON when the Playwright conversion fails', async () => {
    convertToPlaywright.mockRejectedValue(new Error('conversion service unavailable'))

    fakeServerInstance.events.emit('overlay-action', { action: 'STOP' })
    await flushAll(5)

    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('recording.json'), expect.any(String))
    expect(fs.writeFileSync).not.toHaveBeenCalledWith(expect.stringContaining('recording.spec.js'), expect.any(String))
  })
})
