jest.mock('fs')

const path = require('path')

const WORKSPACE = path.join('/ws')
const RESULTS_DIR = path.join('/ws', 'playback-results')

let vscode
let fs
let register
let clearInProgress

const flush = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  jest.resetModules()
  vscode = require('vscode')
  fs = require('fs')
  ;({ register, clearInProgress } = require('../commands/results-viewer'))

  vscode.workspace.workspaceFolders = [{ uri: { fsPath: WORKSPACE } }]
  fs.existsSync.mockReturnValue(false)
  fs.readdirSync.mockReturnValue([])
  fs.readFileSync.mockReturnValue('{}')
  fs.statSync.mockReturnValue({ isDirectory: () => true })
})

function getHandler() {
  register({})
  return vscode.commands.registerCommand.mock.calls.at(-1)[1]
}

function openPanel(arg) {
  const handler = getHandler()
  handler(arg)
  const panel = vscode.window.createWebviewPanel.mock.results.at(-1).value
  const watcher = vscode.workspace.createFileSystemWatcher.mock.results.at(-1).value
  const onMessage = panel.webview.onDidReceiveMessage.mock.calls.at(-1)[0]
  const onDispose = panel.onDidDispose.mock.calls.at(-1)[0]
  return { panel, watcher, onMessage, onDispose }
}

function makeRun(overrides = {}) {
  return {
    status: 'passed',
    timestamp: '2026-01-01T00:00:00.000Z',
    duration: 1000,
    passed: 1,
    failed: 0,
    total: 1,
    tests: [{ title: 'test 1', status: 'passed', duration: 500 }],
    ...overrides,
  }
}

// Wires fs.existsSync/statSync/readdirSync/readFileSync to a declarative
// snapshot of a playback-results directory, matching how loadAllRuns reads it.
function mockResultsDir({ single = [], bulk = [] } = {}) {
  const topEntries = [...single.map((s) => s.dirName), ...bulk.map((b) => b.dirName)]
  const files = new Map()
  const dirs = new Set([RESULTS_DIR])

  for (const { dirName, run } of single) {
    const full = path.join(RESULTS_DIR, dirName)
    dirs.add(full)
    if (run) files.set(path.join(full, 'results.json'), JSON.stringify(run))
  }
  for (const { dirName, sessions } of bulk) {
    const full = path.join(RESULTS_DIR, dirName)
    dirs.add(full)
    for (const { sub, run } of sessions) {
      const subFull = path.join(full, sub)
      dirs.add(subFull)
      if (run) files.set(path.join(subFull, 'results.json'), JSON.stringify(run))
    }
  }

  fs.existsSync.mockImplementation((p) => dirs.has(p) || files.has(p))
  fs.statSync.mockImplementation((p) => ({ isDirectory: () => dirs.has(p) }))
  fs.readdirSync.mockImplementation((p) => {
    if (p === RESULTS_DIR) return topEntries
    const bulkEntry = bulk.find((b) => path.join(RESULTS_DIR, b.dirName) === p)
    if (bulkEntry) return bulkEntry.sessions.map((s) => s.sub)
    return []
  })
  fs.readFileSync.mockImplementation((p) => files.get(p) ?? '{}')
}

describe('viewResults command — guard clause and setup', () => {
  it('shows an error and does nothing when no workspace folder is open', () => {
    vscode.workspace.workspaceFolders = undefined
    const handler = getHandler()

    handler()

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Please open a workspace folder first.')
    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })

  it('creates the results directory', () => {
    const handler = getHandler()

    handler()

    expect(fs.mkdirSync).toHaveBeenCalledWith(RESULTS_DIR, { recursive: true })
  })

  it('opens a fresh results panel when none exists', () => {
    const handler = getHandler()

    handler()

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'salesforceUiScriptRecorderResults',
      'Playback Results',
      vscode.ViewColumn.Active,
      expect.objectContaining({ enableScripts: true })
    )
  })

  it('reveals the existing panel instead of creating a new one on a second call', () => {
    const first = openPanel()
    const handler = getHandler()

    handler()

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)
    expect(first.panel.reveal).toHaveBeenCalledWith(vscode.ViewColumn.Active)
  })
})

describe('viewResults command — spec-name argument resolution', () => {
  it('sets the initial spec filter from a string arg when a matching run exists', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun() }] })
    const { panel } = openPanel('demo')

    expect(panel.webview.html).toContain('value="demo" selected')
  })

  it('ignores a string arg spec name that does not match any run', () => {
    const { panel } = openPanel('nonexistent')

    expect(panel.webview.html).toContain('value="" selected')
  })

  it('resolves the spec name from a Uri-like arg via fsPath', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun() }] })
    const { panel } = openPanel({ fsPath: path.join(WORKSPACE, 'test-plans', 'playwright', 'demo.spec.js') })

    expect(panel.webview.html).toContain('value="demo" selected')
  })

  it('resolves the spec name from a Uri-like arg via path when fsPath is absent', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun() }] })
    const { panel } = openPanel({ path: path.join(WORKSPACE, 'test-plans', 'playwright', 'demo.spec.js') })

    expect(panel.webview.html).toContain('value="demo" selected')
  })

  it('treats an arg with neither fsPath nor path as no spec filter', () => {
    const { panel } = openPanel({})

    expect(panel.webview.html).toContain('value="" selected')
  })

  it('reads specUri and inProgress from an options-object arg', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2025-01-01T00-00-00', run: makeRun({ timestamp: '2025-01-01T00:00:00.000Z' }) }] })
    const { panel } = openPanel({
      specUri: { fsPath: path.join(WORKSPACE, 'test-plans', 'playwright', 'demo.spec.js') },
      inProgress: { specName: 'demo', mode: 'single', startTime: '2026-01-01T00:00:00.000Z' },
    })

    expect(panel.webview.html).toContain('value="demo" selected')
    expect(panel.webview.html).toContain('In Progress')
  })
})

