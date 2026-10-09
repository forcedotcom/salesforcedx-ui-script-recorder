import { NavigateAction } from '../../../src/converter/scriptHandlers/NavigateAction.js'
import { Stack } from '../../../src/converter/Stack.js'

describe('NavigateAction', () => {
  const buildAction = (context = { page: 'page' }, stack = new Stack()) =>
    new NavigateAction(stack, context, { value: 0 })

  it('emits an awaited page.goto for the step url', () => {
    const action = buildAction()
    expect(action.handle({ url: 'https://example.com' })).toEqual([
      "await page.goto('https://example.com');",
    ])
  })

  it('targets whatever page name the current context holds', () => {
    const stack = new Stack()
    stack.push('page')
    stack.push('tab1')
    const action = buildAction({ page: 'tab1' }, stack)
    expect(action.handle({ url: 'https://example.com/x' })).toEqual([
      "await tab1.goto('https://example.com/x');",
    ])
  })

  it('waits for the final recorded URL after a redirect', () => {
    const action = buildAction()

    expect(action.handle({
      url: 'https://example.com/start',
      assertedEvents: [{ type: 'navigation', url: 'https://example.com/final' }]
    })).toEqual([
      "await page.goto('https://example.com/start');",
      "await page.waitForURL(url => url.href === 'https://example.com/final', { waitUntil: 'domcontentloaded' });"
    ])
  })

  it('does not wait a second time when the asserted URL repeats the goto URL', () => {
    const action = buildAction()

    expect(action.handle({
      url: 'https://example.com',
      assertedEvents: [{ type: 'navigation', url: 'https://example.com' }]
    })).toEqual([
      "await page.goto('https://example.com');"
    ])
  })

  it('creates and targets a new page for an explicit new-tab navigation', () => {
    const stack = new Stack()
    stack.push('page')
    const context = { page: 'page' }
    const action = buildAction(context, stack)

    expect(action.handle({
      url: 'https://example.com/new',
      assertedEvents: [{ type: 'navigation', isNewTabOrWindow: true }]
    })).toEqual([
      'const tab0 = await page.context().newPage();',
      "await tab0.goto('https://example.com/new');"
    ])
    expect(stack.peek()).toBe('tab0')
    expect(context.page).toBe('tab0')
  })

  it('closes an explicitly navigated page without waiting for an impossible close event', () => {
    const stack = new Stack()
    stack.push('page')
    stack.push('tab1')
    const context = { page: 'tab1' }
    const action = buildAction(context, stack)

    expect(action.handle({
      url: 'https://example.com/done',
      assertedEvents: [{ type: 'windowOrTabClose' }]
    })).toEqual([
      "await tab1.goto('https://example.com/done');",
      'if (!tab1.isClosed()) {',
      '  await tab1.close();',
      '}'
    ])
    expect(stack.peek()).toBe('page')
    expect(context.page).toBe('page')
  })
})
