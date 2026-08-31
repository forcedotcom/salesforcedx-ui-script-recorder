jest.mock('prettier', () => ({
  default: {
    format: jest.fn().mockRejectedValue(new Error('prettier is not available'))
  }
}))

import { convertToPlaywright } from '../../src/converter/index.js'

describe('convertToPlaywright when prettier fails', () => {
  it('returns the unformatted script instead of throwing', async () => {
    const data = { title: 'My Test', steps: [{ type: 'navigate', url: 'https://example.com' }] }

    const output = await convertToPlaywright(data)

    expect(output).toContain("test('My Test'")
    expect(output).toContain("await page.goto('https://example.com')")
  })
})
