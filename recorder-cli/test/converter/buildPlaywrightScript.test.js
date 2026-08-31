import { getScriptBody } from '../../src/converter/buildPlaywrightScript.js'
import { ChangeAction } from '../../src/converter/scriptHandlers/ChangeAction.js'
import { AssertAction } from '../../src/converter/scriptHandlers/AssertAction.js'
import { FrameAction } from '../../src/converter/scriptHandlers/FrameAction.js'

describe('getScriptBody', () => {
  it('resets declared credential vars for each new conversion', () => {
    const spy = jest.spyOn(ChangeAction, 'resetDeclaredVars')
    getScriptBody({ steps: [] })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('returns an empty string for no steps', () => {
    expect(getScriptBody({ steps: [] })).toBe('')
  })

  it('ignores steps with an unrecognised type', () => {
    expect(getScriptBody({ steps: [{ type: 'unknownType' }] })).toBe('')
  })

  it('dispatches a click step through ClickAction', () => {
    const result = getScriptBody({ steps: [{ type: 'click', selectors: [['#btn']] }] })
    expect(result).toBe("\nawait page.click('#btn');")
  })

  it('dispatches a doubleClick step through ClickAction (which always emits a click call)', () => {
    const result = getScriptBody({ steps: [{ type: 'doubleClick', selectors: [['#btn']] }] })
    expect(result).toBe("\nawait page.click('#btn');")
  })

  it('dispatches a change step through ChangeAction', () => {
    const result = getScriptBody({ steps: [{ type: 'change', inputType: 'text', value: 'hi', selectors: [['#inp']] }] })
    expect(result).toContain("await page.fill('#inp', 'hi');")
  })

  it('dispatches an assert step through AssertAction', () => {
    const result = getScriptBody({ steps: [{ type: 'assert', selectors: [['#msg']] }] })
    expect(result).toBe("await expect(page.locator('#msg')).toBeVisible();")
  })

  it('dispatches navigate/setViewport/keyDown/keyUp steps to their handlers', () => {
    const result = getScriptBody({
      steps: [
        { type: 'navigate', url: 'https://example.com' },
        { type: 'setViewport', width: 100, height: 200 },
        { type: 'keyDown', key: 'Enter' },
        { type: 'keyUp', key: 'Enter' }
      ]
    })

    expect(result.split('\n')).toEqual([
      "await page.goto('https://example.com');",
      'await page.setViewportSize({ width: 100, height: 200 });',
      "await page.keyboard.press('Enter');",
      "await page.keyboard.press('Enter');"
    ])
  })

  it('appends a delay line when the step specifies a duration', () => {
    const result = getScriptBody({ steps: [{ type: 'navigate', url: 'https://example.com', duration: 500 }] })
    expect(result).toBe("await page.goto('https://example.com');\nawait delay(500)")
  })

  it('does not append a delay line when duration is absent', () => {
    const result = getScriptBody({ steps: [{ type: 'navigate', url: 'https://example.com' }] })
    expect(result).not.toContain('delay(')
  })

  it('routes click steps with frameSelectors through FrameAction instead of the actions map', () => {
    const result = getScriptBody({
      steps: [{ type: 'click', frameSelectors: ['#frame1'], selectors: [['#btn']] }]
    })

    expect(result).toBe(
      ["const frame0 = page.frameLocator('#frame1');", "const frameAction0 = frame0.locator('#btn');", 'await frameAction0.click()'].join(
        '\n'
      )
    )
  })

  it('routes change steps with frameSelectors through FrameAction', () => {
    const result = getScriptBody({
      steps: [{ type: 'change', frameSelectors: ['#frame1'], value: 'hi', selectors: [['#inp']] }]
    })

    expect(result).toContain("const frame0 = page.frameLocator('#frame1');")
    expect(result).toContain("await frameAction0.fill('#inp', 'hi');")
  })

  it('does not route through FrameAction when frameSelectors are present but the type is not click/change', () => {
    const spy = jest.spyOn(FrameAction.prototype, 'handle')
    const result = getScriptBody({
      steps: [{ type: 'assert', frameSelectors: ['#frame1'], selectors: [['#msg']] }]
    })

    expect(spy).not.toHaveBeenCalled()
    expect(result).toBe("await expect(page.locator('#msg')).toBeVisible();")
    spy.mockRestore()
  })

  it('tolerates a falsy result from FrameAction.handle', () => {
    const spy = jest.spyOn(FrameAction.prototype, 'handle').mockReturnValueOnce(null)
    const result = getScriptBody({
      steps: [{ type: 'click', frameSelectors: ['#frame1'], selectors: [['#btn']] }]
    })

    expect(result).toBe('')
    spy.mockRestore()
  })

  it('tolerates a falsy result from an action handler', () => {
    const spy = jest.spyOn(AssertAction.prototype, 'handle').mockReturnValueOnce(null)
    const result = getScriptBody({ steps: [{ type: 'assert', selectors: [['#msg']] }] })

    expect(result).toBe('')
    spy.mockRestore()
  })
})
