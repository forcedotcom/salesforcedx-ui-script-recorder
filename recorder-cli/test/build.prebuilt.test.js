jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn()
}))

import fs from 'fs'
import { buildInjectedScript } from '../src/build.js'

describe('buildInjectedScript (prebuilt bundle present)', () => {
  it('returns the prebuilt bundle contents without invoking esbuild', async () => {
    fs.existsSync.mockReturnValue(true)
    fs.readFileSync.mockReturnValue('PREBUILT_BUNDLE_CONTENTS')

    const result = await buildInjectedScript()

    expect(result).toBe('PREBUILT_BUNDLE_CONTENTS')
    expect(fs.existsSync).toHaveBeenCalledWith(expect.stringContaining('injected-bundle.js'))
    expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining('injected-bundle.js'), 'utf-8')
  })
})
