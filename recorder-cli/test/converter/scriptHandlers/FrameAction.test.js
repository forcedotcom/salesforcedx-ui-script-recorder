import { FrameAction } from '../../../src/converter/scriptHandlers/FrameAction.js'
import { ClickAction } from '../../../src/converter/scriptHandlers/ClickAction.js'
import { ChangeAction } from '../../../src/converter/scriptHandlers/ChangeAction.js'
import { Stack } from '../../../src/converter/Stack.js'

describe('FrameAction', () => {
  const buildAction = (context = { page: 'page' }, stack = new Stack()) => new FrameAction(stack, context, { value: 0 })

  it('returns no actions when the step has no frameSelectors', () => {
    const action = buildAction()
    expect(action.handle({ type: 'click' })).toEqual([])
    expect(action.handle({ type: 'click', frameSelectors: [] })).toEqual([])
  })

  it('falls back to "page" when the stack is empty', () => {
    const action = buildAction()
    const result = action.handle({ type: 'assert', frameSelectors: ['#frame1'] })
    expect(result).toEqual(["const frame0 = page.frameLocator('#frame1');"])
  })

  it('bases the frame locator on the current page from the stack', () => {
    const stack = new Stack()
    stack.push('tab0')
    const action = buildAction({ page: 'tab0' }, stack)

    const result = action.handle({ type: 'assert', frameSelectors: ['#frame1'] })

    expect(result).toEqual(["const frame0 = tab0.frameLocator('#frame1');"])
  })

  it('chains multiple frame selectors', () => {
    const action = buildAction()
    const result = action.handle({ type: 'assert', frameSelectors: ['#outer', '#inner'] })
    expect(result).toEqual(["const frame0 = page.frameLocator('#outer').frameLocator('#inner');"])
  })

  it('clicks directly on the frame-scoped selector without a timeout', () => {
    const action = buildAction()
    const result = action.handle({ type: 'click', frameSelectors: ['#frame1'], selectors: [['#btn']] })

    expect(result).toEqual([
      "const frame0 = page.frameLocator('#frame1');",
      "const frameAction0 = frame0.locator('#btn');",
      'await frameAction0.click()'
    ])
  })

  it('clicks with a timeout when the step specifies one', () => {
    const action = buildAction()
    const result = action.handle({ type: 'click', frameSelectors: ['#frame1'], selectors: [['#btn']], timeout: 3000 })

    expect(result).toEqual([
      "const frame0 = page.frameLocator('#frame1');",
      "const frameAction0 = frame0.locator('#btn');",
      'await frameAction0.click({timeout: 3000})'
    ])
  })

  it('delegates to ClickAction when there is no frame-scoped selector', () => {
    const action = buildAction()
    const result = action.handle({ type: 'click', frameSelectors: ['#frame1'] })

    expect(result[0]).toBe("const frame0 = page.frameLocator('#frame1');")
    expect(result.length).toBeGreaterThan(1)
    expect(result.some(line => line.includes('.click('))).toBe(true)
  })

  it('discards nothing extra when the delegated ClickAction has no output', () => {
    const spy = jest.spyOn(ClickAction.prototype, 'handle').mockReturnValueOnce(null)
    const action = buildAction()

    const result = action.handle({ type: 'click', frameSelectors: ['#frame1'] })

    expect(result).toEqual(["const frame0 = page.frameLocator('#frame1');"])
    spy.mockRestore()
  })

  it('fills directly on the frame-scoped selector when found', () => {
    const action = buildAction()
    const result = action.handle({
      type: 'change',
      frameSelectors: ['#frame1'],
      value: 'hello',
      selectors: [['#inp']]
    })

    expect(result).toEqual([
      "const frame0 = page.frameLocator('#frame1');",
      "const frameAction0 = frame0.locator('#inp');",
      "await frameAction0.fill('#inp', 'hello');"
    ])
  })

  it('delegates to ChangeAction when there is no frame-scoped selector', () => {
    const action = buildAction()
    const result = action.handle({ type: 'change', frameSelectors: ['#frame1'], value: 'hello' })

    expect(result[0]).toBe("const frame0 = page.frameLocator('#frame1');")
    expect(result.some(line => line.includes('.fill('))).toBe(true)
  })

  it('discards nothing extra when the delegated ChangeAction has no output', () => {
    const spy = jest.spyOn(ChangeAction.prototype, 'handle').mockReturnValueOnce(null)
    const action = buildAction()

    const result = action.handle({ type: 'change', frameSelectors: ['#frame1'], value: 'hello' })

    expect(result).toEqual(["const frame0 = page.frameLocator('#frame1');"])
    spy.mockRestore()
  })

  it('increments frame counters across repeated calls on the same instance', () => {
    const action = buildAction()
    action.handle({ type: 'assert', frameSelectors: ['#frame1'] })
    const second = action.handle({ type: 'assert', frameSelectors: ['#frame2'] })
    expect(second).toEqual(["const frame1 = page.frameLocator('#frame2');"])
  })
})
