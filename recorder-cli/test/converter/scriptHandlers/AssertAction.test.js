import { AssertAction } from '../../../src/converter/scriptHandlers/AssertAction.js'

describe('AssertAction', () => {
  const buildAction = () => new AssertAction(null, { page: 'page' })

  it('returns no actions when there is no usable selector', () => {
    expect(buildAction().handle({})).toEqual([])
    expect(buildAction().handle({ selectors: [[''], ['']] })).toEqual([])
  })

  it('asserts text content on the first line, trimmed and quote-escaped', () => {
    const action = buildAction()
    const step = {
      selectors: [['#msg']],
      assertionType: 'containsText',
      textContent: "  Say 'hi'  \nignored second line"
    }

    expect(action.handle(step)).toEqual(["await expect(page.locator('#msg')).toContainText('Say \\'hi\\'');"])
  })

  it('escapes backslashes before escaping quotes', () => {
    const action = buildAction()
    const step = { selectors: [['#msg']], assertionType: 'containsText', textContent: 'C:\\path' }

    expect(action.handle(step)).toEqual(["await expect(page.locator('#msg')).toContainText('C:\\\\path');"])
  })

  it('falls back to visibility when assertionType is containsText but there is no textContent', () => {
    const action = buildAction()
    const step = { selectors: [['#msg']], assertionType: 'containsText' }

    expect(action.handle(step)).toEqual(["await expect(page.locator('#msg')).toBeVisible();"])
  })

  it('falls back to visibility for any other assertionType even with textContent present', () => {
    const action = buildAction()
    const step = { selectors: [['#msg']], assertionType: 'visible', textContent: 'hello' }

    expect(action.handle(step)).toEqual(["await expect(page.locator('#msg')).toBeVisible();"])
  })
})
