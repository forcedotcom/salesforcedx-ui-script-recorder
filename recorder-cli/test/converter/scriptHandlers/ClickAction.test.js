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

  it('closes the tab/window when the step asserts a windowOrTabClose event', () => {
    const stack = new Stack()
    stack.push('tab0')
    const context = { page: 'tab0' }
    const step = { type: 'click', selectors: [['#btn']], assertedEvents: [{ type: 'windowOrTabClose' }] }

    buildAction(context, stack).handle(step)

    expect(stack.isEmpty()).toBe(true)
    expect(context.page).toBe('page')
  })
})
