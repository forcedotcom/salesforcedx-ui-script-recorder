import { ReloadAction } from '../../../src/converter/scriptHandlers/ReloadAction.js'
import { Stack } from '../../../src/converter/Stack.js'

describe('ReloadAction', () => {
  const buildAction = (context = { page: 'page' }, stack = new Stack()) =>
    new ReloadAction(stack, context, { value: 0 })

  it('reloads the active page', () => {
    expect(buildAction().handle({})).toEqual(['await page.reload();'])
  })

  it('waits for the final recorded URL after a reload redirect', () => {
    expect(buildAction().handle({
      assertedEvents: [{ type: 'navigation', url: 'https://example.com/final' }]
    })).toEqual([
      'await page.reload();',
      "await page.waitForURL(url => url.href === 'https://example.com/final', { waitUntil: 'domcontentloaded' });"
    ])
  })

  it('recreates a contradictory legacy new-tab reload without waiting for a popup', () => {
    const stack = new Stack()
    stack.push('page')
    const context = { page: 'page' }
    const action = buildAction(context, stack)

    expect(action.handle({
      assertedEvents: [{ type: 'navigation', isNewTabOrWindow: true }]
    })).toEqual([
      'const tab0 = await page.context().newPage();',
      'await tab0.goto(page.url());'
    ])
    expect(stack.peek()).toBe('tab0')
    expect(context.page).toBe('tab0')
  })

  it('explicitly closes a reloaded tab and restores its opener', () => {
    const stack = new Stack()
    stack.push('page')
    stack.push('tab1')
    const context = { page: 'tab1' }
    const action = buildAction(context, stack)

    expect(action.handle({
      assertedEvents: [{ type: 'windowOrTabClose' }]
    })).toEqual([
      'await tab1.reload();',
      'if (!tab1.isClosed()) {',
      '  await tab1.close();',
      '}'
    ])
    expect(stack.peek()).toBe('page')
    expect(context.page).toBe('page')
  })
})
