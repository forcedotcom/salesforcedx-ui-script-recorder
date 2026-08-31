import { ChangeAction } from '../../../src/converter/scriptHandlers/ChangeAction.js'
import { Stack } from '../../../src/converter/Stack.js'

describe('ChangeAction', () => {
  beforeEach(() => {
    ChangeAction.resetDeclaredVars()
  })

  const buildAction = (context = { page: 'page' }, stack = new Stack()) =>
    new ChangeAction(stack, context, { value: 0 })

  it('emits a plain fill for a regular text input', () => {
    const step = { type: 'change', value: 'hello', inputType: 'text', selectors: [['#inp']] }
    expect(buildAction().handle(step)).toEqual([
      '// inputType = "text", value = "hello"',
      "await page.fill('#inp', 'hello');"
    ])
  })

  it('declares and fills a username variable the first time it is seen', () => {
    const step = {
      type: 'change',
      value: 'joe',
      inputType: 'text',
      selectors: [['#inp'], ['aria/Username for field']]
    }

    const result = buildAction().handle(step)

    expect(result).toContain("const username = config.get('username');")
    expect(result[result.length - 1]).toBe("await page.fill('#inp', username);")
  })

  it('does not redeclare username on a second occurrence in the same conversion', () => {
    const action = buildAction()
    const step = {
      type: 'change',
      value: 'joe',
      inputType: 'text',
      selectors: [['#inp'], ['aria/Username for field']]
    }

    action.handle(step)
    const secondResult = action.handle(step)

    expect(secondResult.filter(line => line.includes('config.get'))).toEqual([])
    expect(secondResult[secondResult.length - 1]).toBe("await page.fill('#inp', username);")
  })

  it('declares and fills a password variable', () => {
    const step = {
      type: 'change',
      value: 'secret',
      inputType: 'password',
      selectors: [['#pwd'], ['aria/Password for field']]
    }

    const result = buildAction().handle(step)

    expect(result).toContain("const password = config.get('password');")
    expect(result[result.length - 1]).toBe("await page.fill('#pwd', password);")
  })

  it('ignores aria selectors that are not username or password', () => {
    const step = { type: 'change', value: 'x', inputType: 'text', selectors: [['#inp'], ['aria/Something else']] }

    const result = buildAction().handle(step)

    expect(result.some(line => line.includes('config.get'))).toBe(false)
    expect(result[result.length - 1]).toBe("await page.fill('#inp', 'x');")
  })

  it('parameterises a text field with a generated config lookup', () => {
    const step = {
      type: 'change',
      value: 'bob',
      inputType: 'text',
      selectors: [['#inp']],
      params: { parameterise: true, paramName: 'myParam' }
    }

    const result = buildAction().handle(step)

    expect(result).toEqual([
      '// inputType = "text", value = "bob"',
      "let myParam = config.get('myParam');",
      "await page.fill('#inp', myParam);"
    ])
  })

  it('parameterises a checkbox field using setChecked', () => {
    const step = {
      type: 'change',
      value: true,
      inputType: 'checkbox',
      selectors: [['#chk']],
      params: { parameterise: true, paramName: 'myFlag' }
    }

    const result = buildAction().handle(step)

    expect(result[result.length - 1]).toBe('await page.locator(\'#chk\').setChecked(myFlag == "true");')
  })

  it('skips parameterisation entirely when no paramName is supplied', () => {
    const step = {
      type: 'change',
      value: 'bob',
      inputType: 'text',
      selectors: [['#inp']],
      params: { parameterise: true }
    }

    expect(buildAction().handle(step)).toEqual([
      '// inputType = "text", value = "bob"',
      "await page.fill('#inp', 'bob');"
    ])
  })

  it('does not redeclare password on a second occurrence in the same conversion', () => {
    const action = buildAction()
    const step = {
      type: 'change',
      value: 'secret',
      inputType: 'password',
      selectors: [['#pwd'], ['aria/Password for field']]
    }

    action.handle(step)
    const secondResult = action.handle(step)

    expect(secondResult.filter(line => line.includes('config.get'))).toEqual([])
    expect(secondResult[secondResult.length - 1]).toBe("await page.fill('#pwd', password);")
  })

  it('closes the tab/window when the step asserts a windowOrTabClose event', () => {
    const stack = new Stack()
    stack.push('tab0')
    const context = { page: 'tab0' }
    const step = {
      type: 'change',
      value: 'x',
      inputType: 'text',
      selectors: [['#inp']],
      assertedEvents: [{ type: 'windowOrTabClose' }]
    }

    buildAction(context, stack).handle(step)

    expect(stack.isEmpty()).toBe(true)
    expect(context.page).toBe('page')
  })
})
