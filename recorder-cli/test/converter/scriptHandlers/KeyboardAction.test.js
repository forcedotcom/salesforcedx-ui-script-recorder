import { KeyBoardAction } from '../../../src/converter/scriptHandlers/KeyboardAction.js'

describe('KeyBoardAction', () => {
  it('emits an awaited keyboard.press call with the step key', () => {
    const action = new KeyBoardAction({ page: 'page' })
    expect(action.handle({ key: 'Enter' })).toEqual([
      "await page.keyboard.press('Enter');",
    ])
  })
})
