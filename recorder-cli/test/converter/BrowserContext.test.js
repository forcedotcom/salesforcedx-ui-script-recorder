import { BrowserContext } from '../../src/converter/BrowserContext.js'

describe('BrowserContext', () => {
  it('defaults page to the literal "page"', () => {
    const context = new BrowserContext()
    expect(context.page).toBe('page')
  })
})