describe('viewResults command — reusing an already-open panel', () => {
  it('updates the spec filter on an already-open panel via setSpec', () => {
    mockResultsDir({
      single: [
        { dirName: 'demo---2026-01-01T00-00-00', run: makeRun() },
        { dirName: 'other---2026-01-01T00-00-00', run: makeRun() },
      ],
    })
    const { panel } = openPanel('demo')
    const handler = getHandler()

    handler('other')

    expect(panel.webview.html).toContain('value="other" selected')
  })

  it('leaves the spec filter unchanged when a later call does not match any run', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun() }] })
    const { panel } = openPanel('demo')
    const handler = getHandler()

    handler('nonexistent')

    expect(panel.webview.html).toContain('value="demo" selected')
  })

  it('adds an in-progress entry to an already-open panel without duplicating it', () => {
    const ip = { specName: 'demo', mode: 'single', startTime: '2026-01-01T00:00:00.000Z' }
    const { panel } = openPanel()
    const handler = getHandler()

    handler({ specUri: null, inProgress: ip })
    handler({ specUri: null, inProgress: ip })

    expect((panel.webview.html.match(/class="run-card in-progress-card"/g) || []).length).toBe(1)
  })
})

describe('loadAllRuns / groupRuns (via rendered panel)', () => {
  it('skips a results-dir entry that is not a directory', () => {
    fs.readdirSync.mockImplementation((p) => (p === RESULTS_DIR ? ['not-a-dir'] : []))
    fs.statSync.mockImplementation((p) => ({ isDirectory: () => p !== path.join(RESULTS_DIR, 'not-a-dir') }))
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('No playback results yet.')
  })

  it('skips a plain run directory with no results.json', () => {
    fs.readdirSync.mockImplementation((p) => (p === RESULTS_DIR ? ['demo---2026-01-01T00-00-00'] : []))
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('No playback results yet.')
  })

  it('loads a bulk folder, skipping non-directory and results-less sessions', () => {
    const bulkDir = 'demo---2026-01-01T00-00-00---BULK'
    fs.readdirSync.mockImplementation((p) => {
      if (p === RESULTS_DIR) return [bulkDir]
      if (p === path.join(RESULTS_DIR, bulkDir)) return ['session-1', 'not-a-dir', 'session-2']
      return []
    })
    fs.statSync.mockImplementation((p) => ({ isDirectory: () => p !== path.join(RESULTS_DIR, bulkDir, 'not-a-dir') }))
    fs.existsSync.mockImplementation((p) => p === path.join(RESULTS_DIR, bulkDir, 'session-1', 'results.json'))
    fs.readFileSync.mockImplementation((p) =>
      p === path.join(RESULTS_DIR, bulkDir, 'session-1', 'results.json')
        ? JSON.stringify(makeRun({ sessionIndex: 1 }))
        : '{}'
    )
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('Session 1')
    expect(panel.webview.html).not.toContain('Session 2')
  })

  it('sorts bulk sessions by sessionIndex regardless of directory read order', () => {
    const bulkDir = 'demo---2026-01-01T00-00-00---BULK'
    mockResultsDir({
      bulk: [
        {
          dirName: bulkDir,
          sessions: [
            { sub: 'session-2', run: makeRun({ sessionIndex: 2 }) },
            { sub: 'session-1', run: makeRun({ sessionIndex: 1 }) },
          ],
        },
      ],
    })
    const { panel } = openPanel()

    const idx1 = panel.webview.html.indexOf('Session 1')
    const idx2 = panel.webview.html.indexOf('Session 2')
    expect(idx1).toBeGreaterThan(-1)
    expect(idx1).toBeLessThan(idx2)
  })

  it('groups legacy flat bulk sessions by shared bulkFolder', () => {
    mockResultsDir({
      single: [
        { dirName: 'demo---batch-1---session-1', run: makeRun({ bulkFolder: 'legacy-batch', sessionIndex: 1 }) },
        { dirName: 'demo---batch-1---session-2', run: makeRun({ bulkFolder: 'legacy-batch', sessionIndex: 2 }) },
      ],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('Bulk')
    expect((panel.webview.html.match(/class="run-card"/g) || []).length).toBe(1)
  })

  it('groups legacy flat bulk sessions by shared batchId when no bulkFolder is present', () => {
    mockResultsDir({
      single: [
        { dirName: 'demo---batch-1---session-1', run: makeRun({ batchId: 'abc', sessionIndex: 1 }) },
        { dirName: 'demo---batch-1---session-2', run: makeRun({ batchId: 'abc', sessionIndex: 2 }) },
      ],
    })
    const { panel } = openPanel()

    expect((panel.webview.html.match(/class="run-card"/g) || []).length).toBe(1)
  })

  it('treats runs with no grouping key as independent single-run cards', () => {
    mockResultsDir({
      single: [
        { dirName: 'demo---2026-01-01T00-00-00', run: makeRun() },
        { dirName: 'demo---2026-01-02T00-00-00', run: makeRun() },
      ],
    })
    const { panel } = openPanel()

    expect((panel.webview.html.match(/class="run-card"/g) || []).length).toBe(2)
  })
})

describe('showResultsPanel — in-progress lifecycle', () => {
  it('keeps a bulk in-progress entry when its results folder does not exist yet', () => {
    const ip = { specName: 'demo', mode: 'bulk', bulkFolder: 'demo---ts---BULK', sessions: 2 }
    const { panel } = openPanel({ specUri: null, inProgress: ip })

    expect(panel.webview.html).toContain('In Progress')
  })

  it('keeps a bulk in-progress entry while fewer sessions have completed than requested', () => {
    const bulkDir = 'demo---ts---BULK'
    mockResultsDir({ bulk: [{ dirName: bulkDir, sessions: [{ sub: 'session-1', run: makeRun({ sessionIndex: 1 }) }] }] })
    const ip = { specName: 'demo', mode: 'bulk', bulkFolder: bulkDir, sessions: 2 }
    const { panel } = openPanel({ specUri: null, inProgress: ip })

    expect(panel.webview.html).toContain('In Progress')
  })

  it('removes a bulk in-progress entry once every session has completed', () => {
    const bulkDir = 'demo---ts---BULK'
    mockResultsDir({
      bulk: [
        {
          dirName: bulkDir,
          sessions: [
            { sub: 'session-1', run: makeRun({ sessionIndex: 1 }) },
            { sub: 'session-2', run: makeRun({ sessionIndex: 2 }) },
          ],
        },
      ],
    })
    const ip = { specName: 'demo', mode: 'bulk', bulkFolder: bulkDir, sessions: 2 }
    const { panel } = openPanel({ specUri: null, inProgress: ip })

    expect(panel.webview.html).not.toContain('In Progress')
  })

  it('keeps a single in-progress entry when no matching result has landed', () => {
    const ip = { specName: 'demo', mode: 'single', startTime: '2026-01-01T00:00:00.000Z' }
    const { panel } = openPanel({ specUri: null, inProgress: ip })

    expect(panel.webview.html).toContain('In Progress')
  })

  it('removes a single in-progress entry once a newer matching result lands', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-05', run: makeRun({ timestamp: '2026-01-01T00:00:05.000Z' }) }] })
    const ip = { specName: 'demo', mode: 'single', startTime: '2026-01-01T00:00:00.000Z' }
    const { panel } = openPanel({ specUri: null, inProgress: ip })

    expect(panel.webview.html).not.toContain('In Progress')
  })

  it('re-renders when the results watcher fires onDidCreate or onDidChange', () => {
    const { panel, watcher } = openPanel()
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun() }] })

    watcher.onDidCreate.mock.calls[0][0]()

    expect(panel.webview.html).toContain('class="run-card"')

    mockResultsDir({})
    watcher.onDidChange.mock.calls[0][0]()

    expect(panel.webview.html).toContain('No playback results yet.')
  })

  it('resets the active spec filter once its runs no longer exist', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun() }] })
    const { panel, onMessage, watcher } = openPanel()
    onMessage({ type: 'filterSpec', data: 'demo' })
    expect(panel.webview.html).toContain('value="demo" selected')

    mockResultsDir({})
    watcher.onDidChange.mock.calls[0][0]()

    expect(panel.webview.html).toContain('value="" selected')
  })

  it('disposes the watcher and clears the singleton panel state on dispose', () => {
    const { watcher, onDispose } = openPanel()

    onDispose()

    expect(watcher.dispose).toHaveBeenCalled()

    const handler = getHandler()
    handler()
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2)
  })
})

