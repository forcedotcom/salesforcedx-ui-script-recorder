jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  unlinkSync: jest.fn()
}))
jest.mock('child_process', () => ({ spawn: jest.fn() }))
jest.mock('../ensure-playwright-config', () => ({ ensurePlaywrightConfig: jest.fn(() => ({ created: false })) }))
jest.mock('../resolve-node', () => ({ resolveNodePath: jest.fn(() => '/mock/node') }))

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { ensurePlaywrightConfig } = require('../ensure-playwright-config')
const { register } = require('../trigger-watcher')

const TRIGGER_DIR = path.join('/ws', '.salesforce-ui-script-recorder')
const TRIGGER_PATH = path.join(TRIGGER_DIR, 'trigger.json')
const RESULT_PATH = path.join(TRIGGER_DIR, 'result.json')
const RECORDINGS_DIR = path.join('/ws', 'test-plans', 'playwright')

afterEach(() => {
  jest.clearAllMocks()
  vscode.workspace.workspaceFolders = undefined
  vscode.window.terminals = []
  vscode.window.withProgress.mockImplementation((options, task) => {
    const progress = { report: jest.fn() }
    const token = { isCancellationRequested: false, onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })) }
    return task(progress, token)
  })
})

function setWorkspace() {
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
}

function mockReadFile(map) {
  fs.readFileSync.mockImplementation((p) => {
    if (Object.prototype.hasOwnProperty.call(map, p)) return map[p]
    throw new Error(`unexpected readFileSync(${p})`)
  })
}

function setupHandleTrigger(existingPaths = [], extensionPath = '/ext') {
  setWorkspace()
  const existing = new Set([TRIGGER_DIR, TRIGGER_PATH, ...existingPaths])
  fs.existsSync.mockImplementation((p) => existing.has(p))
  const outputChannel = vscode.__factories.makeOutputChannel()
  const context = { subscriptions: [], extensionPath }
  register(context, outputChannel)
  const watcher = vscode.workspace.createFileSystemWatcher.mock.results.at(-1).value
  const handleTrigger = watcher.onDidCreate.mock.calls[0][0]
  return { handleTrigger, outputChannel, context, existing }
}

function expectResult(expected) {
  const calls = fs.writeFileSync.mock.calls.filter(([p]) => p === RESULT_PATH)
  expect(calls.length).toBeGreaterThan(0)
  expect(JSON.parse(calls.at(-1)[1])).toEqual(expected)
}

function makeFakeProc() {
  const listeners = {}
  return {
    stdout: { on: jest.fn((event, cb) => { listeners[`stdout:${event}`] = cb }) },
    stderr: { on: jest.fn((event, cb) => { listeners[`stderr:${event}`] = cb }) },
    on: jest.fn((event, cb) => { listeners[event] = cb }),
    kill: jest.fn(),
    emit(event, ...args) { listeners[event](...args) },
    emitStdout(data) { listeners['stdout:data'](data) },
    emitStderr(data) { listeners['stderr:data'](data) }
  }
}

describe('register', () => {
  it('does nothing when there is no workspace folder', () => {
    vscode.workspace.workspaceFolders = undefined
    register({ subscriptions: [] }, vscode.__factories.makeOutputChannel())

    expect(vscode.workspace.createFileSystemWatcher).not.toHaveBeenCalled()
  })

  it('creates the trigger directory when it does not exist', () => {
    setWorkspace()
    fs.existsSync.mockReturnValue(false)

    register({ subscriptions: [] }, vscode.__factories.makeOutputChannel())

    expect(fs.mkdirSync).toHaveBeenCalledWith(TRIGGER_DIR, { recursive: true })
  })

  it('does not create the trigger directory when it already exists', () => {
    setWorkspace()
    fs.existsSync.mockReturnValue(true)

    register({ subscriptions: [] }, vscode.__factories.makeOutputChannel())

    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })

  it('subscribes the watcher and registers both onDidCreate and onDidChange handlers', () => {
    setWorkspace()
    fs.existsSync.mockReturnValue(true)
    const context = { subscriptions: [] }

    register(context, vscode.__factories.makeOutputChannel())

    const watcher = vscode.workspace.createFileSystemWatcher.mock.results.at(-1).value
    expect(watcher.onDidCreate).toHaveBeenCalled()
    expect(watcher.onDidChange).toHaveBeenCalled()
    expect(context.subscriptions).toContain(watcher)
  })
})

