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

  it('keeps the visible radio activation and state change after label forwarding is filtered', async () => {
    const firstEventTime = Date.now()
    const radioSelectors = [
      ['div.changeRecordTypeRightColumn > div:nth-child(11) input[type="radio"]'],
      ['aria/User Story[role="radio"]']
    ]
    emit({
      action: 'click',
      eventTime: firstEventTime,
      selectors: [['div.changeRecordTypeRightColumn > div:nth-child(11) span.slds-radio--faux']],
      tagName: 'SPAN',
      recordingTargetId: 'frame-a:faux-radio'
    })
    emit({
      action: 'change',
      eventTime: firstEventTime + 5,
      selectors: radioSelectors,
      tagName: 'INPUT',
      inputType: 'radio',
      recordingTargetId: 'frame-a:native-radio',
      value: true
    })

    const flow = await writtenUserFlow()
    const interactionSteps = flow.steps.filter(step =>
      step.tagName === 'SPAN' || step.inputType === 'radio'
    )

    expect(interactionSteps).toEqual([
      expect.objectContaining({
        type: 'click',
        selectors: [['div.changeRecordTypeRightColumn > div:nth-child(11) span.slds-radio--faux']]
      }),
      expect.objectContaining({
        type: 'change',
        selectors: radioSelectors,
        inputType: 'radio',
        value: true,
        duration: 5
      })
    ])
  })

  it('records an unchecked checkbox state', async () => {
    emit({
      action: 'change',
      selectors: [['input#notifications']],
      tagName: 'INPUT',
      inputType: 'checkbox',
      recordingTargetId: 'frame-a:checkbox',
      value: false
    })

    const flow = await writtenUserFlow()

    expect(flow.steps).toContainEqual(expect.objectContaining({
      type: 'change',
      selectors: [['input#notifications']],
      inputType: 'checkbox',
      value: false
    }))
  })

  it('keeps a direct checkable click and its following state change', async () => {
    const sharedSelectors = [['input[type="radio"]']]
    emit({
      action: 'click',
      selectors: sharedSelectors,
      tagName: 'INPUT',
      inputType: 'radio',
      recordingTargetId: 'frame-a:direct-radio'
    })
    emit({
      action: 'change',
      selectors: sharedSelectors,
      tagName: 'INPUT',
      inputType: 'radio',
      recordingTargetId: 'frame-a:direct-radio',
      value: true
    })

    const flow = await writtenUserFlow()
    const radioSteps = flow.steps.filter(step => step.inputType === 'radio')

    expect(radioSteps.map(({ type }) => type)).toEqual(['click', 'change'])
  })

  it('dedupes a rapid same-value change when only the transient CSS selector changed', async () => {
    const stableAriaSelector = ['aria/Product Tag[role="textbox"]']
    emit({
      action: 'input',
      selectors: [['#product-tag-before-input'], stableAriaSelector],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'frame-a:17',
      value: 'Scale Testing Eng'
    })
    emit({
      action: 'keyup',
      selectors: [['#product-tag-after-input'], stableAriaSelector],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'frame-a:17',
      value: 'Scale Testing Eng'
    })

    const flow = await writtenUserFlow()
    const changes = flow.steps.filter((step) => step.type === 'change' && step.tagName === 'INPUT')

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      selectors: [['#product-tag-before-input'], stableAriaSelector],
      value: 'Scale Testing Eng'
    })
    expect(changes[0].recordingTargetId).toBeUndefined()
  })

  it('dedupes a delayed duplicate change emitted immediately before its dropdown option click', async () => {
    const firstEventTime = Date.now()
    const stableAriaSelector = ['aria/Product Tag[role="textbox"]']
    emit({
      action: 'input',
      eventTime: firstEventTime,
      selectors: [['#product-tag-before-input'], stableAriaSelector],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'frame-a:17',
      value: 'Scale Testing Eng'
    })
    emit({
      action: 'keyup',
      eventTime: firstEventTime + 3185,
      selectors: [['#product-tag-transient-state'], stableAriaSelector],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'frame-a:17',
      value: 'Scale Testing Eng'
    })
    emit({
      action: 'click',
      eventTime: firstEventTime + 3209,
      selectors: [['#product-tag-option']],
      tagName: 'SPAN'
    })

    const flow = await writtenUserFlow()
    const changes = flow.steps.filter((step) => step.type === 'change' && step.tagName === 'INPUT')

    expect(changes).toHaveLength(1)
    expect(changes[0].selectors).toEqual([['#product-tag-before-input'], stableAriaSelector])
  })

  it('keeps separate changes when transient selectors share no stable alternative', async () => {
    emit({
      action: 'input',
      selectors: [['#first-field'], ['aria/First field[role="textbox"]']],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'frame-a:41',
      value: 'same value'
    })
    emit({
      action: 'keyup',
      selectors: [['#second-field'], ['aria/Second field[role="textbox"]']],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'frame-a:41',
      value: 'same value'
    })

    const flow = await writtenUserFlow()
    const changes = flow.steps.filter((step) => step.type === 'change' && step.tagName === 'INPUT')

    expect(changes).toHaveLength(2)
  })

  it('compares every segment of a multi-part selector alternative', async () => {
    emit({
      action: 'input',
      selectors: [['x-field', '#first-input']],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'frame-a:43',
      value: 'same value'
    })
    emit({
      action: 'keyup',
      selectors: [['x-field', '#second-input']],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'frame-a:43',
      value: 'same value'
    })

    const flow = await writtenUserFlow()
    const changes = flow.steps.filter((step) => step.type === 'change' && step.tagName === 'INPUT')

    expect(changes).toHaveLength(2)
  })

  it('does not collapse same-element changes across an intentional key sequence', async () => {
    const stableAriaSelector = ['aria/Product Tag[role="textbox"]']
    emit({
      action: 'input',
      selectors: [['#product-tag-before-input'], stableAriaSelector],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'frame-a:42',
      value: 'Scale Testing Eng'
    })
    emit({ action: 'keydown', key: 'Enter' })
    emit({ action: 'keyup', key: 'Enter' })
    emit({
      action: 'keyup',
      selectors: [['#product-tag-after-input'], stableAriaSelector],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'frame-a:42',
      value: 'Scale Testing Eng'
    })

    const flow = await writtenUserFlow()
    const changes = flow.steps.filter((step) => step.type === 'change' && step.tagName === 'INPUT')

    expect(changes).toHaveLength(2)
    expect(flow.steps.some((step) => step.type === 'keyDown' && step.key === 'Enter')).toBe(true)
  })

  it('keeps generic-selector contenteditable changes on different fields across Tab', async () => {
    const genericEditorSelector = ['div[contenteditable="true"]']
    emit({
      action: 'input',
      selectors: [genericEditorSelector],
      tagName: 'DIV',
      isContentEditable: true,
      recordingTargetId: 'frame-a:description',
      value: 'Description value'
    })
    emit({ action: 'keydown', key: 'Tab' })
    emit({ action: 'keyup', key: 'Tab' })
    emit({
      action: 'input',
      selectors: [genericEditorSelector],
      tagName: 'DIV',
      isContentEditable: true,
      recordingTargetId: 'frame-a:notes',
      value: 'Notes value'
    })

    const flow = await writtenUserFlow()
    const changes = flow.steps.filter((step) => step.type === 'change' && step.isContentEditable)

    expect(changes).toHaveLength(2)
    expect(changes.map(({ value }) => value)).toEqual(['Description value', 'Notes value'])
    expect(flow.steps.some((step) => step.type === 'keyDown' && step.key === 'Tab')).toBe(true)
  })

  it('dedupes the same element even when its duplicate change arrives after a pause', async () => {
    const firstEventTime = Date.now()
    const sharedAriaSelector = ['aria/Shared field[role="textbox"]']
    emit({
      action: 'input',
      eventTime: firstEventTime,
      selectors: [['#field-before'], sharedAriaSelector],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'frame-a:23',
      value: 'same value'
    })
    emit({
      action: 'keyup',
      eventTime: firstEventTime + 501,
      selectors: [['#field-after'], sharedAriaSelector],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'frame-a:23',
      value: 'same value'
    })

    const flow = await writtenUserFlow()
    const changes = flow.steps.filter((step) => step.type === 'change' && step.tagName === 'INPUT')

    expect(changes).toHaveLength(1)
    expect(changes[0].selectors).toEqual([['#field-before'], sharedAriaSelector])
  })

  it('keeps distinct repeated-label elements even when value and fallback selector match', async () => {
    const sharedAriaSelector = ['aria/Repeated field[role="textbox"]']
    emit({
      action: 'input',
      selectors: [['#repeated-field-one'], sharedAriaSelector],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'frame-a:31',
      value: 'same value'
    })
    emit({
      action: 'keyup',
      selectors: [['#repeated-field-two'], sharedAriaSelector],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'frame-a:32',
      value: 'same value'
    })

    const flow = await writtenUserFlow()
    const changes = flow.steps.filter((step) => step.type === 'change' && step.tagName === 'INPUT')

    expect(changes).toHaveLength(2)
    expect(changes[1].selectors).toEqual([['#repeated-field-two'], sharedAriaSelector])
  })

  it('does not borrow selectors across different control shapes', async () => {
    const sharedSelector = ['aria/Shared editor[role="textbox"]']
    emit({
      action: 'input',
      selectors: [['#plain-input'], sharedSelector],
      tagName: 'INPUT',
      inputType: 'text',
      value: 'same value'
    })
    emit({
      action: 'input',
      selectors: [['#rich-textarea'], sharedSelector],
      tagName: 'TEXTAREA',
      inputType: 'textarea',
      value: 'same value'
    })

    const flow = await writtenUserFlow()
    const changes = flow.steps.filter((step) => step.type === 'change')

    expect(changes).toHaveLength(2)
    expect(changes[1].selectors).toEqual([['#rich-textarea'], sharedSelector])
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

  it('records an explicitly marked contenteditable DIV input without admitting arbitrary DIV input', async () => {
    emit({
      action: 'input',
      tagName: 'DIV',
      isContentEditable: true,
      value: "Bob's description\nsecond line",
      selectors: [['#description-editor']]
    })
    emit({
      action: 'input',
      tagName: 'DIV',
      value: 'arbitrary div input',
      selectors: [['#ordinary-div']]
    })

    const flow = await writtenUserFlow()

    const changes = flow.steps.filter((step) => step.type === 'change')
    expect(changes).toEqual([expect.objectContaining({
      selectors: [['#description-editor']],
      tagName: 'DIV',
      isContentEditable: true,
      value: "Bob's description\nsecond line"
    })])
  })

  it('keeps Description and Subject changes in the order they were filled', async () => {
    emit({
      action: 'input',
      tagName: 'DIV',
      isContentEditable: true,
      value: 'Description first',
      selectors: [['#description-editor']],
      recordingTargetId: 'frame-a:description'
    })
    emit({
      action: 'change',
      tagName: 'INPUT',
      inputType: 'text',
      value: 'Subject second',
      selectors: [['#subject']],
      recordingTargetId: 'frame-a:subject'
    })

    const flow = await writtenUserFlow()
    const changes = flow.steps.filter((step) => step.type === 'change')

    expect(changes).toHaveLength(2)
    expect(changes.map(({ selectors, value }) => ({ selectors, value }))).toEqual([
      { selectors: [['#description-editor']], value: 'Description first' },
      { selectors: [['#subject']], value: 'Subject second' }
    ])
  })

  it('records clearing an explicitly marked contenteditable editor', async () => {
    emit({
      action: 'input',
      tagName: 'DIV',
      isContentEditable: true,
      value: '',
      selectors: [['#description-editor']]
    })

    const flow = await writtenUserFlow()

    expect(flow.steps).toContainEqual(expect.objectContaining({
      type: 'change',
      selectors: [['#description-editor']],
      isContentEditable: true,
      value: ''
    }))
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
