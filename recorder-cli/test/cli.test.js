jest.mock('../src/index.js', () => ({ startRecording: jest.fn() }))
jest.mock('../src/playwright-converter.js', () => ({ convertToPlaywright: jest.fn() }))
jest.mock('../src/report.js', () => ({ generateReport: jest.fn() }))

jest.mock('chalk', () => ({
  blue: Object.assign((s) => s, { bold: (s) => s }),
  gray: (s) => s,
  red: (s) => s,
  green: (s) => s
}))

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn()
}))

const originalArgv = process.argv

async function loadMocks(args) {
  jest.resetModules()
  process.argv = ['node', 'cli.js', ...args]

  const [indexMod, converterMod, reportMod, fsMod] = await Promise.all([
    import('../src/index.js'),
    import('../src/playwright-converter.js'),
    import('../src/report.js'),
    import('fs')
  ])

  return {
    startRecording: indexMod.startRecording,
    convertToPlaywright: converterMod.convertToPlaywright,
    generateReport: reportMod.generateReport,
    fs: fsMod.default
  }
}

async function runCli() {
  await import('../bin/cli.js')
  await new Promise((resolve) => setImmediate(resolve))
}

describe('bin/cli.js', () => {
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
    process.argv = originalArgv
  })

  function loggedText() {
    return logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
  }

  describe('record', () => {
    it('generates a timestamped output path and prints the target URL when no output/org is given', async () => {
      const { startRecording } = await loadMocks(['record'])
      startRecording.mockResolvedValue(undefined)

      await runCli()

      expect(startRecording).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'about:blank',
          output: expect.stringMatching(/^\.\/test-plans\/playwright\/recording_.*\.json$/)
        })
      )
      expect(loggedText()).toContain('URL: about:blank')
    })

    it('keeps an explicitly provided output path instead of generating one', async () => {
      const { startRecording } = await loadMocks(['record', '--output', './custom.json'])
      startRecording.mockResolvedValue(undefined)

      await runCli()

      expect(startRecording).toHaveBeenCalledWith(expect.objectContaining({ output: './custom.json' }))
    })

    it('prints the org instead of the URL when --org is provided', async () => {
      const { startRecording } = await loadMocks(['record', '--org', 'myOrgAlias'])
      startRecording.mockResolvedValue(undefined)

      await runCli()

      const text = loggedText()
      expect(text).toContain('Org: myOrgAlias')
      expect(text).not.toContain('URL:')
    })

    it('prints an error and exits with status 1 when recording fails', async () => {
      const { startRecording } = await loadMocks(['record'])
      startRecording.mockRejectedValue(new Error('boom'))

      await runCli()

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'))
      expect(exitSpy).toHaveBeenCalledWith(1)
    })
  })

  describe('convert', () => {
    it('errors out when the input file does not exist', async () => {
      const { fs } = await loadMocks(['convert', 'missing.json'])
      fs.existsSync.mockReturnValue(false)
      fs.readFileSync.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      await runCli()

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('File not found'))
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it('converts the recording and writes the playwright script to the derived output path', async () => {
      const { fs, convertToPlaywright } = await loadMocks(['convert', '/tmp/recording.json'])
      fs.existsSync.mockReturnValue(true)
      fs.readFileSync.mockReturnValue(JSON.stringify({ steps: [] }))
      convertToPlaywright.mockResolvedValue('// playwright code')

      await runCli()

      expect(convertToPlaywright).toHaveBeenCalledWith({ steps: [] }, { cloud: '', user: '', team: '' })
      expect(fs.writeFileSync).toHaveBeenCalledWith('/tmp/recording.spec.js', '// playwright code')
      expect(loggedText()).toContain('Playwright script saved')
    })

    it('writes to an explicitly provided --output path', async () => {
      const { fs, convertToPlaywright } = await loadMocks(['convert', '/tmp/recording.json', '--output', '/tmp/out.spec.js'])
      fs.existsSync.mockReturnValue(true)
      fs.readFileSync.mockReturnValue(JSON.stringify({ steps: [] }))
      convertToPlaywright.mockResolvedValue('// code')

      await runCli()

      expect(fs.writeFileSync).toHaveBeenCalledWith('/tmp/out.spec.js', '// code')
    })

    it('prints an error and exits with status 1 when conversion throws', async () => {
      const { fs, convertToPlaywright } = await loadMocks(['convert', '/tmp/recording.json'])
      fs.existsSync.mockReturnValue(true)
      fs.readFileSync.mockReturnValue(JSON.stringify({ steps: [] }))
      convertToPlaywright.mockRejectedValue(new Error('conversion failed'))

      await runCli()

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('conversion failed'))
      expect(exitSpy).toHaveBeenCalledWith(1)
    })
  })

  describe('report', () => {
    it('requests only the latest run by default', async () => {
      const { generateReport } = await loadMocks(['report'])

      await runCli()

      expect(generateReport).toHaveBeenCalledWith({ last: true, all: undefined, json: undefined })
    })

    it('passes through --all and --json flags', async () => {
      const { generateReport } = await loadMocks(['report', '--all', '--json'])

      await runCli()

      expect(generateReport).toHaveBeenCalledWith({ last: false, all: true, json: true })
    })
  })
})
