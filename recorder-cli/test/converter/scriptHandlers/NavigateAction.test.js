import { NavigateAction } from '../../../src/converter/scriptHandlers/NavigateAction.js'

describe('NavigateAction', () => {
  it('emits an awaited page.goto for the step url', () => {
    const action = new NavigateAction({ page: 'page' })
    expect(action.handle({ url: 'https://example.com' })).toEqual([
      "await page.goto('https://example.com');",
    ])
  })

  it('targets whatever page name the current context holds', () => {
    const action = new NavigateAction({ page: 'tab1' })
    expect(action.handle({ url: 'https://example.com/x' })).toEqual([
      "await tab1.goto('https://example.com/x');",
    ])
  })
})
