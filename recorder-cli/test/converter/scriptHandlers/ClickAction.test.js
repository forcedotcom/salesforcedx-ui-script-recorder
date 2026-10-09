import { ClickAction } from '../../../src/converter/scriptHandlers/ClickAction.js'
import { Stack } from '../../../src/converter/Stack.js'

describe('ClickAction', () => {
  beforeEach(() => {
    ClickAction.nthSelectorCounters.listCounter = 1
    ClickAction.nthSelectorCounters.tableCounter = 1
  })

  const buildAction = (context = { page: 'page' }, stack = new Stack()) =>
    new ClickAction(stack, context, { value: 0 })

  it('emits a plain click when the step is not parameterised', () => {
    const step = { type: 'click', selectors: [['#btn']] }
    expect(buildAction().handle(step)).toEqual(['', "await page.click('#btn');"])
  })

  it('uses text scoped to the recorded list for a positional list option click', () => {
    const step = {
      type: 'click',
      tagName: 'SPAN',
      selectors: [
        ['div.field li.slds-listbox__item:nth-child(3) span.slds-media__body'],
        ['text/Scale Testing EngScale']
      ],
      parentSelectors: [['div.field ul.slds-listbox']],
      componentType: 'list'
    }

    const result = buildAction().handle(step)

    expect(result[1]).toBe(
      'await page.click(\'div.field ul.slds-listbox >> :text("Scale Testing EngScale")\');'
    )
    expect(result[1]).not.toContain('li.slds-listbox__item:nth-child(3)')
  })

  it('escapes list option text for the generated JavaScript string', async () => {
    const optionText = 'O\'Reilly "Scale" \\ Team'
    const step = {
      type: 'click',
      selectors: [
        ['#list li:nth-child(2) span'],
        [`text/${optionText}`]
      ],
      parentSelectors: [['#list']],
      componentType: 'list'
    }

    const generatedAction = buildAction().handle(step)[1]
    const page = { click: jest.fn().mockResolvedValue(undefined) }
    const execute = new Function('page', `return (async () => { ${generatedAction} })();`)

    await execute(page)

    expect(page.click).toHaveBeenCalledWith(`#list >> :text(${JSON.stringify(optionText)})`)
  })

  it.each([
    ['a non-list click', { componentType: 'table', parentSelectors: [['#list']], selectors: [['#list li:nth-child(2)'], ['text/Option']] }],
    ['a stable non-search list click', { componentType: 'list', parentSelectors: [['#list']], selectors: [['#list li[data-id="unique"]'], ['text/Duplicate label']] }],
    ['a list click without text', { componentType: 'list', parentSelectors: [['#list']], selectors: [['#list li:nth-child(2)']] }],
    ['a list click without a CSS parent', { componentType: 'list', selectors: [['#list li:nth-child(2)'], ['text/Option']] }],
    ['a list click with control characters in its text', { componentType: 'list', parentSelectors: [['#list']], selectors: [['#list li:nth-child(2)'], ['text/Line one\nLine two']] }]
  ])('keeps the primary selector for %s', (_description, partialStep) => {
    const step = { type: 'click', ...partialStep }
    const primarySelector = step.selectors[0][0]

    expect(buildAction().handle(step)[1]).toBe(`await page.click('${primarySelector}');`)
  })

  it('uses recorded option text for a non-positional list selector', () => {
    const step = {
      type: 'click',
      componentType: 'list',
      parentSelectors: [['div[aria-label="Assigned To"] ul[aria-label="Search Results"]']],
      selectors: [
        ['div[aria-label="Assigned To"] span.slds-media__body'],
        ['text/Suraj VarmaSoftware']
      ]
    }

    expect(buildAction().handle(step)[1]).toBe(
      'await page.click(\'div[aria-label="Assigned To"] ul[aria-label="Search Results"] >> :text("Suraj VarmaSoftware")\');'
    )
  })

  it('replaces the last action with an nth-selector click for a parameterised table row', () => {
    const step = {
      type: 'click',
      selectors: [['#btn']],
      params: { parameterise: true, childIndex: 2 },
      componentType: 'table',
      parentSelectors: [['#tbl']]
    }

    const result = buildAction().handle(step)

    expect(result).toHaveLength(2)
    expect(result[1]).toContain('tableSelector1')
    expect(result[1]).toContain(".locator('#tbl tr th a').nth(2)")
    expect(ClickAction.nthSelectorCounters.tableCounter).toBe(2)
  })

  it('defaults the nth index to 0 when childIndex is missing', () => {
    const step = {
      type: 'click',
      selectors: [['#btn']],
      params: { parameterise: true },
      componentType: 'list',
      parentSelectors: [['#lst']]
    }

    const result = buildAction().handle(step)

    expect(result[1]).toContain('listSelector1')
    expect(result[1]).toContain(".locator('#lst li a').nth(0)")
  })

  it('leaves parameterised list handling in control of the component selector', () => {
    const step = {
      type: 'click',
      selectors: [['#list li:nth-child(2) span'], ['text/Option']],
      params: { parameterise: true, childIndex: 1 },
      componentType: 'list',
      parentSelectors: [['#list']]
    }

    const result = buildAction().handle(step)

    expect(result[1]).toContain(".locator('#list li a').nth(1)")
    expect(result[1]).not.toContain(':text(')
  })

  it('defaults the nth index to 0 when childIndex is NaN', () => {
    const step = {
      type: 'click',
      selectors: [['#btn']],
      params: { parameterise: true, childIndex: NaN },
      componentType: 'table',
      parentSelectors: [['#tbl']]
    }

    const result = buildAction().handle(step)

    expect(result[1]).toContain('.nth(0)')
  })

  it('leaves the click action untouched for an unrecognised component type', () => {
    const step = {
      type: 'click',
      selectors: [['#btn']],
      params: { parameterise: true, childIndex: 0 },
      componentType: 'unknown'
    }

    expect(buildAction().handle(step)).toEqual(['', "await page.click('#btn');"])
  })

  it('replaces the triggering action without dropping a parameterised navigation wait', () => {
    const step = {
      type: 'click',
      selectors: [['#btn']],
      params: { parameterise: true, childIndex: 2 },
      componentType: 'table',
      parentSelectors: [['#tbl']],
      assertedEvents: [{ type: 'navigation' }]
    }

    const result = buildAction().handle(step)

    expect(result[0]).toBe(
      "const navigationEvent0 = page.waitForNavigation({ waitUntil: 'domcontentloaded' });"
    )
    expect(result.some(line => line.includes("page.click('#btn')"))).toBe(false)
    expect(result.some(line => line.includes("page.locator('#tbl tr th a')"))).toBe(true)
    expect(result.at(-1)).toBe('await navigationEvent0;')
  })

  it('keeps popup capture and readiness around a parameterised triggering click', () => {
    const stack = new Stack()
    stack.push('page')
    const context = { page: 'page' }
    const step = {
      type: 'click',
      selectors: [['#btn']],
      params: { parameterise: true, childIndex: 1 },
      componentType: 'list',
      parentSelectors: [['#list']],
      assertedEvents: [{ type: 'navigation', isNewTabOrWindow: true }]
    }

    const result = buildAction(context, stack).handle(step)

    expect(result[0]).toBe("const pageEvent0 = page.waitForEvent('popup');")
    expect(result.some(line => line.includes("page.click('#btn')"))).toBe(false)
    expect(result.some(line => line.includes("page.locator('#list li a')"))).toBe(true)
    expect(result).toContain('const tab0 = await pageEvent0;')
    expect(result).toContain("await tab0.waitForLoadState('domcontentloaded');")
  })

  it('closes the tab/window when the step asserts a windowOrTabClose event', () => {
    const stack = new Stack()
    stack.push('tab0')
    const context = { page: 'tab0' }
    const step = { type: 'click', selectors: [['#btn']], assertedEvents: [{ type: 'windowOrTabClose' }] }

    const result = buildAction(context, stack).handle(step)

    expect(result).toEqual([
      "const pageCloseEvent0 = tab0.waitForEvent('close');",
      '',
      "await tab0.click('#btn');",
      'await pageCloseEvent0;'
    ])
    expect(stack.isEmpty()).toBe(true)
    expect(context.page).toBe('page')
  })

  it('explicitly closes a popup that the user closed after opening it', () => {
    const stack = new Stack()
    stack.push('page')
    const context = { page: 'page' }
    const step = {
      type: 'click',
      selectors: [['#open']],
      assertedEvents: [
        { type: 'navigation', isNewTabOrWindow: true },
        { type: 'windowOrTabClose' }
      ],
      closeDelay: 5000
    }

    const result = buildAction(context, stack).handle(step)

    expect(result).toEqual([
      "const pageEvent0 = page.waitForEvent('popup');",
      '',
      "await page.click('#open');",
      'const tab0 = await pageEvent0;',
      "await tab0.waitForLoadState('domcontentloaded');",
      'await delay(5000)',
      'if (!tab0.isClosed()) {',
      '  await tab0.close();',
      '}'
    ])
    expect(stack.peek()).toBe('page')
    expect(context.page).toBe('page')
  })

  it('explicitly replays a manual close after an interaction inside a popup', () => {
    const stack = new Stack()
    stack.push('page')
    stack.push('tab0')
    const context = { page: 'tab0' }
    const step = {
      type: 'click',
      selectors: [['#inside-popup']],
      explicitClose: true,
      closeDelay: 4000,
      assertedEvents: [{ type: 'windowOrTabClose' }]
    }

    const result = buildAction(context, stack).handle(step)

    expect(result).toEqual([
      '',
      "await tab0.click('#inside-popup');",
      'await delay(4000)',
      'if (!tab0.isClosed()) {',
      '  await tab0.close();',
      '}'
    ])
    expect(stack.peek()).toBe('page')
    expect(context.page).toBe('page')
  })
})
