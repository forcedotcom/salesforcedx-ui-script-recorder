import { BrowserContext } from '../../src/converter/BrowserContext.js'

describe('BrowserContext', () => {
  it('defaults page to the literal "page"', () => {
    const context = new BrowserContext()
    expect(context.page).toBe('page')
  })

  it('maps recorded tab ids to generated page variables', () => {
    const context = new BrowserContext()

    expect(context.activatePage('main')).toBe('page')
    context.registerPage('popup', 'tab1')
    expect(context.activatePage('main')).toBe('page')
    expect(context.activatePage('popup')).toBe('tab1')
    expect(context.pageForTabId('popup')).toBe('tab1')
    expect(context.tabIdForPage('tab1')).toBe('popup')

    context.unregisterPage('popup')
    expect(context.pageForTabId('popup')).toBeNull()
  })
})
