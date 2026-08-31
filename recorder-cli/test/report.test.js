jest.mock('chalk', () => ({
  green: (s) => s,
  red: (s) => s,
  yellow: (s) => s,
  cyan: (s) => s,
  dim: (s) => s,
  magenta: (s) => s,
  bold: (s) => s
}))

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  readFileSync: jest.fn()
}))

import fs from 'fs'
import path from 'path'
import { generateReport } from '../src/report.js'

const RESULTS_DIR = path.resolve('playback-results')

const runAData = {
  status: 'failed',
  timestamp: '2026-01-01T00:00:00.000Z',
  duration: 3000,
  total: 5,
  passed: 1,
  failed: 2,
  skipped: 1,
  timedOut: 1,
  tests: [
    { file: 'a.spec.js', title: 'passes', status: 'passed' },
    { file: 'a.spec.js', title: 'fails hard', status: 'failed', errors: [{ message: 'Something broke\nat line 2' }] },
    { file: 'a.spec.js', title: 'skipped one', status: 'skipped' },
    { file: 'a.spec.js', title: 'times out', status: 'timedOut', errors: [{}] },
    { file: 'a.spec.js', title: 'fails with no error details', status: 'failed' }
  ]
}

const session1Data = {
  status: 'passed',
  batchId: 'b1',
  sessionIndex: 1,
  timestamp: '2026-01-02T00:00:00.000Z',
  duration: 500,
  tests: []
}

const session2Data = {
  status: 'failed',
  batchId: 'b1',
  sessionIndex: 2,
  timestamp: '2026-01-02T00:05:00.000Z',
  duration: 65000,
  tests: [
    { file: 'b.spec.js', title: 'fails', status: 'failed', errors: [{ message: 'Error one\nstack trace' }] },
    { file: 'b.spec.js', title: 'times out', status: 'timedOut', errors: [{ message: 'Timeout hit' }] },
    { file: 'b.spec.js', title: 'fails silently', status: 'failed', errors: [] },
    { file: 'b.spec.js', title: 'fails with no message', status: 'failed', errors: [{}] }
  ]
}

function setupFullFixture() {
  fs.existsSync.mockImplementation((p) => {
    if (p === RESULTS_DIR) return true
    if (p.endsWith(path.join('run-A', 'results.json'))) return true
    if (p.endsWith(path.join('run-B-nodata', 'results.json'))) return false
    if (p.endsWith(path.join('session-1', 'results.json'))) return true
    if (p.endsWith(path.join('session-2', 'results.json'))) return true
    if (p.endsWith(path.join('session-nodata', 'results.json'))) return false
    return false
  })

  fs.statSync.mockImplementation((p) => ({
    isDirectory: () => {
      if (p.endsWith('not-a-dir.txt')) return false
      if (p.endsWith('session-not-dir')) return false
      return true
    }
  }))

  fs.readdirSync.mockImplementation((dir) => {
    if (dir === RESULTS_DIR) return ['run-A', 'run-B-nodata', 'not-a-dir.txt', 'batch-1---BULK']
    if (dir.endsWith('batch-1---BULK')) return ['session-1', 'session-2', 'session-not-dir', 'session-nodata']
    return []
  })

  fs.readFileSync.mockImplementation((p) => {
    if (p.includes('run-A')) return JSON.stringify(runAData)
    if (p.includes('session-1')) return JSON.stringify(session1Data)
    if (p.includes('session-2')) return JSON.stringify(session2Data)
    throw new Error(`unexpected readFileSync path: ${p}`)
  })
}

