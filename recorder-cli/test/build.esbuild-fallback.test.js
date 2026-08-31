jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn()
}))

jest.mock('esbuild', () => ({
  build: jest.fn().mockResolvedValue({ outputFiles: [{ text: 'BUNDLED_CODE' }] })
}))

import * as esbuild from 'esbuild'
import { buildInjectedScript } from '../src/build.js'

describe('buildInjectedScript (falls back to esbuild)', () => {
  it('builds the entry point with esbuild when no prebuilt bundle exists', async () => {
    const result = await buildInjectedScript()

    expect(result).toBe('BUNDLED_CODE')
    expect(esbuild.build).toHaveBeenCalledWith(
      expect.objectContaining({
        entryPoints: [expect.stringContaining('entry.js')],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        minify: false
      })
    )
  })
})