describe('showResultsPanel — webview messages', () => {
  it('filters runs by spec and clears the filter on an empty value', () => {
    mockResultsDir({
      single: [
        { dirName: 'demo---2026-01-01T00-00-00', run: makeRun() },
        { dirName: 'other---2026-01-01T00-00-00', run: makeRun() },
      ],
    })
    const { panel, onMessage } = openPanel()

    onMessage({ type: 'filterSpec', data: 'demo' })
    expect(panel.webview.html).toContain('value="demo" selected')

    onMessage({ type: 'filterSpec', data: '' })
    expect(panel.webview.html).toContain('value="" selected')
  })

  it('opens the result folder reveal command', () => {
    const { onMessage } = openPanel()

    onMessage({ type: 'openFolder', data: 'demo---2026-01-01T00-00-00' })

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'salesforce-ui-script-recorder.revealResultFolder',
      'demo---2026-01-01T00-00-00'
    )
  })

  it('opens a result file when it exists', async () => {
    const target = path.join(RESULTS_DIR, 'demo---2026-01-01T00-00-00', 'output.txt')
    fs.existsSync.mockImplementation((p) => p === target)
    const { onMessage } = openPanel()

    onMessage({ type: 'openFile', data: path.join('demo---2026-01-01T00-00-00', 'output.txt') })
    await flush()

    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(target)
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(expect.anything(), { preview: true })
  })

  it('warns when the requested result file does not exist', async () => {
    const { onMessage } = openPanel()

    onMessage({ type: 'openFile', data: 'missing.txt' })
    await flush()

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: File not found: missing.txt')
  })

  it('opens a screenshot image when it exists', () => {
    const target = path.join(RESULTS_DIR, 'demo---2026-01-01T00-00-00', 'shot.png')
    fs.existsSync.mockImplementation((p) => p === target)
    const { onMessage } = openPanel()

    onMessage({ type: 'openImage', data: path.join('demo---2026-01-01T00-00-00', 'shot.png') })

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.open', vscode.Uri.file(target), vscode.ViewColumn.Beside)
  })

  it('warns when the requested screenshot does not exist', () => {
    const { onMessage } = openPanel()

    onMessage({ type: 'openImage', data: 'missing.png' })

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Screenshot not found: missing.png')
  })

  it('triggers the HTML export on downloadHtml', async () => {
    vscode.window.showSaveDialog.mockResolvedValueOnce(undefined)
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    expect(vscode.window.showSaveDialog).toHaveBeenCalled()
  })

  it('ignores a webview message with an unrecognized type', async () => {
    const { onMessage } = openPanel()

    onMessage({ type: 'unknownMessageType' })
    await flush()

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
    expect(vscode.window.showSaveDialog).not.toHaveBeenCalled()
  })
})