describe('handleTrigger dispatch', () => {
  it('does nothing when the trigger file does not exist', async () => {
    const { handleTrigger } = setupHandleTrigger()
    fs.existsSync.mockImplementation((p) => p === TRIGGER_DIR)

    await handleTrigger()

    expect(fs.readFileSync).not.toHaveBeenCalled()
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it('does nothing when the trigger file is empty after trimming', async () => {
    const { handleTrigger } = setupHandleTrigger()
    fs.readFileSync.mockReturnValue('   ')

    await handleTrigger()

    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it('writes a parse-failure result and cleans up the trigger file on invalid JSON', async () => {
    const { handleTrigger } = setupHandleTrigger()
    fs.readFileSync.mockReturnValue('{ not json')

    await handleTrigger()

    const calls = fs.writeFileSync.mock.calls.filter(([p]) => p === RESULT_PATH)
    expect(JSON.parse(calls.at(-1)[1]).error).toContain('Failed to parse trigger')
    expect(fs.unlinkSync).toHaveBeenCalledWith(TRIGGER_PATH)
  })

  it('swallows an error thrown while deleting the trigger file', async () => {
    const { handleTrigger } = setupHandleTrigger()
    fs.readFileSync.mockReturnValue(JSON.stringify({ command: 'list_recordings' }))
    fs.unlinkSync.mockImplementationOnce(() => { throw new Error('EBUSY') })

    await expect(handleTrigger()).resolves.toBeUndefined()
  })

  it('writes an unknown-command result for an unrecognized command', async () => {
    const { handleTrigger, outputChannel } = setupHandleTrigger()
    fs.readFileSync.mockReturnValue(JSON.stringify({ command: 'bogus' }))

    await handleTrigger()

    expect(outputChannel.appendLine).toHaveBeenCalledWith('[MCP Trigger] Received command: bogus')
    expectResult({ ok: false, error: 'Unknown command: bogus' })
  })

  it('catches a synchronous error thrown by a handler and writes an error result', async () => {
    const { handleTrigger } = setupHandleTrigger([RECORDINGS_DIR])
    fs.readFileSync.mockReturnValue(JSON.stringify({ command: 'list_recordings' }))
    fs.readdirSync.mockImplementation(() => { throw new Error('boom') })

    await handleTrigger()

    expectResult({ ok: false, error: 'boom' })
  })

  it('does not attempt to delete the trigger file in cleanup if it is already gone by then', async () => {
    setWorkspace()
    let triggerPathCalls = 0
    fs.existsSync.mockImplementation((p) => {
      if (p === TRIGGER_DIR) return true
      if (p === TRIGGER_PATH) {
        triggerPathCalls++
        return triggerPathCalls === 1
      }
      return false
    })
    const outputChannel = vscode.__factories.makeOutputChannel()
    const context = { subscriptions: [], extensionPath: '/ext' }
    register(context, outputChannel)
    const watcher = vscode.workspace.createFileSystemWatcher.mock.results.at(-1).value
    const handleTrigger = watcher.onDidCreate.mock.calls[0][0]
    fs.readFileSync.mockReturnValue(JSON.stringify({ command: 'list_recordings' }))

    await handleTrigger()

    expect(fs.unlinkSync).not.toHaveBeenCalled()
  })

  it('creates the result directory in writeResult when it does not exist', async () => {
    setWorkspace()
    fs.existsSync.mockImplementation((p) => p === TRIGGER_PATH)
    const outputChannel = vscode.__factories.makeOutputChannel()
    const context = { subscriptions: [], extensionPath: '/ext' }
    register(context, outputChannel)
    const watcher = vscode.workspace.createFileSystemWatcher.mock.results.at(-1).value
    const handleTrigger = watcher.onDidCreate.mock.calls[0][0]
    fs.readFileSync.mockReturnValue(JSON.stringify({ command: 'list_recordings' }))

    await handleTrigger()

    expect(fs.mkdirSync).toHaveBeenCalledWith(TRIGGER_DIR, { recursive: true })
  })
})

describe('handleListRecordings (via command list_recordings)', () => {
  it('returns an empty list when the recordings directory does not exist', async () => {
    const { handleTrigger } = setupHandleTrigger()
    fs.readFileSync.mockReturnValue(JSON.stringify({ command: 'list_recordings' }))

    await handleTrigger()

    expectResult({ ok: true, recordings: [], count: 0 })
  })

  it('lists recordings sorted, detecting spec files and skipping dotfiles/non-json entries', async () => {
    const { handleTrigger } = setupHandleTrigger([RECORDINGS_DIR])
    fs.readFileSync.mockReturnValue(JSON.stringify({ command: 'list_recordings' }))
    fs.readdirSync.mockReturnValue(['.hidden.json', 'b.json', 'b.spec.js', 'a.json', 'notes.txt'])
    fs.statSync.mockReturnValue({ size: 123, mtime: new Date('2026-01-01T00:00:00.000Z') })

    await handleTrigger()

    const calls = fs.writeFileSync.mock.calls.filter(([p]) => p === RESULT_PATH)
    const data = JSON.parse(calls.at(-1)[1])
    expect(data.count).toBe(2)
    expect(data.recordings.map((r) => r.name)).toEqual(['a', 'b'])
    expect(data.recordings.find((r) => r.name === 'a').specFile).toBeNull()
    expect(data.recordings.find((r) => r.name === 'b').specFile).toBe(path.join('test-plans', 'playwright', 'b.spec.js'))
  })
})

describe('handlePlayback (via command playback)', () => {
  const SPEC_FILE = path.join('/ws', 'demo.spec.js')

  function runPlayback(args, existing = []) {
    const { handleTrigger, outputChannel } = setupHandleTrigger(existing)
    mockReadFile({ [TRIGGER_PATH]: JSON.stringify({ command: 'playback', args }) })
    return handleTrigger().then(() => ({ outputChannel }))
  }

  it('writes an error when the spec file does not exist', async () => {
    await runPlayback({ specFile: 'demo.spec.js' })

    expectResult({ ok: false, error: `Spec file not found: ${SPEC_FILE}` })
  })

  it('writes an error when the file is not a .spec.js file', async () => {
    const txtFile = path.join('/ws', 'demo.txt')
    await runPlayback({ specFile: 'demo.txt' }, [txtFile])

    expectResult({ ok: false, error: `File must be a .spec.js file: ${txtFile}` })
  })

  it('does not re-resolve an already-absolute specFile path', async () => {
    await runPlayback({ specFile: SPEC_FILE }, [SPEC_FILE])

    expectResult({
      ok: true,
      message: 'Playback started in terminal for: demo.spec.js',
      specFile: SPEC_FILE
    })
  })

  it('reuses an existing matching terminal and defaults headed to true', async () => {
    const existingTerminal = { name: 'Salesforce UI Script Recorder: Playback', show: jest.fn(), sendText: jest.fn() }
    vscode.window.terminals = [existingTerminal]

    await runPlayback({ specFile: 'demo.spec.js' }, [SPEC_FILE])

    expect(vscode.window.createTerminal).not.toHaveBeenCalled()
    expect(existingTerminal.show).toHaveBeenCalled()
    expect(existingTerminal.sendText).toHaveBeenCalledWith(`npx playwright test "${SPEC_FILE}" --headed`)
  })

  it('creates a new terminal and omits --headed when args.headed is false', async () => {
    await runPlayback({ specFile: 'demo.spec.js', headed: false }, [SPEC_FILE])

    expect(vscode.window.createTerminal).toHaveBeenCalledWith({
      name: 'Salesforce UI Script Recorder: Playback',
      cwd: '/ws'
    })
    const terminal = vscode.window.createTerminal.mock.results[0].value
    expect(terminal.sendText).toHaveBeenCalledWith(`npx playwright test "${SPEC_FILE}"`)
  })
})

describe('handleRecord (via command record)', () => {
  const OUTPUT_PATH = path.join(RECORDINGS_DIR, 'my.json')
  const SPEC_FROM_OUTPUT = OUTPUT_PATH.replace(/\.json$/, '.spec.js')

  function runRecord(args, existing = []) {
    const { handleTrigger, outputChannel, context } = setupHandleTrigger(existing)
    mockReadFile({ [TRIGGER_PATH]: JSON.stringify({ command: 'record', args }) })
    const proc = makeFakeProc()
    spawn.mockReturnValue(proc)
    const resultPromise = handleTrigger()
    return { resultPromise, proc, outputChannel, context }
  }

  it('creates the recordings directory when it does not exist', () => {
    runRecord({ output: OUTPUT_PATH })

    expect(fs.mkdirSync).toHaveBeenCalledWith(RECORDINGS_DIR, { recursive: true })
  })

  it('does not create the recordings directory when it already exists', () => {
    runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR])

    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })

  it('logs when ensurePlaywrightConfig creates a new config file', () => {
    ensurePlaywrightConfig.mockReturnValueOnce({ created: true })
    const { outputChannel } = runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR])

    expect(outputChannel.appendLine).toHaveBeenCalledWith('[MCP] Created playwright.config.js in workspace')
  })

  it('does not log a config-created message when ensurePlaywrightConfig does not create one', () => {
    const { outputChannel } = runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR])

    expect(outputChannel.appendLine).not.toHaveBeenCalledWith('[MCP] Created playwright.config.js in workspace')
  })

  it('derives a timestamped output path when args.output is omitted', () => {
    const { proc } = runRecord({}, [RECORDINGS_DIR])

    const cliArgs = spawn.mock.calls[0][1]
    const outputPath = cliArgs[cliArgs.indexOf('--output') + 1]
    expect(path.dirname(outputPath)).toBe(RECORDINGS_DIR)
    expect(path.basename(outputPath)).toMatch(/^recording_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/)
  })

  it('defaults url to about:blank and authStatesDir to <workspace>/auth-states', () => {
    runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR])

    const cliArgs = spawn.mock.calls[0][1]
    expect(cliArgs).toEqual(expect.arrayContaining(['--url', 'about:blank', '--save-auth', path.join('/ws', 'auth-states')]))
  })

  it('uses provided url and saveAuth directory', () => {
    runRecord({ output: OUTPUT_PATH, url: 'https://example.com', saveAuth: '/custom/auth' }, [RECORDINGS_DIR])

    const cliArgs = spawn.mock.calls[0][1]
    expect(cliArgs).toEqual(expect.arrayContaining(['--url', 'https://example.com', '--save-auth', '/custom/auth']))
  })

  it('includes optional cli flags only when provided', () => {
    runRecord({
      output: OUTPUT_PATH,
      headless: true,
      viewportWidth: 800,
      viewportHeight: 600,
      profileDir: '/prof',
      cloud: 'prod',
      user: 'u@x.com',
      team: 'squad',
      dataAttribute: 'data-qa'
    }, [RECORDINGS_DIR])

    const cliArgs = spawn.mock.calls[0][1]
    expect(cliArgs).toEqual(expect.arrayContaining([
      '--headless',
      '--viewport-width', '800',
      '--viewport-height', '600',
      '--profile-dir', '/prof',
      '--cloud', 'prod',
      '--user', 'u@x.com',
      '--team', 'squad',
      '--data-attribute', 'data-qa'
    ]))
  })

  it('omits optional cli flags when not provided', () => {
    runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR])

    const cliArgs = spawn.mock.calls[0][1]
    expect(cliArgs.join(' ')).not.toMatch(/--headless|--viewport-width|--viewport-height|--profile-dir|--cloud|--user|--team|--data-attribute/)
  })

  it('kills the child process when cancellation is requested', () => {
    let capturedCancel
    vscode.window.withProgress.mockImplementation((options, task) => {
      const progress = { report: jest.fn() }
      const token = { isCancellationRequested: false, onCancellationRequested: jest.fn((cb) => { capturedCancel = cb; return { dispose: jest.fn() } }) }
      return task(progress, token)
    })

    const { proc } = runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR])
    capturedCancel()

    expect(proc.kill).toHaveBeenCalled()
  })

  it('streams stdout/stderr to the output channel while running', () => {
    const { proc, outputChannel } = runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR])

    proc.emitStdout('out-chunk')
    proc.emitStderr('err-chunk')

    expect(outputChannel.append).toHaveBeenCalledWith('out-chunk')
    expect(outputChannel.append).toHaveBeenCalledWith('err-chunk')
  })

  it('reports eventCount from an array-shaped recording and opens the resulting spec file', async () => {
    const { resultPromise, proc } = runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR, OUTPUT_PATH, SPEC_FROM_OUTPUT])
    mockReadFile({
      [TRIGGER_PATH]: JSON.stringify({ command: 'record', args: { output: OUTPUT_PATH } }),
      [OUTPUT_PATH]: JSON.stringify([{}, {}, {}])
    })
    proc.emit('close', 0)
    await resultPromise

    expectResult({ ok: true, jsonFile: OUTPUT_PATH, specFile: SPEC_FROM_OUTPUT, eventCount: 3 })
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('3 events'))
    expect(vscode.window.showTextDocument).toHaveBeenCalled()
  })

  it('reports eventCount from a {steps} shaped recording and skips opening when no spec file exists', async () => {
    const { resultPromise, proc } = runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR, OUTPUT_PATH])
    mockReadFile({
      [TRIGGER_PATH]: JSON.stringify({ command: 'record', args: { output: OUTPUT_PATH } }),
      [OUTPUT_PATH]: JSON.stringify({ steps: [1, 2] })
    })
    proc.emit('close', 0)
    await resultPromise

    expectResult({ ok: true, jsonFile: OUTPUT_PATH, specFile: null, eventCount: 2 })
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
  })

  it('reports eventCount from an {events} shaped recording', async () => {
    const { resultPromise, proc } = runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR, OUTPUT_PATH])
    mockReadFile({
      [TRIGGER_PATH]: JSON.stringify({ command: 'record', args: { output: OUTPUT_PATH } }),
      [OUTPUT_PATH]: JSON.stringify({ events: [1] })
    })
    proc.emit('close', 0)
    await resultPromise

    expectResult({ ok: true, jsonFile: OUTPUT_PATH, specFile: null, eventCount: 1 })
  })

  it('reports eventCount 0 when the output file cannot be parsed', async () => {
    const { resultPromise, proc } = runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR, OUTPUT_PATH])
    mockReadFile({
      [TRIGGER_PATH]: JSON.stringify({ command: 'record', args: { output: OUTPUT_PATH } }),
      [OUTPUT_PATH]: '{ not json'
    })
    proc.emit('close', 0)
    await resultPromise

    expectResult({ ok: true, jsonFile: OUTPUT_PATH, specFile: null, eventCount: 0 })
  })

  it('treats a null close code the same as success', async () => {
    const { resultPromise, proc } = runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR, OUTPUT_PATH])
    mockReadFile({
      [TRIGGER_PATH]: JSON.stringify({ command: 'record', args: { output: OUTPUT_PATH } }),
      [OUTPUT_PATH]: JSON.stringify({ steps: [] })
    })
    proc.emit('close', null)
    await resultPromise

    expectResult({ ok: true, jsonFile: OUTPUT_PATH, specFile: null, eventCount: 0 })
  })

  it.each([
    [-2, 'Recording was interrupted (browser closed or SIGINT).'],
    [1, 'The recording script encountered an error.'],
    [127, 'Node.js command not found.'],
    [42, 'Process exited unexpectedly with code 42.']
  ])('writes a description for exit code %s', async (code, expectedDescription) => {
    const { resultPromise, proc } = runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR])
    proc.emit('close', code)
    await resultPromise

    expectResult({ ok: false, error: expectedDescription })
  })

  it('reports a helpful hint when spawn fails with ENOENT', async () => {
    const { resultPromise, proc } = runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR])
    proc.emit('error', { code: 'ENOENT', message: 'spawn ENOENT' })
    await resultPromise

    expectResult({ ok: false, error: expect.stringContaining('Could not find Node.js') })
  })

  it('reports the raw error message when spawn fails with a non-ENOENT error', async () => {
    const { resultPromise, proc } = runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR])
    proc.emit('error', { code: 'EACCES', message: 'permission denied' })
    await resultPromise

    expectResult({ ok: false, error: 'Failed to start recording: permission denied' })
  })

  it('defaults the logged error code to "unknown" when err.code is absent', async () => {
    const { resultPromise, proc, outputChannel } = runRecord({ output: OUTPUT_PATH }, [RECORDINGS_DIR])
    proc.emit('error', { message: 'mystery failure' })
    await resultPromise

    expect(outputChannel.appendLine).toHaveBeenCalledWith('[Error] Code: unknown')
  })
})

