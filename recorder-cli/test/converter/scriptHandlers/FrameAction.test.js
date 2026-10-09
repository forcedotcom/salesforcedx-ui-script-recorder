import { FrameAction } from '../../../src/converter/scriptHandlers/FrameAction.js'
import { ClickAction } from '../../../src/converter/scriptHandlers/ClickAction.js'
import { ChangeAction } from '../../../src/converter/scriptHandlers/ChangeAction.js'
import { Stack } from '../../../src/converter/Stack.js'

describe('FrameAction', () => {
  const buildAction = (context = { page: 'page' }, stack = new Stack()) => new FrameAction(stack, context, { value: 0 })

  it('returns no actions when the step has no frameSelectors', () => {
    const action = buildAction()
    expect(action.handle({ type: 'click' })).toEqual([])
    expect(action.handle({ type: 'click', frameSelectors: [] })).toEqual([])
  })

  it('falls back to "page" when the stack is empty', () => {
    const action = buildAction()
    const result = action.handle({ type: 'assert', frameSelectors: ['#frame1'] })
    expect(result).toEqual(["const frame0 = page.frameLocator('#frame1');"])
  })

  it('bases the frame locator on the current page from the stack', () => {
    const stack = new Stack()
    stack.push('tab0')
    const action = buildAction({ page: 'tab0' }, stack)

    const result = action.handle({ type: 'assert', frameSelectors: ['#frame1'] })

    expect(result).toEqual(["const frame0 = tab0.frameLocator('#frame1');"])
  })

  it('chains multiple frame selectors', () => {
    const action = buildAction()
    const result = action.handle({ type: 'assert', frameSelectors: ['#outer', '#inner'] })
    expect(result).toEqual(["const frame0 = page.frameLocator('#outer').frameLocator('#inner');"])
  })

  it('clicks directly on the frame-scoped selector without a timeout', () => {
    const action = buildAction()
    const result = action.handle({ type: 'click', frameSelectors: ['#frame1'], selectors: [['#btn']] })

    expect(result).toEqual([
      "const frame0 = page.frameLocator('#frame1');",
      "const frameAction0 = frame0.locator('#btn');",
      'await frameAction0.click()'
    ])
  })

  it('clicks with a timeout when the step specifies one', () => {
    const action = buildAction()
    const result = action.handle({ type: 'click', frameSelectors: ['#frame1'], selectors: [['#btn']], timeout: 3000 })

    expect(result).toEqual([
      "const frame0 = page.frameLocator('#frame1');",
      "const frameAction0 = frame0.locator('#btn');",
      'await frameAction0.click({timeout: 3000})'
    ])
  })

  it('waits for same-page navigation triggered by a framed click', () => {
    const action = buildAction()
    const result = action.handle({
      type: 'click',
      frameSelectors: ['#frame1'],
      selectors: [['#navigate']],
      assertedEvents: [{ type: 'navigation' }]
    })

    expect(result).toEqual([
      "const navigationEvent0 = page.waitForNavigation({ waitUntil: 'domcontentloaded' });",
      "const frame0 = page.frameLocator('#frame1');",
      "const frameAction0 = frame0.locator('#navigate');",
      'await frameAction0.click()',
      'await navigationEvent0;'
    ])
  })

  it('waits for a framed close action and restores the opener', () => {
    const stack = new Stack()
    stack.push('page')
    stack.push('tab0')
    const context = { page: 'tab0' }
    const action = buildAction(context, stack)

    const result = action.handle({
      type: 'click',
      frameSelectors: ['#frame1'],
      selectors: [['#close']],
      assertedEvents: [{ type: 'windowOrTabClose' }]
    })

    expect(result).toEqual([
      "const pageCloseEvent0 = tab0.waitForEvent('close');",
      "const frame0 = tab0.frameLocator('#frame1');",
      "const frameAction0 = frame0.locator('#close');",
      'await frameAction0.click()',
      'await pageCloseEvent0;'
    ])
    expect(stack.peek()).toBe('page')
    expect(context.page).toBe('page')
  })

  it('waits for a popup opened by a framed action and switches to it', () => {
    const stack = new Stack()
    stack.push('page')
    const context = { page: 'page' }
    const action = buildAction(context, stack)

    const result = action.handle({
      type: 'click',
      frameSelectors: ['#frame1'],
      selectors: [['#open']],
      assertedEvents: [{ type: 'navigation', isNewTabOrWindow: true }]
    })

    expect(result).toEqual([
      "const pageEvent0 = page.waitForEvent('popup');",
      "const frame0 = page.frameLocator('#frame1');",
      "const frameAction0 = frame0.locator('#open');",
      'await frameAction0.click()',
      'const tab0 = await pageEvent0;',
      "await tab0.waitForLoadState('domcontentloaded');"
    ])
    expect(stack.peek()).toBe('tab0')
    expect(context.page).toBe('tab0')
  })

  it('uses parent-scoped text for a positional list option inside a frame', () => {
    const action = buildAction()
    const result = action.handle({
      type: 'click',
      frameSelectors: ['#frame1'],
      selectors: [['#field li:nth-child(3) span.option'], ['text/Scale Testing EngScale']],
      parentSelectors: [['#field ul[role="listbox"]']],
      componentType: 'list'
    })

    expect(result).toEqual([
      "const frame0 = page.frameLocator('#frame1');",
      'const frameAction0 = frame0.locator(\'#field ul[role="listbox"] >> :text("Scale Testing EngScale")\');',
      'await frameAction0.click()'
    ])
  })

  it('delegates to ClickAction when there is no frame-scoped selector', () => {
    const action = buildAction()
    const result = action.handle({ type: 'click', frameSelectors: ['#frame1'] })

    expect(result[0]).toBe("const frame0 = page.frameLocator('#frame1');")
    expect(result.length).toBeGreaterThan(1)
    expect(result.some(line => line.includes('.click('))).toBe(true)
  })

  it('does not wrap popup handling twice when delegating a selector-less click', () => {
    const stack = new Stack()
    stack.push('page')
    const context = { page: 'page' }
    const action = buildAction(context, stack)
    const result = action.handle({
      type: 'click',
      frameSelectors: ['#frame1'],
      assertedEvents: [{ type: 'navigation', isNewTabOrWindow: true }]
    })

    expect(result.filter(line => line.includes("waitForEvent('popup')"))).toHaveLength(1)
    expect(result.filter(line => line.startsWith('const tab'))).toHaveLength(1)
    expect(stack.size()).toBe(2)
    expect(stack.peek()).toBe('tab0')
    expect(context.page).toBe('tab0')
  })

  it('discards nothing extra when the delegated ClickAction has no output', () => {
    const spy = jest.spyOn(ClickAction.prototype, 'handle').mockReturnValueOnce(null)
    const action = buildAction()

    const result = action.handle({ type: 'click', frameSelectors: ['#frame1'] })

    expect(result).toEqual(["const frame0 = page.frameLocator('#frame1');"])
    spy.mockRestore()
  })

  it('fills directly on the frame-scoped selector when found', () => {
    const action = buildAction()
    const result = action.handle({
      type: 'change',
      frameSelectors: ['#frame1'],
      value: 'hello',
      selectors: [['#inp']]
    })

    expect(result).toEqual([
      "const frame0 = page.frameLocator('#frame1');",
      "const frameAction0 = frame0.locator('#inp');",
      "await frameAction0.fill('hello');"
    ])
  })

  it('conditionally reopens a framed searchable combobox before filling it', () => {
    const action = buildAction()
    const result = action.handle({
      type: 'change',
      tagName: 'INPUT',
      inputType: 'text',
      ensureComboboxOpen: true,
      comboboxActivationSelector: '#team-closed',
      frameSelectors: ['#frame1'],
      value: 'Scale Testing',
      selectors: [['#team-open'], ['aria/Team[role="combobox"]']]
    })

    expect(result).toEqual([
      "const frame0 = page.frameLocator('#frame1');",
      "const frameAction0 = frame0.locator('#team-open');",
      "if (\n  (await frame0.locator('#team-closed').first().isVisible()) &&\n  (await frame0.locator('#team-closed').first().getAttribute('aria-expanded')) === 'false'\n) {\n  await frame0.locator('#team-closed').first().click();\n}",
      "await frameAction0.fill('Scale Testing');"
    ])
  })

  it('waits for same-page navigation triggered by a framed change', () => {
    const action = buildAction()
    const result = action.handle({
      type: 'change',
      frameSelectors: ['#frame1'],
      selectors: [['#search']],
      value: 'query',
      assertedEvents: [{ type: 'navigation' }]
    })

    expect(result).toEqual([
      "const navigationEvent0 = page.waitForNavigation({ waitUntil: 'domcontentloaded' });",
      "const frame0 = page.frameLocator('#frame1');",
      "const frameAction0 = frame0.locator('#search');",
      "await frameAction0.fill('query');",
      'await navigationEvent0;'
    ])
  })

  it.each([
    ['checkbox', true],
    ['radio', false]
  ])('sets a framed %s control instead of filling it', (inputType, value) => {
    const action = buildAction()
    const result = action.handle({
      type: 'change',
      inputType,
      frameSelectors: ['#frame1'],
      value,
      selectors: [['#choice']]
    })

    expect(result).toEqual([
      "const frame0 = page.frameLocator('#frame1');",
      "const frameAction0 = frame0.locator('#choice');",
      `await frameAction0.setChecked(${value} == true);`
    ])
  })

  it('selects an option for a framed select instead of filling it', () => {
    const action = buildAction()
    const result = action.handle({
      type: 'change',
      inputType: 'select-one',
      frameSelectors: ['#frame1'],
      value: "Owner's choice",
      selectors: [['#choice']]
    })

    expect(result).toEqual([
      "const frame0 = page.frameLocator('#frame1');",
      "const frameAction0 = frame0.locator('#choice');",
      "await frameAction0.selectOption('Owner\\'s choice');"
    ])
  })

  it('escapes a multiline rich-text value before filling inside a frame', () => {
    const action = buildAction()
    const result = action.handle({
      type: 'change',
      frameSelectors: ['iframe[title="Owner\'s frame"]'],
      value: "Bob's\nsecond line",
      selectors: [['#editor[data-label="Owner\'s"]']],
      isContentEditable: true
    })

    expect(result).toEqual([
      "const frame0 = page.frameLocator('iframe[title=\"Owner\\'s frame\"]');",
      "const frameAction0 = frame0.locator('#editor[data-label=\"Owner\\'s\"]');",
      "await frameAction0.fill('Bob\\'s\\nsecond line');"
    ])
  })

  it('delegates to ChangeAction when there is no frame-scoped selector', () => {
    const action = buildAction()
    const result = action.handle({ type: 'change', frameSelectors: ['#frame1'], value: 'hello' })

    expect(result[0]).toBe("const frame0 = page.frameLocator('#frame1');")
    expect(result.some(line => line.includes('.fill('))).toBe(true)
  })

  it('discards nothing extra when the delegated ChangeAction has no output', () => {
    const spy = jest.spyOn(ChangeAction.prototype, 'handle').mockReturnValueOnce(null)
    const action = buildAction()

    const result = action.handle({ type: 'change', frameSelectors: ['#frame1'], value: 'hello' })

    expect(result).toEqual(["const frame0 = page.frameLocator('#frame1');"])
    spy.mockRestore()
  })

  it('increments frame counters across repeated calls on the same instance', () => {
    const action = buildAction()
    action.handle({ type: 'assert', frameSelectors: ['#frame1'] })
    const second = action.handle({ type: 'assert', frameSelectors: ['#frame2'] })
    expect(second).toEqual(["const frame1 = page.frameLocator('#frame2');"])
  })
})