describe('getResultsHtml — rendering branches', () => {
  it('renders a dedupded, sorted list of spec names in the filter dropdown', () => {
    mockResultsDir({
      single: [
        { dirName: 'zebra---2026-01-01T00-00-00', run: makeRun() },
        { dirName: 'apple---2026-01-01T00-00-00', run: makeRun() },
        { dirName: 'apple---2026-01-02T00-00-00', run: makeRun() },
      ],
    })
    const { panel } = openPanel()

    const appleIdx = panel.webview.html.indexOf('<option value="apple"')
    const zebraIdx = panel.webview.html.indexOf('<option value="zebra"')
    expect(appleIdx).toBeGreaterThan(-1)
    expect(appleIdx).toBeLessThan(zebraIdx)
    expect((panel.webview.html.match(/<option value="apple">apple<\/option>/g) || []).length).toBe(1)
  })

  it('pluralizes the bulk in-progress session count', () => {
    const ip = { specName: 'demo', mode: 'bulk', bulkFolder: 'demo---ts---BULK', sessions: 3 }
    const { panel } = openPanel({ specUri: null, inProgress: ip })

    expect(panel.webview.html).toContain('3 sessions')
  })

  it('does not pluralize a single-session bulk in-progress entry', () => {
    const ip = { specName: 'demo', mode: 'bulk', bulkFolder: 'demo---ts---BULK', sessions: 1 }
    const { panel } = openPanel({ specUri: null, inProgress: ip })

    expect(panel.webview.html).toContain('1 session')
    expect(panel.webview.html).not.toContain('1 sessions')
  })

  it('hides the in-progress section when nothing is in progress', () => {
    const { panel } = openPanel()

    expect(panel.webview.html).not.toContain('<div class="in-progress-section">')
  })

  it('auto-expands only the most recent run when nothing is in progress', () => {
    mockResultsDir({
      single: [
        { dirName: 'demo---2026-01-01T00-00-00', run: makeRun() },
        { dirName: 'demo---2026-01-02T00-00-00', run: makeRun() },
      ],
    })
    const { panel } = openPanel()

    expect((panel.webview.html.match(/run-details open/g) || []).length).toBe(1)
  })

  it('does not auto-expand any run when something is in progress', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun() }] })
    const ip = { specName: 'demo', mode: 'single', startTime: '2099-01-01T00:00:00.000Z' }
    const { panel } = openPanel({ specUri: null, inProgress: ip })

    expect(panel.webview.html).not.toContain('run-details open')
  })

  it('shows a trend bar with a pass percentage when there are 2+ runs', () => {
    mockResultsDir({
      single: [
        { dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ status: 'passed' }) },
        { dirName: 'demo---2026-01-02T00-00-00', run: makeRun({ status: 'failed' }) },
      ],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('trend-bar')
    expect(panel.webview.html).toContain('1/2 passed (50%)')
  })

  it('hides the trend bar when there is only one run', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun() }] })
    const { panel } = openPanel()

    expect(panel.webview.html).not.toContain('<div class="trend-bar">')
  })

  it('shows an empty state when there are no runs and nothing in progress', () => {
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('No playback results yet.')
  })

  it('hides the empty state when something is in progress even with no runs', () => {
    const ip = { specName: 'demo', mode: 'single', startTime: '2026-01-01T00:00:00.000Z' }
    const { panel } = openPanel({ specUri: null, inProgress: ip })

    expect(panel.webview.html).not.toContain('No playback results yet.')
  })
})