describe('handleConvert (via command convert)', () => {
  const INPUT_FILE = path.join('/ws', 'recording.json')
  const SPEC_FROM_INPUT = INPUT_FILE.replace(/\.json$/, '.spec.js')

  function runConvert(args, existing = []) {
    const { handleTrigger, outputChannel, context } = setupHandleTrigger(existing)
    mockReadFile({ [TRIGGER_PATH]: JSON.stringify({ command: 'convert', args }) })
    const proc = makeFakeProc()
    spawn.mockReturnValue(proc)
    const resultPromise = handleTrigger()
    return { resultPromise, proc, outputChannel, context }
  }

  it('writes an error when the input file does not exist', async () => {
    const { resultPromise } = runConvert({ inputFile: 'recording.json' })
    await resultPromise

    expectResult({ ok: false, error: `Input file not found: ${INPUT_FILE}` })
  })

  it('does not re-resolve an already-absolute inputFile path', () => {
    runConvert({ inputFile: INPUT_FILE }, [INPUT_FILE])

    const cliArgs = spawn.mock.calls[0][1]
    expect(cliArgs).toContain(INPUT_FILE)
  })

  it('includes optional cli flags only when provided', () => {
    runConvert({ inputFile: 'recording.json', output: '/out.spec.js', cloud: 'prod', user: 'u@x.com', team: 'squad' }, [INPUT_FILE])

    const cliArgs = spawn.mock.calls[0][1]
    expect(cliArgs).toEqual(expect.arrayContaining(['--output', '/out.spec.js', '--cloud', 'prod', '--user', 'u@x.com', '--team', 'squad']))
  })

  it('omits optional cli flags when not provided', () => {
    runConvert({ inputFile: 'recording.json' }, [INPUT_FILE])

    const cliArgs = spawn.mock.calls[0][1]
    expect(cliArgs.join(' ')).not.toMatch(/--output|--cloud|--user|--team/)
  })

  it('streams stdout/stderr to the output channel while running', () => {
    const { proc, outputChannel } = runConvert({ inputFile: 'recording.json' }, [INPUT_FILE])

    proc.emitStdout('out-chunk')
    proc.emitStderr('err-chunk')

    expect(outputChannel.append).toHaveBeenCalledWith('out-chunk')
    expect(outputChannel.append).toHaveBeenCalledWith('err-chunk')
  })

  it('writes a success result with the default spec path and accumulated stdout', async () => {
    const { resultPromise, proc } = runConvert({ inputFile: 'recording.json' }, [INPUT_FILE])
    proc.emitStdout('conversion log')
    proc.emit('close', 0)
    await resultPromise

    expectResult({ ok: true, specFile: SPEC_FROM_INPUT, output: 'conversion log' })
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('demo.spec.js'.replace('demo', 'recording')))
  })

  it('writes a success result using args.output as the spec path when provided', async () => {
    const { resultPromise, proc } = runConvert({ inputFile: 'recording.json', output: '/custom.spec.js' }, [INPUT_FILE])
    proc.emit('close', 0)
    await resultPromise

    expectResult({ ok: true, specFile: '/custom.spec.js', output: '' })
  })

  it('writes a failure result using trimmed stderr when the process exits non-zero', async () => {
    const { resultPromise, proc } = runConvert({ inputFile: 'recording.json' }, [INPUT_FILE])
    proc.emitStderr('  boom happened  \n')
    proc.emit('close', 1)
    await resultPromise

    expectResult({ ok: false, error: 'Conversion failed: boom happened' })
  })

  it('falls back to an exit-code message when there is no stderr output', async () => {
    const { resultPromise, proc } = runConvert({ inputFile: 'recording.json' }, [INPUT_FILE])
    proc.emit('close', 1)
    await resultPromise

    expectResult({ ok: false, error: 'Conversion failed: Exit code 1' })
  })

  it('reports a helpful hint when spawn fails with ENOENT', async () => {
    const { resultPromise, proc } = runConvert({ inputFile: 'recording.json' }, [INPUT_FILE])
    proc.emit('error', { code: 'ENOENT', message: 'spawn ENOENT' })
    await resultPromise

    expectResult({ ok: false, error: expect.stringContaining('Could not find Node.js') })
  })

  it('reports the raw error message when spawn fails with a non-ENOENT error', async () => {
    const { resultPromise, proc } = runConvert({ inputFile: 'recording.json' }, [INPUT_FILE])
    proc.emit('error', { code: 'EACCES', message: 'permission denied' })
    await resultPromise

    expectResult({ ok: false, error: 'permission denied' })
  })
})
