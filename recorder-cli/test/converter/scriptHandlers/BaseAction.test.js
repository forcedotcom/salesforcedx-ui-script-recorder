import { BaseAction } from '../../../src/converter/scriptHandlers/BaseAction.js'
import { Stack } from '../../../src/converter/Stack.js'

describe('BaseAction', () => {
  describe('_buildCommentString', () => {
    const action = new BaseAction()

    it('returns an empty string when there is nothing worth commenting', () => {
      expect(action._buildCommentString({}, ['tagName'], undefined)).toBe('')
    })

    it('includes requested fields that are present on the step', () => {
      const step = { tagName: 'INPUT', value: 'hi' }
      expect(action._buildCommentString(step, ['tagName', 'value', 'missingField'], undefined)).toBe(
        '// tagName = "INPUT", value = "hi"'
      )
    })

    it('lists alternative selectors, excluding blanks and the chosen selector', () => {
      const selector = ['#chosen']
      const step = { selectors: [selector, ['#alt1'], [''], ['#alt2']] }
      expect(action._buildCommentString(step, [], selector)).toBe("// alternative selectors = ['#alt1', '#alt2']")
    })

    it('ignores selectors when step.selectors is not an array', () => {
      expect(action._buildCommentString({ selectors: 'nope' }, [], undefined)).toBe('')
    })

    it('combines field comments with alternative selectors', () => {
      const selector = ['#chosen']
      const step = { tagName: 'A', selectors: [selector, ['#alt']] }
      expect(action._buildCommentString(step, ['tagName'], selector)).toBe(
        "// tagName = \"A\", alternative selectors = ['#alt']"
      )
    })
  })

  describe('_buildActionString', () => {
    const action = new BaseAction(null, { page: 'page' })

    it('builds a click call without a timeout', () => {
      expect(action._buildActionString({ type: 'click' }, 'click', 'sel', undefined, { await: true })).toBe(
        "await page.click('sel')"
      )
    })

    it('builds a click call with a timeout and a custom ending', () => {
      expect(
        action._buildActionString({ type: 'click', timeout: 5000 }, 'click', 'sel', undefined, {
          await: true,
          ending: ';'
        })
      ).toBe("await page.click('sel', {timeout: 5000});")
    })

    it('builds a doubleClick call the same way as click', () => {
      expect(action._buildActionString({ type: 'doubleClick' }, 'dblclick', 'sel', undefined, {})).toBe(
        "page.dblclick('sel')"
      )
    })

    it('builds a checkbox change as setChecked', () => {
      expect(action._buildActionString({ type: 'change', inputType: 'checkbox' }, 'fill', 'sel', true, {})).toBe(
        "page.locator('sel').setChecked(true == true)"
      )
    })

    it('builds a radio change as setChecked', () => {
      expect(action._buildActionString({ type: 'change', inputType: 'radio' }, 'fill', 'sel', true, {})).toBe(
        "page.locator('sel').setChecked(true == true)"
      )
    })

    it('builds a select-one change as selectOption', () => {
      expect(
        action._buildActionString({ type: 'change', inputType: 'select-one' }, 'fill', 'sel', 'opt', {})
      ).toBe("page.locator('sel').selectOption('opt')")
    })

    it('builds a plain text change as fill', () => {
      expect(action._buildActionString({ type: 'change', inputType: 'text' }, 'fill', 'sel', 'val', {})).toBe(
        "page.fill('sel', 'val')"
      )
    })

    it('falls back to a plain action call for any other step type', () => {
      expect(action._buildActionString({ type: 'assert' }, 'someAction', 'sel', undefined, {})).toBe(
        "page.someAction('sel')"
      )
    })

    it('defaults options to an empty object when omitted', () => {
      expect(action._buildActionString({ type: 'assert' }, 'someAction', 'sel', undefined)).toBe(
        "page.someAction('sel')"
      )
    })
  })

  describe('handleNewTabOrWindow', () => {
    it('captures a popup when the step asserts a new tab or window', () => {
      const stack = new Stack()
      const context = { page: 'page' }
      const commonCounter = { value: 0 }
      const action = new BaseAction(stack, context, commonCounter)
      const step = {
        type: 'click',
        tagName: 'BUTTON',
        selectors: [['#btn']],
        assertedEvents: [{ isNewTabOrWindow: true }]
      }

      const result = action.handleNewTabOrWindow(step, 'click')

      expect(result).toEqual([
        "const pageEvent0 = page.waitForEvent('popup');",
        '// tagName = "BUTTON"',
        "await page.click('#btn');",
        'const tab0 = await pageEvent0;'
      ])
      expect(stack.peek()).toBe('tab0')
      expect(context.page).toBe('tab0')
      expect(commonCounter.value).toBe(1)
    })

    it('waits for navigation when the step asserts a navigation event', () => {
      const context = { page: 'page' }
      const action = new BaseAction(new Stack(), context, { value: 0 })
      const step = { type: 'click', selectors: [['#btn']], assertedEvents: [{ type: 'navigation' }] }

      const result = action.handleNewTabOrWindow(step, 'click')

      expect(result).toEqual(['', "await page.click('#btn');", "await page.waitForLoadState('domcontentloaded')"])
    })

    it('skips the navigation wait when there is no navigation event', () => {
      const context = { page: 'page' }
      const action = new BaseAction(new Stack(), context, { value: 0 })
      const step = { type: 'click', selectors: [['#btn']] }

      const result = action.handleNewTabOrWindow(step, 'click')

      expect(result).toEqual(['', "await page.click('#btn');"])
    })

    it('tolerates a step with no matching selector', () => {
      const context = { page: 'page' }
      const action = new BaseAction(new Stack(), context, { value: 0 })
      const step = { type: 'click' }

      const result = action.handleNewTabOrWindow(step, 'click')

      expect(result).toEqual(['', "await page.click('undefined');"])
    })
  })

  describe('handleWindowOrTabClose', () => {
    it('falls back to "page" once the stack empties', () => {
      const stack = new Stack()
      stack.push('tab0')
      const context = { page: 'tab0' }
      const action = new BaseAction(stack, context, { value: 0 })

      action.handleWindowOrTabClose()

      expect(stack.isEmpty()).toBe(true)
      expect(context.page).toBe('page')
    })

    it('restores the previous page when the stack is not empty', () => {
      const stack = new Stack()
      stack.push('tab0')
      stack.push('tab1')
      const context = { page: 'tab1' }
      const action = new BaseAction(stack, context, { value: 0 })

      action.handleWindowOrTabClose()

      expect(stack.isEmpty()).toBe(false)
      expect(context.page).toBe('tab0')
    })
  })
})
