import { ViewportAction } from '../../../src/converter/scriptHandlers/ViewportAction.js'

describe('ViewportAction', () => {
  it('emits an awaited setViewportSize call with the step dimensions', () => {
    const action = new ViewportAction({ page: 'page' })
    expect(action.handle({ width: 1280, height: 720 })).toEqual([
      'await page.setViewportSize({ width: 1280, height: 720 });',
    ])
  })
})
