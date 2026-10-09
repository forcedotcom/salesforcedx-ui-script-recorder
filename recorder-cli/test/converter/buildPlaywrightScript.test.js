import { getScriptBody } from '../../src/converter/buildPlaywrightScript.js'
import { ChangeAction } from '../../src/converter/scriptHandlers/ChangeAction.js'
import { AssertAction } from '../../src/converter/scriptHandlers/AssertAction.js'
import { FrameAction } from '../../src/converter/scriptHandlers/FrameAction.js'

describe('getScriptBody', () => {
  it('resets declared credential vars for each new conversion', () => {
    const spy = jest.spyOn(ChangeAction, 'resetDeclaredVars')
    getScriptBody({ steps: [] })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('returns an empty string for no steps', () => {
    expect(getScriptBody({ steps: [] })).toBe('')
  })

  it('ignores steps with an unrecognised type', () => {
    expect(getScriptBody({ steps: [{ type: 'unknownType' }] })).toBe('')
  })

  it('dispatches a click step through ClickAction', () => {
    const result = getScriptBody({ steps: [{ type: 'click', selectors: [['#btn']] }] })
    expect(result).toBe("\nawait page.click('#btn');")
  })

  it('converts a positional list option click to a parent-scoped Playwright text selector', () => {
    const result = getScriptBody({
      steps: [{
        type: 'click',
        selectors: [['#field li:nth-child(3) span.option'], ['text/Scale Testing EngScale']],
        parentSelectors: [['#field ul[role="listbox"]']],
        componentType: 'list'
      }]
    })

    expect(result).toContain(
      'await page.click(\'#field ul[role="listbox"] >> :text("Scale Testing EngScale")\');'
    )
    expect(result.split('\n').at(-1)).not.toContain('li:nth-child(3) span.option')
  })

  it('dispatches a doubleClick step through ClickAction (which always emits a click call)', () => {
    const result = getScriptBody({ steps: [{ type: 'doubleClick', selectors: [['#btn']] }] })
    expect(result).toBe("\nawait page.click('#btn');")
  })

  it('dispatches a change step through ChangeAction', () => {
    const result = getScriptBody({ steps: [{ type: 'change', inputType: 'text', value: 'hi', selectors: [['#inp']] }] })
    expect(result).toContain("await page.fill('#inp', 'hi');")
  })

  it('dispatches an assert step through AssertAction', () => {
    const result = getScriptBody({ steps: [{ type: 'assert', selectors: [['#msg']] }] })
    expect(result).toBe("await expect(page.locator('#msg')).toBeVisible();")
  })

  it('dispatches navigate/setViewport/keyDown/keyUp steps to their handlers', () => {
    const result = getScriptBody({
      steps: [
        { type: 'navigate', url: 'https://example.com' },
        { type: 'setViewport', width: 100, height: 200 },
        { type: 'keyDown', key: 'Enter' },
        { type: 'keyUp', key: 'Enter' }
      ]
    })

    expect(result.split('\n')).toEqual([
      "await page.goto('https://example.com');",
      'await page.setViewportSize({ width: 100, height: 200 });',
      "await page.keyboard.press('Enter');",
      "await page.keyboard.press('Enter');"
    ])
  })

  it('inserts a delay before the current action when the step specifies a duration', () => {
    const result = getScriptBody({ steps: [{ type: 'navigate', url: 'https://example.com', duration: 500 }] })
    expect(result).toBe("await delay(500)\nawait page.goto('https://example.com');")
  })

  it('does not append a delay line when duration is absent', () => {
    const result = getScriptBody({ steps: [{ type: 'navigate', url: 'https://example.com' }] })
    expect(result).not.toContain('delay(')
  })

  it.each([-1, Number.POSITIVE_INFINITY, '500'])('does not emit an invalid delay value (%p)', (duration) => {
    const result = getScriptBody({
      steps: [{ type: 'click', selectors: [['#button']], duration }]
    })

    expect(result).not.toContain('delay(')
  })

  it('does not replay navigation load time before the next action from an existing recording', () => {
    const result = getScriptBody({
      steps: [
        {
          type: 'click',
          selectors: [['#submit']],
          duration: 100,
          assertedEvents: [{ type: 'navigation', url: 'https://example.com/home' }]
        },
        { type: 'click', selectors: [['#global-nav']], duration: 39401 },
        { type: 'click', selectors: [['#new']], duration: 2866 }
      ]
    })

    expect(result).not.toContain('delay(39401)')
    expect(result.indexOf('await delay(2866)')).toBeLessThan(result.indexOf("await page.click('#new')"))
  })

  it('preserves post-load user wait from recordings with lifecycle completion timing', () => {
    const result = getScriptBody({
      timingVersion: 2,
      steps: [
        {
          type: 'click',
          selectors: [['#submit']],
          assertedEvents: [{ type: 'navigation', url: 'https://example.com/home' }]
        },
        { type: 'click', selectors: [['#after-load']], duration: 2200 }
      ]
    })

    expect(result).toContain('await delay(2200)')
    expect(result.indexOf('await delay(2200)')).toBeLessThan(result.indexOf("await page.click('#after-load')"))
  })

  it('does not discard a legacy delay after a tab close', () => {
    const result = getScriptBody({
      steps: [
        {
          type: 'click',
          selectors: [['#close']],
          assertedEvents: [{ type: 'windowOrTabClose' }]
        },
        { type: 'click', selectors: [['#after-close']], duration: 1800 }
      ]
    })

    expect(result).toContain('await delay(1800)')
    expect(result.indexOf('await delay(1800)')).toBeLessThan(result.indexOf("await page.click('#after-close')"))
    expect(result).toContain('if (!page.isClosed()) {')
    expect(result).toContain('await page.close();')
    expect(result).not.toContain("waitForEvent('close')")
  })

  it('replays reload and treats its completion as a timing boundary', () => {
    const result = getScriptBody({
      steps: [
        { type: 'click', selectors: [['#before']], duration: 100 },
        { type: 'reload', duration: 500 },
        { type: 'click', selectors: [['#after']], duration: 3000 }
      ]
    })

    expect(result).toContain('await delay(500)\nawait page.reload();')
    expect(result).not.toContain('delay(3000)')
    expect(result).toContain("await page.click('#after');")
  })

  it('routes click steps with frameSelectors through FrameAction instead of the actions map', () => {
    const result = getScriptBody({
      steps: [{ type: 'click', frameSelectors: ['#frame1'], selectors: [['#btn']] }]
    })

    expect(result).toBe(
      ["const frame0 = page.frameLocator('#frame1');", "const frameAction0 = frame0.locator('#btn');", 'await frameAction0.click()'].join(
        '\n'
      )
    )
  })

  it.each([
    {
      type: 'click',
      duration: 321,
      selectors: [['#btn']],
      expectedAction: 'await frameAction0.click()'
    },
    {
      type: 'change',
      duration: 654,
      value: 'hi',
      selectors: [['#inp']],
      expectedAction: "await frameAction0.fill('hi');"
    }
  ])('inserts the current step duration before a frame-scoped $type action', ({ expectedAction, ...step }) => {
    const result = getScriptBody({
      steps: [{ ...step, frameSelectors: ['#frame1'] }]
    })

    expect(result.indexOf(`await delay(${step.duration})`)).toBeLessThan(result.indexOf(expectedAction))
  })

  it('keeps the stable list-option fallback when the click is inside a frame', () => {
    const result = getScriptBody({
      steps: [{
        type: 'click',
        frameSelectors: ['#frame1'],
        selectors: [['#field li:nth-child(3) span.option'], ['text/Scale Testing EngScale']],
        parentSelectors: [['#field ul[role="listbox"]']],
        componentType: 'list'
      }]
    })

    expect(result).toContain(
      'frame0.locator(\'#field ul[role="listbox"] >> :text("Scale Testing EngScale")\')'
    )
    expect(result).not.toContain("locator('#field li:nth-child(3) span.option')")
  })

  it('arms and awaits a framed popup close before restoring the opener', () => {
    const result = getScriptBody({
      timingVersion: 2,
      steps: [
        {
          type: 'click',
          selectors: [['#open']],
          assertedEvents: [{ isNewTabOrWindow: true }]
        },
        {
          type: 'click',
          frameSelectors: ['#frame'],
          selectors: [['#close']],
          assertedEvents: [{ type: 'windowOrTabClose' }]
        },
        { type: 'click', selectors: [['#opener']] }
      ]
    })

    expect(result).toContain("const pageCloseEvent2 = tab1.waitForEvent('close');")
    expect(result).toContain("const frame0 = tab1.frameLocator('#frame');")
    expect(result).toContain('await pageCloseEvent2;')
    expect(result).toContain("await page.click('#opener');")
  })

  it('routes interleaved opener and popup actions by their recorded tab ids', () => {
    const result = getScriptBody({
      timingVersion: 2,
      steps: [
        { type: 'navigate', tabId: 'main', url: 'https://example.com' },
        {
          type: 'click',
          tabId: 'main',
          selectors: [['#open-popup']],
          assertedEvents: [{
            type: 'navigation',
            url: 'https://example.com/popup',
            isNewTabOrWindow: true,
            targetTabId: 'popup'
          }]
        },
        { type: 'click', tabId: 'popup', selectors: [['#popup-action']] },
        {
          type: 'click',
          tabId: 'main',
          frameSelectors: ['#main-frame'],
          selectors: [['#main-frame-action']]
        },
        {
          type: 'click',
          tabId: 'main',
          selectors: [['#main-before-close']],
          explicitClose: true,
          closeDelay: 250,
          assertedEvents: [{ type: 'windowOrTabClose', targetTabId: 'popup' }]
        },
        { type: 'click', tabId: 'main', selectors: [['#main-after-close']] }
      ]
    })

    expect(result).toContain("await tab1.click('#popup-action');")
    expect(result).toContain("const frame0 = page.frameLocator('#main-frame');")
    expect(result).toContain("await page.click('#main-before-close');\nawait delay(250)\nif (!tab1.isClosed()) {")
    expect(result).toContain('  await tab1.close();')
    expect(result).toContain("await page.click('#main-after-close');")
  })

  it('can close two recorded popups out of LIFO order', () => {
    const result = getScriptBody({
      timingVersion: 2,
      steps: [
        { type: 'navigate', tabId: 'main', url: 'https://example.com' },
        {
          type: 'click',
          tabId: 'main',
          selectors: [['#open-one']],
          assertedEvents: [{ isNewTabOrWindow: true, targetTabId: 'popup-1' }]
        },
        {
          type: 'click',
          tabId: 'main',
          selectors: [['#open-two']],
          assertedEvents: [{ isNewTabOrWindow: true, targetTabId: 'popup-2' }]
        },
        {
          type: 'click',
          tabId: 'popup-1',
          selectors: [['#close-one']],
          explicitClose: true,
          assertedEvents: [{ type: 'windowOrTabClose', targetTabId: 'popup-1' }]
        },
        { type: 'click', tabId: 'popup-2', selectors: [['#still-on-two']] },
        { type: 'click', tabId: 'main', selectors: [['#back-main']] }
      ]
    })

    expect(result).toContain("await tab1.click('#close-one');")
    expect(result).toContain('  await tab1.close();')
    expect(result).toContain("await tab2.click('#still-on-two');")
    expect(result).toContain("await page.click('#back-main');")
  })

  it('replays consecutive close steps independently with their recorded gaps', () => {
    const result = getScriptBody({
      timingVersion: 2,
      steps: [
        { type: 'navigate', tabId: 'main', url: 'https://example.com' },
        {
          type: 'click',
          tabId: 'main',
          selectors: [['#open-one']],
          assertedEvents: [{ isNewTabOrWindow: true, targetTabId: 'popup-1' }]
        },
        {
          type: 'click',
          tabId: 'main',
          selectors: [['#open-two']],
          assertedEvents: [{ isNewTabOrWindow: true, targetTabId: 'popup-2' }]
        },
        { type: 'close', tabId: 'popup-1', duration: 300 },
        { type: 'close', tabId: 'popup-2', duration: 100 }
      ]
    })

    expect(result).toContain('await delay(300)\nif (!tab1.isClosed()) {')
    expect(result).toContain('await delay(100)\nif (!tab2.isClosed()) {')
    expect(result.match(/\.close\(\);/g)).toHaveLength(2)
  })

  it('routes change steps with frameSelectors through FrameAction', () => {
    const result = getScriptBody({
      steps: [{ type: 'change', frameSelectors: ['#frame1'], value: 'hi', selectors: [['#inp']] }]
    })

    expect(result).toContain("const frame0 = page.frameLocator('#frame1');")
    expect(result).toContain("const frameAction0 = frame0.locator('#inp');")
    expect(result).toContain("await frameAction0.fill('hi');")
  })

  it('does not route through FrameAction when frameSelectors are present but the type is not click/change', () => {
    const spy = jest.spyOn(FrameAction.prototype, 'handle')
    const result = getScriptBody({
      steps: [{ type: 'assert', frameSelectors: ['#frame1'], selectors: [['#msg']] }]
    })

    expect(spy).not.toHaveBeenCalled()
    expect(result).toBe("await expect(page.locator('#msg')).toBeVisible();")
    spy.mockRestore()
  })

  it('tolerates a falsy result from FrameAction.handle', () => {
    const spy = jest.spyOn(FrameAction.prototype, 'handle').mockReturnValueOnce(null)
    const result = getScriptBody({
      steps: [{ type: 'click', frameSelectors: ['#frame1'], selectors: [['#btn']] }]
    })

    expect(result).toBe('')
    spy.mockRestore()
  })

  it('tolerates a falsy result from an action handler', () => {
    const spy = jest.spyOn(AssertAction.prototype, 'handle').mockReturnValueOnce(null)
    const result = getScriptBody({ steps: [{ type: 'assert', selectors: [['#msg']] }] })

    expect(result).toBe('')
    spy.mockRestore()
  })

  it('executes page-controlled strings only as action arguments', async () => {
    const selector = "#x'); globalThis.__recorderInjected = true; //"
    const value = "value'); globalThis.__recorderInjected = true; //\nsecond line"
    const url = "https://example.test/'); globalThis.__recorderInjected = true; //"
    const key = "Enter'); globalThis.__recorderInjected = true; //"
    const calls = []
    const locator = selected => ({
      setChecked: async checked => calls.push(['setChecked', selected, checked]),
      selectOption: async option => calls.push(['selectOption', selected, option])
    })
    const page = {
      click: async selected => calls.push(['click', selected]),
      fill: async (selected, filled) => calls.push(['fill', selected, filled]),
      goto: async destination => calls.push(['goto', destination]),
      keyboard: { press: async pressed => calls.push(['press', pressed]) },
      locator
    }
    const source = getScriptBody({
      steps: [
        { type: 'click', selectors: [[selector]] },
        { type: 'change', inputType: 'text', selectors: [['#field']], value },
        { type: 'change', inputType: 'select-one', selectors: [['#select']], value },
        { type: 'navigate', url },
        { type: 'keyDown', key }
      ]
    })

    globalThis.__recorderInjected = false
    try {
      const execute = new Function('page', 'delay', `return (async () => {${source}})()`)
      await execute(page, async () => {})
      expect(globalThis.__recorderInjected).toBe(false)
      expect(calls).toEqual([
        ['click', selector],
        ['fill', '#field', value],
        ['selectOption', '#select', value],
        ['goto', url],
        ['press', key]
      ])
    } finally {
      delete globalThis.__recorderInjected
    }
  })

  it.each([
    ['does not repeat a successful activation click', 'true', 1],
    ['retries one swallowed activation click', 'false', 2],
    ['does not guess that a missing aria-expanded attribute means closed', null, 1]
  ])('%s for a marked searchable combobox', async (_name, stateAfterFirstClick, expectedClicks) => {
    let expanded = 'false'
    let clicks = 0
    const fills = []
    const activate = async () => {
      clicks++
      expanded = clicks === 1 ? stateAfterFirstClick : 'true'
    }
    const activationLocator = {
      first() { return this },
      isVisible: async () => true,
      getAttribute: async attribute => attribute === 'aria-expanded' ? expanded : null,
      click: activate
    }
    const page = {
      click: activate,
      fill: async (selector, value) => fills.push([selector, value]),
      locator: () => activationLocator
    }
    const source = getScriptBody({
      steps: [
        {
          type: 'click',
          selectors: [['input[aria-label="Team"]']],
          tagName: 'INPUT',
          inputType: 'text'
        },
        {
          type: 'change',
          selectors: [['input[aria-label="Team"]'], ['aria/Team[role="combobox"]']],
          tagName: 'INPUT',
          inputType: 'text',
          ensureComboboxOpen: true,
          value: 'Scale Testing'
        }
      ]
    })

    const execute = new Function('page', `return (async () => {${source}})()`)
    await execute(page)

    expect(clicks).toBe(expectedClicks)
    expect(fills).toEqual([['input[aria-label="Team"]', 'Scale Testing']])
  })

  it('fills the post-open input when a successful click replaces the activator', async () => {
    let activationVisible = true
    let activationAttributeRead = false
    const fills = []
    const activate = async () => {
      activationVisible = false
    }
    const page = {
      click: activate,
      fill: async (selector, value) => fills.push([selector, value]),
      locator: selector => {
        const locator = {
          first() { return this },
          isVisible: async () => selector === '#team-closed' ? activationVisible : true,
          getAttribute: async () => {
            activationAttributeRead = true
            throw new Error('the replaced activator must not be queried')
          },
          click: activate
        }
        return locator
      }
    }
    const source = getScriptBody({
      steps: [
        {
          type: 'click',
          selectors: [['#team-closed']],
          tagName: 'INPUT',
          inputType: 'text'
        },
        {
          type: 'change',
          selectors: [['div.slds-is-open #team-open'], ['aria/Team[role="combobox"]']],
          tagName: 'INPUT',
          inputType: 'text',
          ensureComboboxOpen: true,
          comboboxActivationSelector: '#team-closed',
          value: 'Scale Testing'
        }
      ]
    })

    const execute = new Function('page', `return (async () => {${source}})()`)
    await execute(page)

    expect(activationAttributeRead).toBe(false)
    expect(fills).toEqual([['div.slds-is-open #team-open', 'Scale Testing']])
  })

  it('keeps malicious frame and child selectors inside string literals', async () => {
    const frameSelector = "iframe[title=\"x'); globalThis.__frameInjected = true; //\"]"
    const clickSelector = "#button'); globalThis.__frameInjected = true; //"
    const calls = []
    const page = {
      frameLocator: selectedFrame => ({
        locator: selected => ({
          click: async () => calls.push([selectedFrame, selected])
        })
      })
    }
    const source = getScriptBody({
      steps: [{
        type: 'click',
        frameSelectors: [frameSelector],
        selectors: [[clickSelector]]
      }]
    })

    globalThis.__frameInjected = false
    try {
      const execute = new Function('page', `return (async () => {${source}})()`)
      await execute(page)
      expect(globalThis.__frameInjected).toBe(false)
      expect(calls).toEqual([[frameSelector, clickSelector]])
    } finally {
      delete globalThis.__frameInjected
    }
  })
})
