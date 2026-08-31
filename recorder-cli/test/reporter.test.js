jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  copyFileSync: jest.fn(),
  existsSync: jest.fn()
}))

import fs from 'fs'
import path from 'path'
import RecorderReporter from '../src/reporter.js'

function readJson(mock, index = -1) {
  const calls = mock.mock.calls
  const call = index < 0 ? calls[calls.length + index] : calls[index]
  return JSON.parse(call[1])
}

describe('RecorderReporter', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...originalEnv }
    delete process.env.SALESFORCE_UI_SCRIPT_RECORDER_BATCH_ID
    delete process.env.SALESFORCE_UI_SCRIPT_RECORDER_BATCH_TIMESTAMP
    delete process.env.SALESFORCE_UI_SCRIPT_RECORDER_SESSION_INDEX
    fs.existsSync.mockReturnValue(false)
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('records passed/failed/skipped/timedOut test results, including error details', () => {
    const reporter = new RecorderReporter()
    reporter.onBegin({}, { title: 'My Suite' })

    reporter.onTestEnd(
      { title: 'passes', location: { file: '/repo/tests/a.spec.js' } },
      { status: 'passed', duration: 100, retry: 0 }
    )
    reporter.onTestEnd(
      { title: 'fails', location: { file: '/repo/tests/a.spec.js' } },
      {
        status: 'failed',
        duration: 200,
        retry: 1,
        errors: [{ message: 'boom', stack: 'stack trace', snippet: '> line' }]
      }
    )
    reporter.onTestEnd(
      { title: 'times out', location: { file: '/repo/tests/a.spec.js' } },
      { status: 'timedOut', duration: 300, retry: 0, errors: [{ message: 'timeout' }] }
    )
    reporter.onTestEnd(
      { title: 'skipped', location: { file: '/repo/tests/a.spec.js' } },
      { status: 'skipped', duration: 0, retry: 0 }
    )

    expect(reporter.results).toHaveLength(4)
    expect(reporter.results[1].errors).toEqual([{ message: 'boom', stack: 'stack trace', snippet: '> line' }])
    expect(reporter.results[0].errors).toBeUndefined()
  })

  it('captures stdout, stderr, and attachments when present', () => {
    const reporter = new RecorderReporter()
    reporter.onBegin({}, { title: 'My Suite' })

    reporter.onTestEnd(
      { title: 'has output', location: { file: '/repo/tests/a.spec.js' } },
      {
        status: 'passed',
        duration: 10,
        retry: 0,
        stdout: [Buffer.from('out1'), 'out2'],
        stderr: [Buffer.from('err1')],
        attachments: [{ name: 'shot', contentType: 'image/png', path: '/tmp/shot.png' }]
      }
    )

    const [entry] = reporter.results
    expect(entry.stdout).toBe('out1out2')
    expect(entry.stderr).toBe('err1')
    expect(entry.attachments).toEqual([{ name: 'shot', contentType: 'image/png', path: '/tmp/shot.png' }])
  })

  it('omits stdout/stderr/attachments entirely when they are empty', () => {
    const reporter = new RecorderReporter()
    reporter.onBegin({}, { title: 'My Suite' })

    reporter.onTestEnd(
      { title: 'quiet', location: { file: '/repo/tests/a.spec.js' } },
      { status: 'passed', duration: 10, retry: 0, stdout: [], stderr: [], attachments: [] }
    )

    const [entry] = reporter.results
    expect(entry.stdout).toBeUndefined()
    expect(entry.stderr).toBeUndefined()
    expect(entry.attachments).toBeUndefined()
  })

  it('defaults the suite name when the root suite has no title', () => {
    const reporter = new RecorderReporter()
    reporter.onBegin({}, {})
    expect(reporter.suiteName).toBe('Test Run')
  })

  it('writes a non-batch run to a timestamped directory and updates latest.json', () => {
    const reporter = new RecorderReporter()
    reporter.onBegin({}, { title: 'Suite' })
    reporter.onTestEnd(
      { title: 'ok', location: { file: '/repo/tests/login.spec.js' } },
      { status: 'passed', duration: 5, retry: 0 }
    )

    reporter.onEnd({ status: 'passed', duration: 500 })

    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('playback-results'), { recursive: true })

    const resultsCall = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('results.json'))
    expect(resultsCall[0]).toContain('login')
    const summary = JSON.parse(resultsCall[1])
    expect(summary.total).toBe(1)
    expect(summary.passed).toBe(1)
    expect(summary).not.toHaveProperty('batchId')

    const latestCall = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('latest.json'))
    expect(latestCall).toBeDefined()
    const latest = JSON.parse(latestCall[1])
    expect(latest.run).toContain('login')
  })

  it('combines multiple spec file names when a run covers more than one spec', () => {
    const reporter = new RecorderReporter()
    reporter.onBegin({}, { title: 'Suite' })
    reporter.onTestEnd({ title: 'a', location: { file: '/repo/a.spec.js' } }, { status: 'passed', duration: 1, retry: 0 })
    reporter.onTestEnd({ title: 'b', location: { file: '/repo/b.spec.js' } }, { status: 'passed', duration: 1, retry: 0 })

    reporter.onEnd({ status: 'passed', duration: 10 })

    const resultsCall = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('results.json'))
    expect(resultsCall[0]).toMatch(/a\+b/)
  })

  it('writes a batched run under a bulk session folder and includes batch metadata', () => {
    process.env.SALESFORCE_UI_SCRIPT_RECORDER_BATCH_ID = 'batch-123'
    process.env.SALESFORCE_UI_SCRIPT_RECORDER_BATCH_TIMESTAMP = '2026-01-01T00-00-00-000Z'
    process.env.SALESFORCE_UI_SCRIPT_RECORDER_SESSION_INDEX = '2'

    const reporter = new RecorderReporter()
    reporter.onBegin({}, { title: 'Suite' })
    reporter.onTestEnd(
      { title: 'a', location: { file: '/repo/login.spec.js' } },
      { status: 'failed', duration: 1, retry: 0, errors: [{ message: 'nope' }] }
    )

    reporter.onEnd({ status: 'failed', duration: 10 })

    const resultsCall = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('results.json'))
    expect(resultsCall[0]).toContain(`${path.sep}session-2${path.sep}results.json`)
    expect(resultsCall[0]).toContain('---BULK')

    const summary = JSON.parse(resultsCall[1])
    expect(summary.batchId).toBe('batch-123')
    expect(summary.sessionIndex).toBe(2)
    expect(summary.failed).toBe(1)
  })

  it('falls back to the current timestamp for the bulk folder name when no batch timestamp env var is set', () => {
    process.env.SALESFORCE_UI_SCRIPT_RECORDER_BATCH_ID = 'batch-123'
    process.env.SALESFORCE_UI_SCRIPT_RECORDER_SESSION_INDEX = '1'

    const reporter = new RecorderReporter()
    reporter.onBegin({}, { title: 'Suite' })
    reporter.onTestEnd({ title: 'a', location: { file: '/repo/login.spec.js' } }, { status: 'passed', duration: 1, retry: 0 })

    reporter.onEnd({ status: 'passed', duration: 10 })

    const resultsCall = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('results.json'))
    expect(resultsCall[0]).toContain('---BULK')
  })

  it('copies png attachments into the run folder and rewrites their path', () => {
    fs.existsSync.mockReturnValue(true)
    const reporter = new RecorderReporter()
    reporter.onBegin({}, { title: 'Suite' })
    reporter.onTestEnd(
      { title: 'has a screenshot!', location: { file: '/repo/login.spec.js' } },
      {
        status: 'failed',
        duration: 1,
        retry: 0,
        errors: [],
        attachments: [{ name: 'screenshot', contentType: 'image/png', path: '/tmp/original.png' }]
      }
    )

    reporter.onEnd({ status: 'failed', duration: 10 })

    expect(fs.copyFileSync).toHaveBeenCalledWith('/tmp/original.png', expect.stringContaining('failed--has-a-screenshot.png'))
    const summary = readJson(fs.writeFileSync, -2)
    expect(summary.tests[0].attachments[0].path).toBe('failed--has-a-screenshot.png')
  })

  it('detects an image attachment by file extension even without an image content type', () => {
    fs.existsSync.mockReturnValue(true)
    const reporter = new RecorderReporter()
    reporter.onBegin({}, { title: 'Suite' })
    reporter.onTestEnd(
      { title: 'shot', location: { file: '/repo/login.spec.js' } },
      { status: 'passed', duration: 1, retry: 0, attachments: [{ name: 'x', path: '/tmp/x.PNG' }] }
    )

    reporter.onEnd({ status: 'passed', duration: 10 })

    expect(fs.copyFileSync).toHaveBeenCalled()
  })

  it('leaves non-image attachments and missing files untouched', () => {
    fs.existsSync.mockReturnValue(false)
    const reporter = new RecorderReporter()
    reporter.onBegin({}, { title: 'Suite' })
    reporter.onTestEnd(
      { title: 'trace', location: { file: '/repo/login.spec.js' } },
      {
        status: 'passed',
        duration: 1,
        retry: 0,
        attachments: [
          { name: 'trace', contentType: 'application/zip', path: '/tmp/trace.zip' },
          { name: 'noPath', contentType: 'image/png' },
          { name: 'missing', contentType: 'image/png', path: '/tmp/missing.png' },
          { name: 'noContentTypeOrPath' }
        ]
      }
    )

    reporter.onEnd({ status: 'passed', duration: 10 })

    expect(fs.copyFileSync).not.toHaveBeenCalled()
    const summary = readJson(fs.writeFileSync, -2)
    expect(summary.tests[0].attachments[0].path).toBe('/tmp/trace.zip')
    expect(summary.tests[0].attachments[2].path).toBe('/tmp/missing.png')
    expect(summary.tests[0].attachments[3]).toEqual({ name: 'noContentTypeOrPath' })
  })

  it('falls back to a .png extension and a generic "test" title when both are unavailable', () => {
    fs.existsSync.mockReturnValue(true)
    const reporter = new RecorderReporter()
    reporter.onBegin({}, { title: 'Suite' })
    reporter.onTestEnd(
      { title: '!!!', location: { file: '/repo/login.spec.js' } },
      { status: 'passed', duration: 1, retry: 0, attachments: [{ name: 'x', contentType: 'image/png', path: '/tmp/screenshot' }] }
    )

    reporter.onEnd({ status: 'passed', duration: 10 })

    expect(fs.copyFileSync).toHaveBeenCalledWith('/tmp/screenshot', expect.stringContaining('passed--test.png'))
  })

  it('falls back to the original attachment when copying the file throws', () => {
    fs.existsSync.mockReturnValue(true)
    fs.copyFileSync.mockImplementation(() => {
      throw new Error('disk full')
    })
    const reporter = new RecorderReporter()
    reporter.onBegin({}, { title: 'Suite' })
    reporter.onTestEnd(
      { title: 'shot', location: { file: '/repo/login.spec.js' } },
      { status: 'passed', duration: 1, retry: 0, attachments: [{ name: 'x', contentType: 'image/png', path: '/tmp/x.png' }] }
    )

    reporter.onEnd({ status: 'passed', duration: 10 })

    const summary = readJson(fs.writeFileSync, -2)
    expect(summary.tests[0].attachments[0].path).toBe('/tmp/x.png')
  })

  it('skips tests that have no attachments at all', () => {
    const reporter = new RecorderReporter()
    reporter.onBegin({}, { title: 'Suite' })
    reporter.onTestEnd({ title: 'plain', location: { file: '/repo/login.spec.js' } }, { status: 'passed', duration: 1, retry: 0 })

    expect(() => reporter.onEnd({ status: 'passed', duration: 10 })).not.toThrow()
  })
})