describe('renderBatchGroup / renderSingleRun', () => {
  it('marks a bulk session with no error/screenshot/stdout detail as non-expandable', () => {
    mockResultsDir({
      bulk: [{ dirName: 'demo---ts---BULK', sessions: [{ sub: 'session-1', run: makeRun({ sessionIndex: 1 }) }] }],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('session-row"')
    expect(panel.webview.html).not.toContain('session-row expandable')
  })

  it('marks a bulk session with error detail as expandable', () => {
    mockResultsDir({
      bulk: [
        {
          dirName: 'demo---ts---BULK',
          sessions: [
            {
              sub: 'session-1',
              run: makeRun({
                sessionIndex: 1,
                status: 'failed',
                tests: [{ title: 't1', status: 'failed', duration: 10, errors: [{ message: 'boom' }] }],
              }),
            },
          ],
        },
      ],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('session-row expandable')
  })

  it('shows the failed-session count only when at least one bulk session failed', () => {
    mockResultsDir({
      bulk: [
        {
          dirName: 'demo---ts---BULK',
          sessions: [
            { sub: 'session-1', run: makeRun({ sessionIndex: 1, status: 'passed' }) },
            { sub: 'session-2', run: makeRun({ sessionIndex: 2, status: 'failed' }) },
          ],
        },
      ],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('class="count-fail"')
  })

  it('omits the failed-session count when every bulk session passed', () => {
    mockResultsDir({
      bulk: [{ dirName: 'demo---ts---BULK', sessions: [{ sub: 'session-1', run: makeRun({ sessionIndex: 1 }) }] }],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).not.toContain('class="count-fail"')
  })

  it('shows the failed-test count only when the single run has failures', () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ failed: 1, passed: 0, status: 'failed' }) }],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('class="count-fail"')
  })

  it('renders a timeout icon class for a timed-out test', () => {
    mockResultsDir({
      single: [
        {
          dirName: 'demo---2026-01-01T00-00-00',
          run: makeRun({ status: 'failed', tests: [{ title: 't1', status: 'timedOut', duration: 10 }] }),
        },
      ],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('session-icon timeout')
  })

  it('renders a timeout icon class for a timed-out bulk session', () => {
    mockResultsDir({
      bulk: [{ dirName: 'demo---ts---BULK', sessions: [{ sub: 'session-1', run: makeRun({ sessionIndex: 1, status: 'timedOut' }) }] }],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('session-icon timeout')
  })

  it('falls back to "Session ?" for bulk sessions with no sessionIndex, on both the plain and expandable rows', () => {
    mockResultsDir({
      bulk: [
        {
          dirName: 'demo---ts---BULK',
          sessions: [
            { sub: 'session-1', run: makeRun({ status: 'passed' }) },
            {
              sub: 'session-2',
              run: makeRun({ status: 'failed', tests: [{ title: 't1', status: 'failed', duration: 10, errors: [{ message: 'boom' }] }] }),
            },
          ],
        },
      ],
    })
    const { panel } = openPanel()

    expect((panel.webview.html.match(/Session \?/g) || []).length).toBe(2)
  })

  it('renders an empty session label for a test with an empty title', () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ tests: [{ title: '', status: 'passed', duration: 10 }] }) }],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('<span class="session-label"></span>')
  })
})

describe('screenshots and error rendering', () => {
  function runWithAttachments(attachments) {
    return makeRun({
      status: 'failed',
      tests: [{ title: 't1', status: 'failed', duration: 10, attachments }],
    })
  }

  it('renders nothing when a test has no attachments', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: runWithAttachments([]) }] })
    const { panel } = openPanel()

    expect(panel.webview.html).not.toContain('class="shots"')
  })

  it('filters out non-image attachments', () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: runWithAttachments([{ path: 'trace.zip', contentType: 'application/zip' }]) }],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).not.toContain('class="shots"')
  })

  it('renders an image attachment identified by extension when contentType is absent', () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: runWithAttachments([{ path: 'shot.png' }]) }],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('class="shots"')
    expect(panel.webview.html).toContain('shot.png')
  })

  it('skips an image attachment with an absolute path', () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: runWithAttachments([{ path: '/etc/shot.png', contentType: 'image/png' }]) }],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).not.toContain('class="shots"')
  })

  it('skips an image attachment whose path attempts directory traversal', () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: runWithAttachments([{ path: '../shot.png', contentType: 'image/png' }]) }],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).not.toContain('class="shots"')
  })

  it('renders nothing for renderRunScreenshots when a bulk session run has an empty tests array', () => {
    mockResultsDir({
      bulk: [{ dirName: 'demo---ts---BULK', sessions: [{ sub: 'session-1', run: { status: 'passed', sessionIndex: 1, duration: 10, tests: [] } }] }],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).not.toContain('class="shots"')
  })

  it('skips an attachment with no path when filtering images', () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: runWithAttachments([{ contentType: 'image/png' }]) }],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).not.toContain('class="shots"')
  })

  it('renders an error message and hides the stack toggle when there is no snippet or stack', () => {
    mockResultsDir({
      single: [
        { dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ status: 'failed', tests: [{ title: 't1', status: 'failed', duration: 10, errors: [{ message: 'boom' }] }] }) },
      ],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('boom')
    expect(panel.webview.html).not.toContain('class="toggle-stack"')
  })

  it('shows the stack toggle and both stack and snippet when both are present', () => {
    mockResultsDir({
      single: [
        {
          dirName: 'demo---2026-01-01T00-00-00',
          run: makeRun({
            status: 'failed',
            tests: [{ title: 't1', status: 'failed', duration: 10, errors: [{ message: 'boom', stack: 'at foo.js:1', snippet: '> 1 | expect(x)' }] }],
          }),
        },
      ],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('class="toggle-stack"')
    expect(panel.webview.html).toContain('at foo.js:1')
    expect(panel.webview.html).toContain('expect(x)')
  })

  it('renders only the stack pre when a snippet is absent', () => {
    mockResultsDir({
      single: [
        {
          dirName: 'demo---2026-01-01T00-00-00',
          run: makeRun({
            status: 'failed',
            tests: [{ title: 't1', status: 'failed', duration: 10, errors: [{ message: 'boom', stack: 'at foo.js:1' }] }],
          }),
        },
      ],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('class="error-stack ansi"')
    expect(panel.webview.html).not.toContain('class="code-frame ansi"')
  })

  it('renders only the snippet pre when a stack is absent', () => {
    mockResultsDir({
      single: [
        {
          dirName: 'demo---2026-01-01T00-00-00',
          run: makeRun({
            status: 'failed',
            tests: [{ title: 't1', status: 'failed', duration: 10, errors: [{ message: 'boom', snippet: '> 1 | expect(x)' }] }],
          }),
        },
      ],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('class="code-frame ansi"')
    expect(panel.webview.html).not.toContain('class="error-stack ansi"')
  })

  it('defaults the error message to "Unknown error" when none is given', () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ status: 'failed', tests: [{ title: 't1', status: 'failed', duration: 10, errors: [{}] }] }) }],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('Unknown error')
  })

  it('renders stdout and stderr for a bulk session', () => {
    mockResultsDir({
      bulk: [
        {
          dirName: 'demo---ts---BULK',
          sessions: [{ sub: 'session-1', run: makeRun({ sessionIndex: 1, tests: [{ title: 't1', status: 'passed', duration: 10, stdout: 'out\n', stderr: 'err\n' }] }) }],
        },
      ],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('class="stdout-block"')
    expect(panel.webview.html).toContain('out')
    expect(panel.webview.html).toContain('err')
  })

  it('renders no stdout block for a single run whose test has no output', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun() }] })
    const { panel } = openPanel()

    expect(panel.webview.html).not.toContain('class="stdout-block"')
  })

  it('renders a stdout block for a single run whose test has output', () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ tests: [{ title: 't1', status: 'passed', duration: 10, stdout: 'solo-out\n' }] }) }],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('class="stdout-block"')
    expect(panel.webview.html).toContain('solo-out')
  })

  it('aggregates stdout-only and stderr-only tests independently in a bulk session', () => {
    mockResultsDir({
      bulk: [
        {
          dirName: 'demo---ts---BULK',
          sessions: [
            {
              sub: 'session-1',
              run: makeRun({
                sessionIndex: 1,
                tests: [
                  { title: 't1', status: 'passed', duration: 10, stdout: 'only-out\n' },
                  { title: 't2', status: 'passed', duration: 10, stderr: 'only-err\n' },
                ],
              }),
            },
          ],
        },
      ],
    })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('only-out')
    expect(panel.webview.html).toContain('only-err')
  })
})

