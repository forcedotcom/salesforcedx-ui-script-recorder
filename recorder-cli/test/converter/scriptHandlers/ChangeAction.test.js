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

  it('conditionally reopens a searchable combobox before filling its stable selector', () => {
    const step = {
      type: 'change',
      value: 'Scale Testing',
      tagName: 'INPUT',
      inputType: 'text',
      ensureComboboxOpen: true,
      comboboxActivationSelector: '#team-closed',
      selectors: [['#team-open'], ['aria/Team[role="combobox"]']]
    }

    expect(buildAction().handle(step)).toEqual([
      '// tagName = "INPUT", inputType = "text", value = "Scale Testing", alternative selectors = [\'aria/Team[role="combobox"]\']',
      "if (\n  (await page.locator('#team-closed').first().isVisible()) &&\n  (await page.locator('#team-closed').first().getAttribute('aria-expanded')) === 'false'\n) {\n  await page.locator('#team-closed').first().click();\n}",
      "await page.fill('#team-open', 'Scale Testing');"
    ])
  })

  it('does not add a reopen guard to an ordinary textbox', () => {
    const step = {
      type: 'change',
      value: 'Scale Testing',
      tagName: 'INPUT',
      inputType: 'text',
      selectors: [['#team'], ['aria/Team[role="textbox"]']]
    }

    const result = buildAction().handle(step)

    expect(result).toHaveLength(2)
    expect(result.some(line => line.includes('aria-expanded'))).toBe(false)
  })

  it('does not change an unmarked combobox fill', () => {
    const step = {
      type: 'change',
      value: 'Scale Testing',
      tagName: 'INPUT',
      inputType: 'text',
      selectors: [['input[aria-label="Team"]'], ['aria/Team[role="combobox"]']]
    }

    expect(buildAction().handle(step)).toEqual([
      '// tagName = "INPUT", inputType = "text", value = "Scale Testing", alternative selectors = [\'aria/Team[role="combobox"]\']',
      "await page.fill('input[aria-label=\"Team\"]', 'Scale Testing');"
    ])
  })

  it('keeps the conditional reopen immediately before a parameterised combobox fill', () => {
    const step = {
      type: 'change',
      value: 'Scale Testing',
      tagName: 'INPUT',
      inputType: 'text',
      ensureComboboxOpen: true,
      selectors: [['input[aria-label="Team"]'], ['aria/Team[role="combobox"]']],
      params: { parameterise: true, paramName: 'team' }
    }

    expect(buildAction().handle(step)).toEqual([
      '// tagName = "INPUT", inputType = "text", value = "Scale Testing", alternative selectors = [\'aria/Team[role="combobox"]\']',
      "let team = config.get('team');",
      "if (\n  (await page.locator('input[aria-label=\"Team\"]').first().isVisible()) &&\n  (await page.locator('input[aria-label=\"Team\"]').first().getAttribute('aria-expanded')) === 'false'\n) {\n  await page.locator('input[aria-label=\"Team\"]').first().click();\n}",
      "await page.fill('input[aria-label=\"Team\"]', team);"
    ])
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

  it('escapes the selector while keeping a parameter value as a runtime expression', () => {
    const step = {
      type: 'change',
      value: 'recorded fallback',
      inputType: 'text',
      selectors: [['input[data-label="Owner\'s"]']],
      params: { parameterise: true, paramName: 'description' }
    }

    const result = buildAction().handle(step)

    expect(result[result.length - 1]).toBe(
      "await page.fill('input[data-label=\"Owner\\'s\"]', description);"
    )
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

  it('replaces the fill without dropping a parameterised navigation wait', () => {
    const step = {
      type: 'change',
      value: 'bob',
      inputType: 'text',
      selectors: [['#inp']],
      params: { parameterise: true, paramName: 'myParam' },
      assertedEvents: [{ type: 'navigation' }]
    }

    const result = buildAction().handle(step)

    expect(result).toEqual([
      "const navigationEvent0 = page.waitForNavigation({ waitUntil: 'domcontentloaded' });",
      '// inputType = "text", value = "bob"',
      "let myParam = config.get('myParam');",
      "await page.fill('#inp', myParam);",
      'await navigationEvent0;'
    ])
  })

  it('keeps popup capture around a credential fill on the triggering page', () => {
    const stack = new Stack()
    stack.push('page')
    const context = { page: 'page' }
    const step = {
      type: 'change',
      value: 'joe',
      inputType: 'text',
      selectors: [['#inp'], ['aria/Username for field']],
      assertedEvents: [{ type: 'navigation', isNewTabOrWindow: true }]
    }

    const result = buildAction(context, stack).handle(step)

    expect(result).toContain("const username = config.get('username');")
    expect(result).toContain("await page.fill('#inp', username);")
    expect(result).toContain('const tab0 = await pageEvent0;')
    expect(result).toContain("await tab0.waitForLoadState('domcontentloaded');")
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

    const result = buildAction(context, stack).handle(step)

    expect(result).toEqual([
      "const pageCloseEvent0 = tab0.waitForEvent('close');",
      '// inputType = "text", value = "x"',
      "await tab0.fill('#inp', 'x');",
      'await pageCloseEvent0;'
    ])
    expect(stack.isEmpty()).toBe(true)
    expect(context.page).toBe('page')
  })
})
