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
import { generateUserFlow, startRecording } from '../src/index.js'
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

  it('keeps a later page.goto completion baseline when its redirect marker completed earlier', () => {
    const flow = generateUserFlow([
      {
        action: 'GOTO',
        href: 'https://example.com/start',
        eventTime: 1000,
        endEventTime: 6000,
        tabId: 'main'
      },
      {
        action: 'NAVIGATION',
        value: 'https://example.com/redirected',
        eventTime: 2000,
        tabId: 'main'
      },
      {
        action: 'click',
        selectors: [['#after-redirect']],
        tagName: 'BUTTON',
        eventTime: 7000,
        tabId: 'main'
      }
    ], {})

    const afterRedirect = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#after-redirect')
    expect(afterRedirect.duration).toBe(1000)
  })

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
    // A close from a different tab must not overwrite this reload's navigation.
    expect(reloadStep.assertedEvents).toEqual([{ type: 'navigation', url: '', title: '' }])

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
    expect(gotos[1].assertedEvents).toEqual([{
      type: 'navigation',
      url: 'https://example.com/tab2',
      title: '',
      isNewTabOrWindow: true,
      targetTabId: 'tab-2'
    }])
    expect(flow.steps).toContainEqual(expect.objectContaining({
      type: 'close',
      tabId: 'tab-2'
    }))
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

  it.each(['Team', 'Project'])(
    'guards the pre-open %s activator while preserving a replaced post-open input for filling',
    async (label) => {
      const stableCssSelector = [
        `div.slds-combobox > div.slds-combobox__form-element input[aria-label="${label}"]`
      ]
      const stableAriaSelector = [`aria/${label}[role="combobox"]`]
      const postOpenCssSelector = [
        'div.slds-is-open > div.slds-combobox__form-element input[type="text"]'
      ]

      emit({
        action: 'click',
        selectors: [stableCssSelector, stableAriaSelector],
        tagName: 'INPUT',
        inputType: 'text',
        recordingTargetId: `closed-${label}`
      })
      emit({
        action: 'input',
        selectors: [
          postOpenCssSelector,
          stableAriaSelector
        ],
        tagName: 'INPUT',
        inputType: 'text',
        // Lightning can replace the input while opening the lookup.
        recordingTargetId: `open-${label}`,
        value: 'Scale Testing'
      })

      const flow = await writtenUserFlow()
      const change = flow.steps.find(step =>
        step.type === 'change' && step.selectors?.some(selector => selector[0] === stableAriaSelector[0])
      )

      expect(change.selectors[0]).toEqual(postOpenCssSelector)
      expect(change.selectors).toContainEqual(stableCssSelector)
      expect(change.selectors).toContainEqual(stableAriaSelector)
      expect(change.ensureComboboxOpen).toBe(true)
      expect(change.comboboxActivationSelector).toBe(stableCssSelector[0])
    }
  )

  it('promotes the stable combobox selector after repeated typed values are deduplicated', async () => {
    const stableAriaSelector = ['aria/Team[role="combobox"]']
    const transientSelectors = [
      ['div.slds-is-open > div.slds-combobox__form-element input[type="text"]'],
      stableAriaSelector
    ]
    emit({
      action: 'click',
      selectors: [['input[aria-label="Team"]'], stableAriaSelector],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'closed-team'
    })
    emit({
      action: 'input',
      selectors: transientSelectors,
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'open-team',
      value: 'S'
    })
    emit({
      action: 'input',
      selectors: transientSelectors,
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'open-team',
      value: 'Scale Testing'
    })

    const flow = await writtenUserFlow()
    const changes = flow.steps.filter(step => step.type === 'change' && step.tagName === 'INPUT')

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      selectors: [
        ['div.slds-is-open > div.slds-combobox__form-element input[type="text"]'],
        ['input[aria-label="Team"]'],
        stableAriaSelector
      ],
      value: 'Scale Testing',
      ensureComboboxOpen: true,
      comboboxActivationSelector: 'input[aria-label="Team"]'
    })
  })

  it('does not borrow an adjacent combobox click selector with a different accessible identity', async () => {
    emit({
      action: 'click',
      selectors: [['#team-before-open'], ['aria/Team[role="combobox"]']],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'team'
    })
    emit({
      action: 'input',
      selectors: [['#project-after-open'], ['aria/Project[role="combobox"]']],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'project',
      value: 'Scale Testing'
    })

    const flow = await writtenUserFlow()
    const change = flow.steps.find(step => step.type === 'change' && step.value === 'Scale Testing')

    expect(change.selectors[0]).toEqual(['#project-after-open'])
  })

  it('marks a stable combobox transition so replay can retry a swallowed activation click', async () => {
    const stableSelectors = [
      ['input[aria-label="Team"]'],
      ['aria/Team[role="combobox"]']
    ]
    emit({
      action: 'click',
      selectors: stableSelectors,
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'team'
    })
    emit({
      action: 'input',
      selectors: stableSelectors,
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'team',
      value: 'Scale Testing'
    })

    const flow = await writtenUserFlow()
    const change = flow.steps.find(step => step.type === 'change' && step.value === 'Scale Testing')

    expect(change.selectors).toEqual(stableSelectors)
    expect(change.ensureComboboxOpen).toBe(true)
    expect(change.comboboxActivationSelector).toBe('input[aria-label="Team"]')
  })

  it('keeps a stable post-open selector for filling when opening replaces the input', async () => {
    emit({
      action: 'click',
      selectors: [['#team-closed'], ['aria/Team[role="combobox"]']],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'closed-team'
    })
    emit({
      action: 'input',
      selectors: [['div.slds-is-open #team-open'], ['aria/Team[role="combobox"]']],
      tagName: 'INPUT',
      inputType: 'text',
      recordingTargetId: 'open-team',
      value: 'Scale Testing'
    })

    const flow = await writtenUserFlow()
    const change = flow.steps.find(step => step.type === 'change' && step.value === 'Scale Testing')

    expect(change).toMatchObject({
      selectors: [
        ['div.slds-is-open #team-open'],
        ['#team-closed'],
        ['aria/Team[role="combobox"]']
      ],
      ensureComboboxOpen: true,
      comboboxActivationSelector: '#team-closed'
    })
  })

  it('does not correlate combobox actions across a same-page navigation', () => {
    const flow = generateUserFlow([
      {
        action: 'click',
        selectors: [['#old-team'], ['aria/Team[role="combobox"]']],
        tagName: 'INPUT',
        inputType: 'text',
        recordingTargetId: 'old-team',
        tabId: 'main',
        eventTime: 1000
      },
      {
        action: 'NAVIGATION',
        value: 'https://example.com/next',
        tabId: 'main',
        eventTime: 1100
      },
      {
        action: 'input',
        selectors: [['#new-team'], ['aria/Team[role="combobox"]']],
        tagName: 'INPUT',
        inputType: 'text',
        recordingTargetId: 'new-team',
        tabId: 'main',
        eventTime: 1200,
        value: 'Scale Testing'
      }
    ], {})
    const change = flow.steps.find(step => step.type === 'change')

    expect(change.selectors[0]).toEqual(['#new-team'])
    expect(change.ensureComboboxOpen).toBeUndefined()
    expect(change.comboboxActivationSelector).toBeUndefined()
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
    // Keep the synthetic interaction timeline after the initial page.goto()
    // completion timestamp captured during test setup.
    const firstEventTime = Date.now() + 1000
    const stableAriaSelector = ['aria/Product Tag[role="textbox"]']
    emit({
      action: 'click',
      eventTime: firstEventTime - 200,
      selectors: [['#open-product-tag']],
      tagName: 'BUTTON'
    })
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
    const optionClick = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#product-tag-option')

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      selectors: [['#product-tag-before-input'], stableAriaSelector],
      duration: 200
    })
    expect(optionClick.duration).toBe(3209)
  })

  it('recomputes delays between retained actions after duplicate changes and ignored keyboard events are filtered', async () => {
    const firstEventTime = Date.now()
    const fieldSelectors = [['#assignee'], ['aria/Assigned To[role="combobox"]']]
    emit({
      action: 'click',
      eventTime: firstEventTime,
      selectors: [['#open-assignee']],
      tagName: 'BUTTON'
    })
    emit({
      action: 'input',
      eventTime: firstEventTime + 100,
      selectors: fieldSelectors,
      tagName: 'INPUT',
      inputType: 'text',
      value: 'S'
    })
    emit({ action: 'keydown', eventTime: firstEventTime + 250, key: 'u', keyCode: 85 })
    emit({ action: 'keyup', eventTime: firstEventTime + 300, key: 'u', keyCode: 85 })
    emit({
      action: 'input',
      eventTime: firstEventTime + 400,
      selectors: fieldSelectors,
      tagName: 'INPUT',
      inputType: 'text',
      value: 'Suraj Varma'
    })
    emit({
      action: 'click',
      eventTime: firstEventTime + 1400,
      selectors: [['#suraj-option']],
      tagName: 'SPAN'
    })

    const flow = await writtenUserFlow()
    const assigneeChange = flow.steps.find((step) => step.type === 'change' && step.value === 'Suraj Varma')
    const optionClick = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#suraj-option')

    expect(assigneeChange.duration).toBe(400)
    expect(optionClick.duration).toBe(1000)
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
    expect(keyDowns).toEqual([
      expect.objectContaining({ type: 'keyDown', target: 'main', key: 'Enter' }),
      expect.objectContaining({ type: 'keyDown', target: 'main', key: 'Escape' })
    ])
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
    expect(anchorStep.assertedEvents).toEqual([{
      type: 'navigation',
      url: 'https://example.com/tab3',
      title: 'Tab 3',
      isNewTabOrWindow: true,
      targetTabId: 'tab-3'
    }])
  })

  it('keeps the new-tab marker when a popup redirects before the next action', async () => {
    emit({ action: 'click', selectors: [['#open-popup']], tagName: 'A', tabId: undefined })
    emit({
      action: 'NAVIGATION',
      value: 'https://example.com/popup-start',
      title: 'Popup start',
      tabId: 'popup-1'
    })
    emit({
      action: 'NAVIGATION',
      value: 'https://example.com/popup-final',
      title: 'Popup final',
      tabId: 'popup-1'
    })

    const flow = await writtenUserFlow()
    const openPopup = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#open-popup')

    expect(openPopup.assertedEvents).toEqual([{
      type: 'navigation',
      url: 'https://example.com/popup-final',
      title: 'Popup final',
      isNewTabOrWindow: true,
      targetTabId: 'popup-1'
    }])
  })

  it('measures post-navigation delay from lifecycle completion instead of the triggering action', async () => {
    const firstEventTime = Date.now()
    emit({
      action: 'click',
      eventTime: firstEventTime,
      selectors: [['#navigate']],
      tagName: 'A'
    })
    emit({
      action: 'NAVIGATION',
      eventTime: firstEventTime + 50,
      value: 'https://example.com/loaded',
      title: 'Loaded'
    })
    emit({
      action: 'click',
      eventTime: firstEventTime + 40050,
      selectors: [['#after-load']],
      tagName: 'BUTTON'
    })

    const flow = await writtenUserFlow()
    const afterLoadClick = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#after-load')

    expect(afterLoadClick.duration).toBe(40000)
  })

  it('does not dedupe changes across a navigation boundary', async () => {
    const firstEventTime = Date.now()
    const selectors = [['#search']]
    emit({
      action: 'input',
      eventTime: firstEventTime,
      selectors,
      tagName: 'INPUT',
      inputType: 'text',
      value: 'before navigation'
    })
    emit({
      action: 'NAVIGATION',
      eventTime: firstEventTime + 50,
      value: 'https://example.com/loaded',
      title: 'Loaded'
    })
    emit({
      action: 'input',
      eventTime: firstEventTime + 1000,
      selectors,
      tagName: 'INPUT',
      inputType: 'text',
      value: 'after navigation'
    })

    const flow = await writtenUserFlow()
    const changes = flow.steps.filter((step) => step.type === 'change')

    expect(changes).toHaveLength(2)
    expect(changes[0].assertedEvents).toEqual([
      { type: 'navigation', url: 'https://example.com/loaded', title: 'Loaded' }
    ])
    expect(changes[1].duration).toBe(950)
  })

  it('preserves a navigation boundary when a matching keyUp is folded into keyDown', async () => {
    const firstEventTime = Date.now()
    emit({ action: 'keydown', eventTime: firstEventTime, key: 'Enter', keyCode: 13 })
    emit({ action: 'keyup', eventTime: firstEventTime + 10, key: 'Enter', keyCode: 13 })
    emit({
      action: 'NAVIGATION',
      eventTime: firstEventTime + 20,
      value: 'https://example.com/results',
      title: 'Results'
    })
    emit({
      action: 'click',
      eventTime: firstEventTime + 5000,
      selectors: [['#after-enter-navigation']],
      tagName: 'BUTTON'
    })

    const flow = await writtenUserFlow()
    const enter = flow.steps.find((step) => step.type === 'keyDown' && step.key === 'Enter')
    const afterNavigation = flow.steps.find(
      (step) => step.selectors?.[0]?.[0] === '#after-enter-navigation'
    )

    expect(enter.assertedEvents).toEqual([
      { type: 'navigation', url: 'https://example.com/results', title: 'Results' }
    ])
    expect(afterNavigation.duration).toBe(4980)
  })

  it('measures the next delay from key release when folding keyDown and keyUp', async () => {
    const firstEventTime = Date.now()
    emit({ action: 'click', eventTime: firstEventTime, selectors: [['#before-key']], tagName: 'BUTTON' })
    emit({ action: 'keydown', eventTime: firstEventTime + 100, key: 'Enter', keyCode: 13 })
    emit({ action: 'keyup', eventTime: firstEventTime + 1100, key: 'Enter', keyCode: 13 })
    emit({
      action: 'click',
      eventTime: firstEventTime + 1200,
      selectors: [['#after-key']],
      tagName: 'BUTTON'
    })

    const flow = await writtenUserFlow()
    const enter = flow.steps.find((step) => step.type === 'keyDown' && step.key === 'Enter')
    const afterKey = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#after-key')

    expect(enter.duration).toBe(100)
    expect(enter.keyPressDuration).toBe(1000)
    expect(afterKey.duration).toBe(100)
  })

  it('keeps later delays stable when event timestamps arrive out of order', async () => {
    const firstEventTime = Date.now()
    emit({ action: 'click', eventTime: firstEventTime, selectors: [['#first']], tagName: 'BUTTON' })
    emit({ action: 'click', eventTime: firstEventTime - 100, selectors: [['#late']], tagName: 'BUTTON' })
    emit({ action: 'click', eventTime: firstEventTime + 100, selectors: [['#third']], tagName: 'BUTTON' })

    const flow = await writtenUserFlow()
    const clicks = flow.steps.filter((step) => step.type === 'click')

    expect(clicks.map((step) => step.selectors[0][0])).toEqual(['#first', '#late', '#third'])
    expect(clicks.slice(1).map((step) => step.duration)).toEqual([0, 100])
  })

  it('measures the next delay from the recorded tab-close time', async () => {
    const firstEventTime = Date.now()
    emit({
      action: 'click',
      eventTime: firstEventTime,
      selectors: [['#close-tab']],
      tagName: 'BUTTON'
    })
    emit({
      action: 'WINDOW_OR_TAB_CLOSED',
      eventTime: firstEventTime + 1000,
      tabId: undefined
    })
    emit({
      action: 'click',
      eventTime: firstEventTime + 1500,
      selectors: [['#after-close']],
      tagName: 'BUTTON'
    })

    const flow = await writtenUserFlow()
    const afterClose = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#after-close')

    expect(flow.timingVersion).toBe(2)
    expect(afterClose.duration).toBe(500)
  })

  it('preserves popup dwell time separately from the delay after closing it', () => {
    const flow = generateUserFlow([
      {
        action: 'GOTO',
        href: 'https://example.com',
        eventTime: 0,
        endEventTime: 0,
        tabId: 'main'
      },
      {
        action: 'click',
        selectors: [['#open-popup']],
        tagName: 'A',
        eventTime: 1000,
        tabId: 'main'
      },
      {
        action: 'NAVIGATION',
        value: 'https://example.com/popup',
        eventTime: 1100,
        tabId: 'popup'
      },
      {
        action: 'WINDOW_OR_TAB_CLOSED',
        eventTime: 6100,
        tabId: 'popup'
      },
      {
        action: 'click',
        selectors: [['#after-popup']],
        tagName: 'BUTTON',
        eventTime: 7000,
        tabId: 'main'
      }
    ], {})

    const openPopup = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#open-popup')
    const closePopup = flow.steps.find((step) => step.type === 'close' && step.tabId === 'popup')
    const afterPopup = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#after-popup')

    expect(openPopup.closeDelay).toBeUndefined()
    expect(closePopup.duration).toBe(5000)
    expect(afterPopup.duration).toBe(900)
  })

  it('marks a manual popup close explicitly after interactions inside the popup', () => {
    const flow = generateUserFlow([
      { action: 'GOTO', href: 'https://example.com', eventTime: 0, endEventTime: 0, tabId: 'main' },
      {
        action: 'click',
        selectors: [['#open-popup']],
        tagName: 'A',
        eventTime: 1000,
        tabId: 'main'
      },
      {
        action: 'NAVIGATION',
        value: 'https://example.com/popup',
        eventTime: 1100,
        tabId: 'popup'
      },
      {
        action: 'click',
        selectors: [['#inside-popup']],
        tagName: 'BUTTON',
        eventTime: 2000,
        tabId: 'popup'
      },
      { action: 'WINDOW_OR_TAB_CLOSED', eventTime: 6000, tabId: 'popup' },
      {
        action: 'click',
        selectors: [['#back-on-opener']],
        tagName: 'BUTTON',
        eventTime: 7000,
        tabId: 'main'
      }
    ], {})

    const insidePopup = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#inside-popup')
    const closePopup = flow.steps.find((step) => step.type === 'close' && step.tabId === 'popup')
    const backOnOpener = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#back-on-opener')

    expect(insidePopup.assertedEvents).toBeUndefined()
    expect(closePopup).toMatchObject({ type: 'close', tabId: 'popup', duration: 4000 })
    expect(backOnOpener.duration).toBe(1000)
  })

  it('associates navigation and close lifecycle events with actions from the matching tab', () => {
    const flow = generateUserFlow([
      { action: 'GOTO', href: 'https://example.com', eventTime: 0, endEventTime: 0, tabId: 'main' },
      {
        action: 'click',
        selectors: [['#open-popup']],
        tagName: 'BUTTON',
        eventTime: 100,
        tabId: 'main'
      },
      {
        action: 'NAVIGATION',
        value: 'https://example.com/popup',
        eventTime: 150,
        tabId: 'popup',
        openerTabId: 'main'
      },
      {
        action: 'click',
        selectors: [['#popup-before-main-nav']],
        tagName: 'BUTTON',
        eventTime: 200,
        tabId: 'popup'
      },
      {
        action: 'click',
        selectors: [['#trigger-main-nav']],
        tagName: 'A',
        eventTime: 300,
        tabId: 'main'
      },
      {
        action: 'click',
        selectors: [['#last-popup-action']],
        tagName: 'BUTTON',
        eventTime: 350,
        tabId: 'popup'
      },
      {
        action: 'NAVIGATION',
        value: 'https://example.com/main-next',
        eventTime: 400,
        tabId: 'main'
      },
      { action: 'WINDOW_OR_TAB_CLOSED', eventTime: 500, tabId: 'popup' }
    ], {})

    const mainTrigger = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#trigger-main-nav')
    const lastPopupAction = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#last-popup-action')
    const closePopup = flow.steps.find((step) => step.type === 'close' && step.tabId === 'popup')
    const unrelatedPopupAction = flow.steps.find(
      (step) => step.selectors?.[0]?.[0] === '#popup-before-main-nav'
    )

    expect(mainTrigger.assertedEvents).toEqual([{
      type: 'navigation',
      url: 'https://example.com/main-next',
      title: ''
    }])
    expect(lastPopupAction.assertedEvents).toBeUndefined()
    expect(closePopup).toMatchObject({ type: 'close', tabId: 'popup', duration: 100 })
    expect(unrelatedPopupAction.assertedEvents).toBeUndefined()
  })

  it('keeps an interleaved popup close at its global chronological position', () => {
    const flow = generateUserFlow([
      { action: 'GOTO', href: 'https://example.com', eventTime: 0, endEventTime: 0, tabId: 'main' },
      {
        action: 'click', selectors: [['#open']], tagName: 'BUTTON', eventTime: 100, tabId: 'main'
      },
      {
        action: 'NAVIGATION',
        value: 'https://example.com/popup',
        eventTime: 150,
        tabId: 'popup',
        openerTabId: 'main'
      },
      {
        action: 'click', selectors: [['#popup-action']], tagName: 'BUTTON', eventTime: 200, tabId: 'popup'
      },
      {
        action: 'click', selectors: [['#main-before-close']], tagName: 'BUTTON', eventTime: 300, tabId: 'main'
      },
      { action: 'WINDOW_OR_TAB_CLOSED', eventTime: 400, tabId: 'popup' },
      {
        action: 'click', selectors: [['#main-after-close']], tagName: 'BUTTON', eventTime: 500, tabId: 'main'
      }
    ], {})

    const popupAction = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#popup-action')
    const beforeClose = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#main-before-close')
    const closePopup = flow.steps.find((step) => step.type === 'close' && step.tabId === 'popup')
    const afterClose = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#main-after-close')

    expect(popupAction.assertedEvents).toBeUndefined()
    expect(beforeClose).toMatchObject({ tabId: 'main' })
    expect(beforeClose.assertedEvents).toBeUndefined()
    expect(closePopup).toMatchObject({ type: 'close', tabId: 'popup', duration: 100 })
    expect(afterClose.duration).toBe(100)
  })

  it('merges delayed cross-tab actions by source time before placing lifecycle events', () => {
    const captured = (event, time, sequence, streamId) => ({
      ...event,
      __orderEventTime: time,
      __orderPriority: 0,
      __recordingSequence: sequence,
      __streamId: streamId
    })
    const lifecycle = (event, time, sequence) => ({
      ...event,
      __orderEventTime: time,
      __orderPriority: 1,
      __recordingSequence: sequence
    })
    const flow = generateUserFlow([
      captured({
        action: 'GOTO', href: 'https://example.com', eventTime: 0, endEventTime: 0, tabId: 'main'
      }, 0, 0, 'main-document'),
      captured({
        action: 'click', selectors: [['#open']], tagName: 'BUTTON', eventTime: 100, tabId: 'main'
      }, 100, 1, 'main-document'),
      lifecycle({
        action: 'NAVIGATION', value: 'https://example.com/popup', eventTime: 110,
        tabId: 'popup', openerTabId: 'main'
      }, 110, 2),
      // This newer main-page action arrives before the popup's older message.
      captured({
        action: 'click', selectors: [['#main-after-close']], tagName: 'BUTTON',
        eventTime: 500, tabId: 'main'
      }, 500, 3, 'main-document'),
      captured({
        action: 'click', selectors: [['#popup-action']], tagName: 'BUTTON',
        eventTime: 200, tabId: 'popup'
      }, 200, 4, 'popup-document'),
      lifecycle({ action: 'WINDOW_OR_TAB_CLOSED', eventTime: 400, tabId: 'popup' }, 400, 5)
    ], {})

    const replayOrder = flow.steps
      .filter((step) => step.type === 'click' || step.type === 'close')
      .map((step) => step.type === 'close' ? `close:${step.tabId}` : step.selectors[0][0])
    const closePopup = flow.steps.find((step) => step.type === 'close')
    const afterClose = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#main-after-close')

    expect(replayOrder).toEqual(['#open', '#popup-action', 'close:popup', '#main-after-close'])
    expect(closePopup.duration).toBe(200)
    expect(afterClose.duration).toBe(100)
  })

  it('merges old and new document streams independently even when they share a tab id', () => {
    const flow = generateUserFlow([
      {
        action: 'GOTO', href: 'https://example.com', eventTime: 0, endEventTime: 0, tabId: 'main',
        __orderEventTime: 0, __orderPriority: 0, __recordingSequence: 0
      },
      // The new document's message reaches the server first.
      {
        action: 'click', selectors: [['#new-document']], tagName: 'BUTTON', eventTime: 500,
        tabId: 'main', __streamId: 'new-document', __orderEventTime: 500,
        __orderPriority: 0, __recordingSequence: 1
      },
      {
        action: 'click', selectors: [['#old-document-trigger']], tagName: 'A', eventTime: 100,
        tabId: 'main', __streamId: 'old-document', __orderEventTime: 100,
        __orderPriority: 0, __recordingSequence: 2
      },
      {
        action: 'NAVIGATION', value: 'https://example.com/next', eventTime: 300, tabId: 'main',
        __orderEventTime: 300, __orderPriority: 1, __recordingSequence: 3
      }
    ], {})

    const clicks = flow.steps.filter((step) => step.type === 'click')
    expect(clicks.map((step) => step.selectors[0][0])).toEqual([
      '#old-document-trigger',
      '#new-document'
    ])
    expect(clicks[0].assertedEvents).toEqual([{
      type: 'navigation',
      url: 'https://example.com/next',
      title: ''
    }])
    expect(clicks[1].duration).toBe(200)
  })

  it('represents consecutive popup closes as separate timed steps', () => {
    const flow = generateUserFlow([
      { action: 'GOTO', href: 'https://example.com', eventTime: 0, endEventTime: 0, tabId: 'main' },
      { action: 'click', selectors: [['#open-one']], tagName: 'BUTTON', eventTime: 100, tabId: 'main' },
      {
        action: 'NAVIGATION', value: 'https://example.com/one', eventTime: 110,
        tabId: 'popup-1', openerTabId: 'main'
      },
      { action: 'click', selectors: [['#open-two']], tagName: 'BUTTON', eventTime: 200, tabId: 'main' },
      {
        action: 'NAVIGATION', value: 'https://example.com/two', eventTime: 210,
        tabId: 'popup-2', openerTabId: 'main'
      },
      { action: 'WINDOW_OR_TAB_CLOSED', eventTime: 300, tabId: 'popup-1' },
      { action: 'WINDOW_OR_TAB_CLOSED', eventTime: 400, tabId: 'popup-2' }
    ], {})

    expect(flow.steps.filter((step) => step.type === 'close')).toEqual([
      { type: 'close', target: 'main', tabId: 'popup-1', duration: 90 },
      { type: 'close', target: 'main', tabId: 'popup-2', duration: 100 }
    ])
  })

  it('keeps a popup close replayable when a screenshot is the preceding raw event', () => {
    const flow = generateUserFlow([
      { action: 'GOTO', href: 'https://example.com', eventTime: 0, endEventTime: 0, tabId: 'main' },
      { action: 'click', selectors: [['#open']], tagName: 'BUTTON', eventTime: 100, tabId: 'main' },
      {
        action: 'NAVIGATION', value: 'https://example.com/popup', eventTime: 110,
        tabId: 'popup', openerTabId: 'main'
      },
      { action: 'click', selectors: [['#inside']], tagName: 'BUTTON', eventTime: 200, tabId: 'popup' },
      { action: 'SCREENSHOT', value: 'before-close' },
      { action: 'WINDOW_OR_TAB_CLOSED', eventTime: 500, tabId: 'popup' }
    ], {})

    expect(flow.steps.find((step) => step.type === 'close')).toEqual({
      type: 'close', target: 'main', tabId: 'popup', duration: 300
    })
  })

  it('uses the latest lifecycle end when navigation completes after keyup', () => {
    const flow = generateUserFlow([
      { action: 'keydown', key: 'Enter', keyCode: 13, eventTime: 100 },
      {
        action: 'NAVIGATION',
        value: 'https://example.com/results',
        eventTime: 1000,
        tabId: 'main'
      },
      { action: 'keyup', key: 'Enter', keyCode: 13, eventTime: 200 },
      {
        action: 'click',
        selectors: [['#after-navigation']],
        tagName: 'BUTTON',
        eventTime: 1100,
        tabId: 'main'
      }
    ], {})

    const afterNavigation = flow.steps.find((step) => step.selectors?.[0]?.[0] === '#after-navigation')
    expect(afterNavigation.duration).toBe(100)
  })

  it('does not turn keyup into a completion time for an unfinished navigation', () => {
    const flow = generateUserFlow([
      { action: 'GOTO', href: 'https://example.com', eventTime: 0, endEventTime: 0, tabId: 'main' },
      { action: 'keydown', key: 'Enter', keyCode: 13, eventTime: 100 },
      {
        action: 'NAVIGATION',
        value: 'https://example.com/results',
        tabId: 'main'
      },
      { action: 'keyup', key: 'Enter', keyCode: 13, eventTime: 200 },
      {
        action: 'click',
        selectors: [['#after-unfinished-navigation']],
        tagName: 'BUTTON',
        eventTime: 5000,
        tabId: 'main'
      }
    ], {})

    const enter = flow.steps.find((step) => step.type === 'keyDown')
    const afterNavigation = flow.steps.find(
      (step) => step.selectors?.[0]?.[0] === '#after-unfinished-navigation'
    )

    expect(enter.keyPressDuration).toBe(100)
    expect(afterNavigation.duration).toBe(0)
  })

  it('measures a folded keyboard popup close from navigation completion', () => {
    const flow = generateUserFlow([
      { action: 'GOTO', href: 'https://example.com', eventTime: 0, endEventTime: 0, tabId: 'main' },
      { action: 'keydown', key: 'Enter', keyCode: 13, eventTime: 100 },
      {
        action: 'NAVIGATION',
        value: 'https://example.com/popup',
        eventTime: 1000,
        tabId: 'popup'
      },
      { action: 'keyup', key: 'Enter', keyCode: 13, eventTime: 200 },
      { action: 'WINDOW_OR_TAB_CLOSED', eventTime: 6000, tabId: 'popup' },
      {
        action: 'click',
        selectors: [['#after-keyboard-popup']],
        tagName: 'BUTTON',
        eventTime: 7000,
        tabId: 'main'
      }
    ], {})

    const enter = flow.steps.find((step) => step.type === 'keyDown')
    const closePopup = flow.steps.find((step) => step.type === 'close' && step.tabId === 'popup')
    const afterPopup = flow.steps.find(
      (step) => step.selectors?.[0]?.[0] === '#after-keyboard-popup'
    )

    expect(enter).toMatchObject({ keyPressDuration: 100 })
    expect(closePopup).toMatchObject({ type: 'close', tabId: 'popup', duration: 5000 })
    expect(afterPopup.duration).toBe(1000)
  })

  it('collapses keyboard popup redirects to one final new-tab navigation', () => {
    const flow = generateUserFlow([
      {
        action: 'GOTO',
        href: 'https://example.com',
        eventTime: 0,
        endEventTime: 0,
        tabId: 'main'
      },
      { action: 'keydown', key: 'Enter', keyCode: 13, eventTime: 100 },
      {
        action: 'NAVIGATION',
        value: 'https://example.com/popup-start',
        eventTime: 150,
        tabId: 'popup'
      },
      { action: 'keyup', key: 'Enter', keyCode: 13, eventTime: 200 },
      {
        action: 'NAVIGATION',
        value: 'https://example.com/popup-final',
        eventTime: 250,
        tabId: 'popup'
      }
    ], {})

    const enter = flow.steps.find((step) => step.type === 'keyDown')
    expect(enter.assertedEvents).toEqual([{
      type: 'navigation',
      url: 'https://example.com/popup-final',
      title: '',
      isNewTabOrWindow: true,
      targetTabId: 'popup'
    }])
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