describe('ansiToHtml (via error message/stack/snippet rendering)', () => {
  function panelWithMessage(message) {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ status: 'failed', tests: [{ title: 't1', status: 'failed', duration: 10, errors: [{ message }] }] }) }],
    })
    return openPanel().panel
  }

  it('wraps a red SGR color code in a themed span', () => {
    const panel = panelWithMessage('\x1b[31mRed text\x1b[0m')

    expect(panel.webview.html).toContain('--vscode-terminal-ansiRed')
    expect(panel.webview.html).toContain('Red text')
    expect(panel.webview.html).toContain('</span>')
  })

  it('applies bold and dim styling', () => {
    const panel = panelWithMessage('\x1b[1mBold\x1b[22m \x1b[2mDim\x1b[22m')

    expect(panel.webview.html).toContain('font-weight:600')
    expect(panel.webview.html).toContain('opacity:0.7')
  })

  it('combines bold and color in one escape sequence', () => {
    const panel = panelWithMessage('\x1b[1;31mBoldRed\x1b[0m')

    expect(panel.webview.html).toContain('font-weight:600')
    expect(panel.webview.html).toContain('--vscode-terminal-ansiRed')
  })

  it('resets only the color on code 39, preserving bold', () => {
    const panel = panelWithMessage('\x1b[1;31mA\x1b[39mB\x1b[0m')

    // After the 39 reset, a new span should carry bold but not the red color class.
    expect(panel.webview.html).toContain('font-weight:600');
  })

  it('ignores unrecognized SGR codes without opening a span', () => {
    const panel = panelWithMessage('\x1b[99mPlain\x1b[0m')

    expect(panel.webview.html).toContain('Plain')
    expect(panel.webview.html).not.toContain('<span style=')
  })

  it('escapes HTML-significant characters in the message text', () => {
    const panel = panelWithMessage('<b>&"</b>')

    expect(panel.webview.html).toContain('&lt;b&gt;&amp;&quot;&lt;/b&gt;')
  })

  it('treats a bare SGR reset with no digits as code 0', () => {
    const panel = panelWithMessage('\x1b[1mBold\x1b[mPlain')

    expect(panel.webview.html).toContain('font-weight:600')
    expect(panel.webview.html).toContain('Bold')
    expect(panel.webview.html).toContain('Plain')
  })
})

describe('formatDuration / formatDate (via rendered run-meta)', () => {
  it('renders 0ms for a falsy duration', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ duration: 0 }) }] })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('0ms')
  })

  it('renders sub-second durations in milliseconds', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ duration: 250 }) }] })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('250ms')
  })

  it('renders sub-minute durations in seconds', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ duration: 1500 }) }] })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('1.5s')
  })

  it('renders minute-plus durations as "Xm Ys"', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ duration: 65000 }) }] })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('1m 5s')
  })

  it('renders an empty date for a run with no timestamp', () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ timestamp: undefined }) }] })
    const { panel } = openPanel()

    expect(panel.webview.html).toContain('<span class="run-meta"> &middot;')
  })
})

