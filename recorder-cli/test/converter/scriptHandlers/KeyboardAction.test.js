import { KeyBoardAction } from '../../../src/converter/scriptHandlers/KeyboardAction.js'
import { Stack } from '../../../src/converter/Stack.js'

describe('KeyBoardAction', () => {
  const buildAction = (context = { page: 'page' }, stack = new Stack()) =>
    new KeyBoardAction(stack, context, { value: 0 })

  it('emits an awaited keyboard.press call with the step key', () => {
    const action = buildAction()
    expect(action.handle({ key: 'Enter' })).toEqual([
      "await page.keyboard.press('Enter');",
    ])
  })

  it('preserves the recorded time between keydown and keyup', () => {
    const action = buildAction()
    expect(action.handle({ key: 'Enter', keyPressDuration: 1000 })).toEqual([
      "await page.keyboard.press('Enter', { delay: 1000 });"
    ])
  })

  it('waits for same-page navigation triggered by a key press', () => {
    const action = buildAction()

    expect(action.handle({
      key: 'Enter',
      assertedEvents: [{ type: 'navigation' }]
    })).toEqual([
      "const navigationEvent0 = page.waitForNavigation({ waitUntil: 'domcontentloaded' });",
      "await page.keyboard.press('Enter');",
      'await navigationEvent0;'
    ])
  })

  it('switches to a popup opened by a key press', () => {
    const stack = new Stack()
    stack.push('page')
    const context = { page: 'page' }
    const action = buildAction(context, stack)

    expect(action.handle({
      key: 'Enter',
      assertedEvents: [{ type: 'navigation', isNewTabOrWindow: true }]
    })).toEqual([
      "const pageEvent0 = page.waitForEvent('popup');",
      "await page.keyboard.press('Enter');",
      'const tab0 = await pageEvent0;',
      "await tab0.waitForLoadState('domcontentloaded');"
    ])
    expect(context.page).toBe('tab0')
    expect(stack.peek()).toBe('tab0')
  })

  it('waits for a tab closed by a key press and restores the opener', () => {
    const stack = new Stack()
    stack.push('page')
    stack.push('tab0')
    const context = { page: 'tab0' }
    const action = buildAction(context, stack)

    expect(action.handle({
      key: 'Escape',
      assertedEvents: [{ type: 'windowOrTabClose' }]
    })).toEqual([
      "const pageCloseEvent0 = tab0.waitForEvent('close');",
      "await tab0.keyboard.press('Escape');",
      'await pageCloseEvent0;'
    ])
    expect(context.page).toBe('page')
    expect(stack.peek()).toBe('page')
  })
})
