jest.mock('../src/converter/index.js', () => ({
  convertToPlaywright: jest.fn().mockResolvedValue('converted script')
}))

import { convertToPlaywright } from '../src/playwright-converter.js'
import { convertToPlaywright as convert } from '../src/converter/index.js'

describe('convertToPlaywright (CLI wrapper)', () => {
  afterEach(() => {
    convert.mockClear()
  })

  it('delegates to the local converter and returns its result', async () => {
    const userFlow = { title: 'Flow' }
    const result = await convertToPlaywright(userFlow)

    expect(convert).toHaveBeenCalledWith(userFlow)
    expect(result).toBe('converted script')
  })

  it('accepts an options object without forwarding it to the converter', async () => {
    const userFlow = { title: 'Flow' }
    await convertToPlaywright(userFlow, { cloud: 'x', user: 'y', team: 'z' })

    expect(convert).toHaveBeenCalledWith(userFlow)
  })
})
