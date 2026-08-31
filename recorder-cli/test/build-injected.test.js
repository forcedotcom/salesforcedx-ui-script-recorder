jest.mock('esbuild', () => ({ build: jest.fn() }))
jest.mock('fs', () => ({ mkdirSync: jest.fn(), writeFileSync: jest.fn() }))

async function loadMocks() {
  jest.resetModules()
  const [esbuildMod, fsMod] = await Promise.all([import('esbuild'), import('fs')])
  return { esbuild: esbuildMod.default, fs: fsMod.default }
}

async function runScript() {
  await import('../scripts/build-injected.js')
  await new Promise((resolve) => setImmediate(resolve))
}

describe('scripts/build-injected.js', () => {
  let logSpy
  let errorSpy
  let exitSpy

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('bundles the injected entry point with esbuild and writes it to dist/injected-bundle.js', async () => {
    const { esbuild, fs } = await loadMocks()
    esbuild.build.mockResolvedValue({ outputFiles: [{ text: 'BUNDLED_CODE' }] })

    await runScript()

    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('dist'), { recursive: true })
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
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('injected-bundle.js'), 'BUNDLED_CODE')
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Injected script bundle written to'))
  })

  it('logs the error and exits with status 1 when the esbuild build fails', async () => {
    const { esbuild } = await loadMocks()
    const failure = new Error('bundling failed')
    esbuild.build.mockRejectedValue(failure)

    await runScript()

    expect(errorSpy).toHaveBeenCalledWith('Build failed:', failure)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