describe('exportResultsHtml', () => {
  it('does nothing when the save dialog is dismissed', async () => {
    vscode.window.showSaveDialog.mockResolvedValueOnce(undefined)
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it('writes the exported HTML report and confirms with the saved filename', async () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun() }] })
    vscode.window.showSaveDialog.mockResolvedValueOnce({ fsPath: '/tmp/demo-results.html' })
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    expect(fs.writeFileSync).toHaveBeenCalledWith('/tmp/demo-results.html', expect.stringContaining('<!DOCTYPE html>'), 'utf-8')
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Report saved to demo-results.html')
  })

  it('defaults the save filename to the active spec name', async () => {
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun() }] })
    vscode.window.showSaveDialog.mockResolvedValueOnce(undefined)
    const { onMessage } = openPanel()

    onMessage({ type: 'filterSpec', data: 'demo' })
    onMessage({ type: 'downloadHtml' })
    await flush()

    expect(vscode.window.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultUri: vscode.Uri.file(path.join(WORKSPACE, 'demo-results.html')) })
    )
  })

  it('defaults the save filename to a generic name with no active spec filter', async () => {
    vscode.window.showSaveDialog.mockResolvedValueOnce(undefined)
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    expect(vscode.window.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultUri: vscode.Uri.file(path.join(WORKSPACE, 'playback-results.html')) })
    )
  })

  it('renders a bulk group and a single run in the exported report', async () => {
    mockResultsDir({
      single: [{ dirName: 'single---2026-01-01T00-00-00', run: makeRun() }],
      bulk: [{ dirName: 'demo---ts---BULK', sessions: [{ sub: 'session-1', run: makeRun({ sessionIndex: 1 }) }] }],
    })
    vscode.window.showSaveDialog.mockResolvedValueOnce({ fsPath: '/tmp/out.html' })
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    const html = fs.writeFileSync.mock.calls[0][1]
    expect(html).toContain('Bulk')
    expect(html).toContain('Single')
    expect(html).toContain('Session 1')
  })

  it('renders a placeholder when there are no runs to export', async () => {
    vscode.window.showSaveDialog.mockResolvedValueOnce({ fsPath: '/tmp/out.html' })
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    const html = fs.writeFileSync.mock.calls[0][1]
    expect(html).toContain('No playback results.')
  })

  it('strips ANSI codes from exported error messages instead of colorizing them', async () => {
    mockResultsDir({
      single: [
        {
          dirName: 'demo---2026-01-01T00-00-00',
          run: makeRun({ status: 'failed', tests: [{ title: 't1', status: 'failed', duration: 10, errors: [{ message: '\x1b[31mRed\x1b[0m', stack: '\x1b[2mdim stack\x1b[0m', snippet: '\x1b[2mdim snippet\x1b[0m' }] }] }),
        },
      ],
    })
    vscode.window.showSaveDialog.mockResolvedValueOnce({ fsPath: '/tmp/out.html' })
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    const html = fs.writeFileSync.mock.calls[0][1]
    expect(html).toContain('Red')
    expect(html).toContain('dim stack')
    expect(html).toContain('dim snippet')
    expect(html).not.toContain('\x1b')
    expect(html).not.toContain('<span style=')
  })

  it('embeds a base64 screenshot for an existing image attachment', async () => {
    const attPath = path.join('demo---2026-01-01T00-00-00', 'shot.png')
    const fullPath = path.join(RESULTS_DIR, 'demo---2026-01-01T00-00-00', 'shot.png')
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ status: 'failed', tests: [{ title: 't1', status: 'failed', duration: 10, attachments: [{ path: 'shot.png', contentType: 'image/png' }] }] }) }],
    })
    const existing = fs.existsSync.getMockImplementation()
    fs.existsSync.mockImplementation((p) => p === fullPath || existing(p))
    fs.readFileSync.mockImplementation((p) => {
      if (p === fullPath) return Buffer.from('fake-image-bytes')
      if (p === path.join(RESULTS_DIR, 'demo---2026-01-01T00-00-00', 'results.json')) {
        return JSON.stringify(makeRun({ status: 'failed', tests: [{ title: 't1', status: 'failed', duration: 10, attachments: [{ path: 'shot.png', contentType: 'image/png' }] }] }))
      }
      return '{}'
    })
    vscode.window.showSaveDialog.mockResolvedValueOnce({ fsPath: '/tmp/out.html' })
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    const html = fs.writeFileSync.mock.calls[0][1]
    expect(html).toContain('data:image/png;base64,')
  })

  it('skips a screenshot attachment whose file no longer exists on disk', async () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ status: 'failed', tests: [{ title: 't1', status: 'failed', duration: 10, attachments: [{ path: 'shot.png', contentType: 'image/png' }] }] }) }],
    })
    vscode.window.showSaveDialog.mockResolvedValueOnce({ fsPath: '/tmp/out.html' })
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    const html = fs.writeFileSync.mock.calls[0][1]
    expect(html).not.toContain('data:image/png;base64,')
  })

  it('renders failed and timed-out sessions with distinct icons and a session-label fallback in an exported bulk report', async () => {
    mockResultsDir({
      bulk: [
        {
          dirName: 'demo---ts---BULK',
          sessions: [
            { sub: 'session-1', run: makeRun({ status: 'timedOut' }) },
            { sub: 'session-2', run: makeRun({ status: 'failed', sessionIndex: 2 }) },
          ],
        },
      ],
    })
    vscode.window.showSaveDialog.mockResolvedValueOnce({ fsPath: '/tmp/out.html' })
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    const html = fs.writeFileSync.mock.calls[0][1]
    expect(html).toContain('status-icon fail')
    expect(html).toContain('session-icon timeout')
    expect(html).toContain('session-icon fail')
    expect(html).toContain('Session ?')
    expect(html).toContain('Session 2')
  })

  it('renders a timeout status icon for a timed-out single run in the exported report', async () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ status: 'timedOut' }) }],
    })
    vscode.window.showSaveDialog.mockResolvedValueOnce({ fsPath: '/tmp/out.html' })
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    const html = fs.writeFileSync.mock.calls[0][1]
    expect(html).toContain('status-icon timeout')
  })

  it('defaults the exported error message to "Unknown error" and omits stack/snippet blocks when neither is given', async () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ status: 'failed', tests: [{ title: 't1', status: 'failed', duration: 10, errors: [{}] }] }) }],
    })
    vscode.window.showSaveDialog.mockResolvedValueOnce({ fsPath: '/tmp/out.html' })
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    const html = fs.writeFileSync.mock.calls[0][1]
    expect(html).toContain('Unknown error')
    expect(html).not.toContain('class="error-stack"')
    expect(html).not.toContain('class="code-frame"')
  })

  it('skips an export attachment with no path', async () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ status: 'failed', tests: [{ title: 't1', status: 'failed', duration: 10, attachments: [{ contentType: 'image/png' }] }] }) }],
    })
    vscode.window.showSaveDialog.mockResolvedValueOnce({ fsPath: '/tmp/out.html' })
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    const html = fs.writeFileSync.mock.calls[0][1]
    expect(html).not.toContain('class="shots"')
  })

  it('filters out a non-image export attachment', async () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ status: 'failed', tests: [{ title: 't1', status: 'failed', duration: 10, attachments: [{ path: 'trace.zip', contentType: 'application/zip' }] }] }) }],
    })
    vscode.window.showSaveDialog.mockResolvedValueOnce({ fsPath: '/tmp/out.html' })
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    const html = fs.writeFileSync.mock.calls[0][1]
    expect(html).not.toContain('class="shots"')
  })

  it('renders an export screenshot identified by extension when contentType is absent', async () => {
    const fullPath = path.join(RESULTS_DIR, 'demo---2026-01-01T00-00-00', 'shot.png')
    const run = makeRun({ status: 'failed', tests: [{ title: 't1', status: 'failed', duration: 10, attachments: [{ path: 'shot.png' }] }] })
    mockResultsDir({ single: [{ dirName: 'demo---2026-01-01T00-00-00', run }] })
    const existing = fs.existsSync.getMockImplementation()
    fs.existsSync.mockImplementation((p) => p === fullPath || existing(p))
    fs.readFileSync.mockImplementation((p) => {
      if (p === fullPath) return Buffer.from('fake-image-bytes')
      if (p === path.join(RESULTS_DIR, 'demo---2026-01-01T00-00-00', 'results.json')) return JSON.stringify(run)
      return '{}'
    })
    vscode.window.showSaveDialog.mockResolvedValueOnce({ fsPath: '/tmp/out.html' })
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    const html = fs.writeFileSync.mock.calls[0][1]
    expect(html).toContain('data:image/png;base64,')
  })

  it('skips an export screenshot with an absolute path', async () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ status: 'failed', tests: [{ title: 't1', status: 'failed', duration: 10, attachments: [{ path: '/etc/shot.png', contentType: 'image/png' }] }] }) }],
    })
    vscode.window.showSaveDialog.mockResolvedValueOnce({ fsPath: '/tmp/out.html' })
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    const html = fs.writeFileSync.mock.calls[0][1]
    expect(html).not.toContain('data:image/png;base64,')
  })

  it('skips an export screenshot with a directory-traversal path', async () => {
    mockResultsDir({
      single: [{ dirName: 'demo---2026-01-01T00-00-00', run: makeRun({ status: 'failed', tests: [{ title: 't1', status: 'failed', duration: 10, attachments: [{ path: '../shot.png', contentType: 'image/png' }] }] }) }],
    })
    vscode.window.showSaveDialog.mockResolvedValueOnce({ fsPath: '/tmp/out.html' })
    const { onMessage } = openPanel()

    onMessage({ type: 'downloadHtml' })
    await flush()

    const html = fs.writeFileSync.mock.calls[0][1]
    expect(html).not.toContain('data:image/png;base64,')
  })
})

describe('clearInProgress', () => {
  it('clears in-progress entries and re-renders the open panel', () => {
    const ip = { specName: 'demo', mode: 'single', startTime: '2026-01-01T00:00:00.000Z' }
    const { panel } = openPanel({ specUri: null, inProgress: ip })
    expect(panel.webview.html).toContain('In Progress')

    clearInProgress()

    expect(panel.webview.html).not.toContain('In Progress')
  })

  it('does nothing when no panel is open', () => {
    expect(() => clearInProgress()).not.toThrow()
  })
})