describe('generateReport', () => {
  let logSpy

  beforeEach(() => {
    jest.resetAllMocks()
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  function loggedText() {
    return logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
  }

  it('reports no results when the results directory does not exist', () => {
    fs.existsSync.mockReturnValue(false)

    generateReport()

    expect(loggedText()).toContain('No test results found. Run a playback first.')
    expect(fs.readdirSync).not.toHaveBeenCalled()
  })

  it('reports no results when the results directory has no run subdirectories', () => {
    fs.existsSync.mockReturnValue(true)
    fs.readdirSync.mockReturnValue([])

    generateReport()

    expect(loggedText()).toContain('No test results found. Run a playback first.')
  })

  it('prints only the most recent run by default', () => {
    setupFullFixture()

    generateReport()

    const text = loggedText()
    expect(text).toContain('FAIL')
    expect(text).toContain('1 passed')
    expect(text).toContain('2 failed')
    expect(text).toContain('1 skipped')
    expect(text).toContain('1 timed out')
    expect(text).toContain('5 total')
    expect(text).toContain('a.spec.js > fails hard')
    expect(text).toContain('Something broke')
    expect(text).toContain('a.spec.js > times out')
    expect(text).toContain('Unknown error')
    expect(text).not.toContain('BULK')
  })

  it('prints every run group and a trend summary when --all is passed', () => {
    setupFullFixture()

    generateReport({ all: true })

    const text = loggedText()
    expect(text).toContain('BULK')
    expect(text).toContain('2 sessions')
    expect(text).toContain('1 passed')
    expect(text).toContain('1 failed')
    expect(text).toContain('Session 1')
    expect(text).toContain('Session 2')
    expect(text).toContain('Error one')
    expect(text).toContain('Timeout hit')
    expect(text).toContain('FAIL')
    expect(text).toContain('Trend (last 2 runs)')
    expect(text).toContain('0/2 passed (0%)')
  })

  it('prints only the latest run as JSON when json is requested without --all', () => {
    setupFullFixture()

    generateReport({ json: true })

    const printed = JSON.parse(logSpy.mock.calls[0][0])
    expect(printed).toHaveLength(1)
    expect(printed[0].batchId).toBeNull()
    expect(printed[0].runs[0]._dirName).toBe('run-A')
  })

  it('prints every run group as JSON when both json and --all are requested', () => {
    setupFullFixture()

    generateReport({ json: true, all: true })

    const printed = JSON.parse(logSpy.mock.calls[0][0])
    expect(printed).toHaveLength(2)
    expect(printed[0].batchId).toBe('b1')
    expect(printed[0].runs).toHaveLength(2)
    expect(printed[1].batchId).toBeNull()
    expect(printed[1].runs).toHaveLength(1)
  })

  it('treats a run as missing if its results.json disappears between listing and reading it', () => {
    let existsCallCount = 0
    fs.existsSync.mockImplementation((p) => {
      if (p === RESULTS_DIR) return true
      if (p.endsWith(path.join('run-vanish', 'results.json'))) {
        existsCallCount++
        return existsCallCount === 1
      }
      return false
    })
    fs.statSync.mockReturnValue({ isDirectory: () => true })
    fs.readdirSync.mockImplementation((dir) => (dir === RESULTS_DIR ? ['run-vanish'] : []))

    generateReport()

    expect(loggedText()).toContain('No test results found. Run a playback first.')
  })

  it('derives a batch grouping from batchId/bulkFolder fields even when a run is not physically nested in a ---BULK folder', () => {
    const runC = { status: 'passed', batchId: 'orphan-batch', duration: 200, timestamp: '2026-02-01T00:00:00.000Z', tests: [] }
    const runD = { status: 'passed', bulkFolder: 'legacy-bulk', duration: 200, timestamp: '2026-02-01T00:05:00.000Z', tests: [] }

    fs.existsSync.mockImplementation((p) => {
      if (p === RESULTS_DIR) return true
      if (p.endsWith(path.join('run-C', 'results.json'))) return true
      if (p.endsWith(path.join('run-D', 'results.json'))) return true
      return false
    })
    fs.statSync.mockReturnValue({ isDirectory: () => true })
    fs.readdirSync.mockImplementation((dir) => (dir === RESULTS_DIR ? ['run-C', 'run-D'] : []))
    fs.readFileSync.mockImplementation((p) => {
      if (p.includes('run-C')) return JSON.stringify(runC)
      if (p.includes('run-D')) return JSON.stringify(runD)
      throw new Error(`unexpected readFileSync path: ${p}`)
    })

    generateReport({ json: true, all: true })

    const groups = JSON.parse(logSpy.mock.calls[0][0])
    expect(groups).toHaveLength(2)
    const orphan = groups.find((g) => g.batchId === 'orphan-batch')
    expect(orphan.bulkFolder).toBeNull()
    const legacy = groups.find((g) => g.bulkFolder === 'legacy-bulk')
    expect(legacy.batchId).toBe('legacy-bulk')

    logSpy.mockClear()
    generateReport({ all: true })

    const text = loggedText()
    expect(text).toContain(path.join('playback-results', 'run-C'))
    expect(text).toContain(path.join('playback-results', 'legacy-bulk'))
  })

  it('sorts batch sessions defensively and falls back to a "?" label when sessionIndex is missing', () => {
    const sessionCommon = { status: 'passed', batchId: 'b2', duration: 100, timestamp: '2026-02-02T00:00:00.000Z', tests: [] }

    fs.existsSync.mockImplementation((p) => {
      if (p === RESULTS_DIR) return true
      if (p.includes('batch-2---BULK') && p.endsWith('results.json')) return true
      return false
    })
    fs.statSync.mockReturnValue({ isDirectory: () => true })
    fs.readdirSync.mockImplementation((dir) => {
      if (dir === RESULTS_DIR) return ['batch-2---BULK']
      if (dir.endsWith('batch-2---BULK')) return ['session-x', 'session-y', 'session-z']
      return []
    })
    fs.readFileSync.mockReturnValue(JSON.stringify(sessionCommon))

    generateReport({ all: true })

    const text = loggedText()
    expect(text).toContain('Session ?')
    expect(text).toContain('3 passed')
    expect(text).not.toContain('failed')
  })

  it('prints a run with no failures using the passed styling and omits the failure listing', () => {
    const passedRun = {
      status: 'passed',
      timestamp: '2026-02-03T00:00:00.000Z',
      duration: 100,
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
      timedOut: 0,
      tests: []
    }

    fs.existsSync.mockImplementation((p) => {
      if (p === RESULTS_DIR) return true
      if (p.endsWith(path.join('run-P', 'results.json'))) return true
      return false
    })
    fs.statSync.mockReturnValue({ isDirectory: () => true })
    fs.readdirSync.mockImplementation((dir) => (dir === RESULTS_DIR ? ['run-P'] : []))
    fs.readFileSync.mockReturnValue(JSON.stringify(passedRun))

    generateReport()

    const text = loggedText()
    expect(text).toContain('PASS')
    expect(text).toContain('2 passed')
    expect(text).not.toContain('✗')
    expect(text).not.toContain('⏱')
  })

  it('computes a mixed pass rate in the trend summary across groups', () => {
    const passedRun = { status: 'passed', timestamp: '2026-02-04T00:00:00.000Z', duration: 50, total: 1, passed: 1, failed: 0, skipped: 0, timedOut: 0, tests: [] }
    const failedRun = { status: 'failed', timestamp: '2026-02-05T00:00:00.000Z', duration: 50, total: 1, passed: 0, failed: 1, skipped: 0, timedOut: 0, tests: [] }

    fs.existsSync.mockImplementation((p) => {
      if (p === RESULTS_DIR) return true
      if (p.endsWith(path.join('run-P', 'results.json'))) return true
      if (p.endsWith(path.join('run-Q', 'results.json'))) return true
      return false
    })
    fs.statSync.mockReturnValue({ isDirectory: () => true })
    fs.readdirSync.mockImplementation((dir) => (dir === RESULTS_DIR ? ['run-P', 'run-Q'] : []))
    fs.readFileSync.mockImplementation((p) => {
      if (p.includes('run-P')) return JSON.stringify(passedRun)
      if (p.includes('run-Q')) return JSON.stringify(failedRun)
      throw new Error(`unexpected readFileSync path: ${p}`)
    })

    generateReport({ all: true })

    expect(loggedText()).toContain('1/2 passed (50%)')
  })
})

// report.js:79-80's `typeof entry === 'string' ? ... : entry.dirName/.bulkParent`
// ternaries are structurally dead on their string branch: `loadRun` is a private,
// unexported helper with exactly one call site (`getRunDirs().map(loadRun)`), and
// `getRunDirs()` always returns `{dirName, bulkParent}` objects, never bare strings.
// There is no path in this codebase that invokes `loadRun` with a string.
