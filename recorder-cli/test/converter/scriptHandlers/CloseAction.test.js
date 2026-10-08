import { CloseAction } from '../../../src/converter/scriptHandlers/CloseAction.js'
import { BrowserContext } from '../../../src/converter/BrowserContext.js'
import { Stack } from '../../../src/converter/Stack.js'

describe('CloseAction', () => {
  it('closes the exact recorded tab and restores the remaining page', () => {
    const stack = new Stack()
    stack.push('page')
    stack.push('tab1')
    stack.push('tab2')
    const context = new BrowserContext()
    context.registerPage('main', 'page')
    context.registerPage('popup-1', 'tab1')
    context.registerPage('popup-2', 'tab2')
    context.activatePage('popup-1')

    const action = new CloseAction(stack, context, { value: 0 })
    expect(action.handle({ type: 'close', tabId: 'popup-1' })).toEqual([
      'if (!tab1.isClosed()) {',
      '  await tab1.close();',
      '}'
    ])
    expect(context.pageForTabId('popup-1')).toBeNull()
    expect(context.pageForTabId('popup-2')).toBe('tab2')
    expect(stack.peek()).toBe('tab2')
    expect(context.page).toBe('tab2')
  })
})
