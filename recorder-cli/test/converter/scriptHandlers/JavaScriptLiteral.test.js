import { toJavaScriptStringLiteral } from '../../../src/converter/scriptHandlers/JavaScriptLiteral.js'

describe('toJavaScriptStringLiteral', () => {
  it.each([
    '',
    "owner's value",
    'double "quote"',
    '\\"',
    'line one\nline two\r\nline three',
    'tabs\tand\0control',
    'separator\u2028paragraph\u2029end',
    "'); throw new Error('injected'); //"
  ])('round trips arbitrary recorder text without executing it: %j', value => {
    const literal = toJavaScriptStringLiteral(value)
    const evaluated = new Function(`return ${literal}`)()
    expect(evaluated).toBe(value)
  })
})
