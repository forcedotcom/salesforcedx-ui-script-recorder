import { pauseDuration, timeoutDuration } from '../../src/converter/constants.js'

describe('converter constants', () => {
  it('exposes the expected default durations', () => {
    expect(pauseDuration).toBe(2000)
    expect(timeoutDuration).toBe(120000)
  })
})
