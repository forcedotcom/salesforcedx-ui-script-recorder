jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn()
}))

jest.mock('esbuild', () => {
  throw new Error("Cannot find module 'esbuild'")
})

import { buildInjectedScript } from '../src/build.js'

describe('buildInjectedScript (esbuild unavailable)', () => {
  it('throws a helpful error when neither a prebuilt bundle nor esbuild is available', async () => {
    await expect(buildInjectedScript()).rejects.toThrow(
      /Pre-built injected script not found and esbuild is not available/
    )
  })
})
