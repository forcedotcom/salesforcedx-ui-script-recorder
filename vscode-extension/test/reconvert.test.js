jest.mock('fs', () => ({ existsSync: jest.fn() }))
jest.mock('child_process', () => ({ spawn: jest.fn() }))
jest.mock('../resolve-node', () => ({ resolveNodePath: jest.fn(() => '/usr/bin/node') }))

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { register } = require('../commands/reconvert')

const JSON_PATH = path.join('/ws', 'test-plans', 'playwright', 'demo.json')
const SPEC_PATH = path.join('/ws', 'test-plans', 'playwright', 'demo.spec.js')

afterEach(() => {
  jest.clearAllMocks()
  vscode.window.activeTextEditor = undefined
})

function makeFakeProc() {
  const listeners = {}
  return {
    stdout: { on: jest.fn((event, cb) => { listeners[`stdout:${event}`] = cb }) },
    stderr: { on: jest.fn((event, cb) => { listeners[`stderr:${event}`] = cb }) },
    on: jest.fn((event, cb) => { listeners[event] = cb }),
    emit(event, ...args) { return listeners[event](...args) },
    emitStdout(data) { listeners['stdout:data'](data) },
    emitStderr(data) { listeners['stderr:data'](data) }
  }
}

function getHandler() {
  register({})
  return vscode.commands.registerCommand.mock.calls.at(-1)[1]
}

async function reachSpawn(uri, { confirm = 'Re-convert' } = {}) {
  const fakeProc = makeFakeProc()
  spawn.mockReturnValue(fakeProc)
  vscode.window.showWarningMessage.mockResolvedValueOnce(confirm)
  const handler = getHandler()
  await handler(uri)
  return fakeProc
}

describe('reconvert command — resolving the target json path', () => {
  it('shows an error when there is no documentUri and no active editor', async () => {
    const handler = getHandler()

    await handler(undefined)

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: No recording file open.')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('falls back to the active editor document when no documentUri is passed', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH)
    vscode.window.activeTextEditor = { document: { uri: vscode.Uri.file(JSON_PATH) } }
    const fakeProc = makeFakeProc()
    spawn.mockReturnValue(fakeProc)
    const handler = getHandler()

    await handler(undefined)

    expect(spawn).toHaveBeenCalled()
  })

  it('shows an error when the resolved path is neither .json nor .spec.js', async () => {
    const handler = getHandler()

    await handler(vscode.Uri.file('/ws/notes.txt'))

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: No recording JSON found.')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('shows an error when the json file does not exist on disk', async () => {
    fs.existsSync.mockReturnValue(false)
    const handler = getHandler()

    await handler(vscode.Uri.file(JSON_PATH))

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: No recording JSON found.')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('normalizes a .spec.js uri to its sibling .json path', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH)
    const fakeProc = makeFakeProc()
    spawn.mockReturnValue(fakeProc)
    const handler = getHandler()

    await handler(vscode.Uri.file(SPEC_PATH))

    expect(spawn).toHaveBeenCalledWith('/usr/bin/node', expect.arrayContaining([JSON_PATH]), expect.anything())
  })
})

describe('reconvert command — overwrite confirmation', () => {
  it('spawns immediately without prompting when no sibling spec file exists', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH)
    const fakeProc = makeFakeProc()
    spawn.mockReturnValue(fakeProc)
    const handler = getHandler()

    await handler(vscode.Uri.file(JSON_PATH))

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalled()
  })

  it('prompts to confirm when a sibling spec file exists, and cancels without spawning', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH || p === SPEC_PATH)
    vscode.window.showWarningMessage.mockResolvedValueOnce(undefined)
    const handler = getHandler()

    await handler(vscode.Uri.file(JSON_PATH))

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('demo.spec.js'),
      { modal: true },
      'Re-convert'
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('spawns after confirming the overwrite', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH || p === SPEC_PATH)
    await reachSpawn(vscode.Uri.file(JSON_PATH), { confirm: 'Re-convert' })

    expect(spawn).toHaveBeenCalledWith('/usr/bin/node', expect.arrayContaining(['convert', JSON_PATH]), {
      cwd: path.resolve(__dirname, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    })
  })
})

describe('reconvert command — process close handling', () => {
  it('opens the regenerated spec and shows a success message when it exists', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH || p === SPEC_PATH)
    const fakeProc = await reachSpawn(vscode.Uri.file(JSON_PATH))

    await fakeProc.emit('close', 0)

    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(SPEC_PATH)
    expect(vscode.window.showTextDocument).toHaveBeenCalled()
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Playwright script regenerated.')
  })

  it('shows a success message without opening a document when the spec was not written', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH)
    const fakeProc = await reachSpawn(vscode.Uri.file(JSON_PATH))
    fs.existsSync.mockReturnValue(false)

    await fakeProc.emit('close', 0)

    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Playwright script regenerated.')
  })

  it('uses trimmed stderr as the failure detail when present', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH)
    const fakeProc = await reachSpawn(vscode.Uri.file(JSON_PATH))
    fakeProc.emitStderr('  boom  ')

    await fakeProc.emit('close', 1)

    const outputChannel = vscode.window.createOutputChannel.mock.results.at(-1).value
    expect(outputChannel.appendLine).toHaveBeenCalledWith('[Convert] Failed with exit code 1')
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Conversion failed — boom', 'Show Output')
  })

  it('falls back to trimmed stdout when stderr is empty', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH)
    const fakeProc = await reachSpawn(vscode.Uri.file(JSON_PATH))
    fakeProc.emitStdout('  out  ')

    await fakeProc.emit('close', 1)

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Conversion failed — out', 'Show Output')
  })

  it('falls back to the exit code when neither stderr nor stdout have content', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH)
    const fakeProc = await reachSpawn(vscode.Uri.file(JSON_PATH))

    await fakeProc.emit('close', 7)

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Conversion failed — Exit code 7', 'Show Output')
  })

  it('re-shows the output channel when "Show Output" is chosen', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH)
    vscode.window.showErrorMessage.mockResolvedValueOnce('Show Output')
    const fakeProc = await reachSpawn(vscode.Uri.file(JSON_PATH))

    await fakeProc.emit('close', 1)
    await Promise.resolve()

    const outputChannel = vscode.window.createOutputChannel.mock.results.at(-1).value
    expect(outputChannel.show).toHaveBeenCalledWith()
  })

  it('does not re-show the output channel when a different choice is made', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH)
    vscode.window.showErrorMessage.mockResolvedValueOnce(undefined)
    const fakeProc = await reachSpawn(vscode.Uri.file(JSON_PATH))

    await fakeProc.emit('close', 1)
    await Promise.resolve()

    const outputChannel = vscode.window.createOutputChannel.mock.results.at(-1).value
    expect(outputChannel.show).toHaveBeenCalledTimes(1)
    expect(outputChannel.show).toHaveBeenCalledWith(true)
  })
})

describe('reconvert command — process spawn error handling', () => {
  it('shows a Node-not-found hint for ENOENT errors', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH)
    const fakeProc = await reachSpawn(vscode.Uri.file(JSON_PATH))

    fakeProc.emit('error', { code: 'ENOENT', message: 'spawn ENOENT' })

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Salesforce UI Script Recorder: Could not find Node.js at "/usr/bin/node". Ensure Node is installed and available on your PATH.',
      'Show Output'
    )
  })

  it('shows the raw error message for non-ENOENT errors, defaulting the logged code to "unknown"', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH)
    const fakeProc = await reachSpawn(vscode.Uri.file(JSON_PATH))

    fakeProc.emit('error', { message: 'permission denied' })

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: permission denied', 'Show Output')
    const outputChannel = vscode.window.createOutputChannel.mock.results.at(-1).value
    expect(outputChannel.appendLine).toHaveBeenCalledWith('[Convert] Error code: unknown')
  })

  it('re-shows the output channel when "Show Output" is chosen after a spawn error', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH)
    vscode.window.showErrorMessage.mockResolvedValueOnce('Show Output')
    const fakeProc = await reachSpawn(vscode.Uri.file(JSON_PATH))

    fakeProc.emit('error', { message: 'permission denied' })
    await Promise.resolve()

    const outputChannel = vscode.window.createOutputChannel.mock.results.at(-1).value
    expect(outputChannel.show).toHaveBeenCalledWith()
  })

  it('does not re-show the output channel for a different choice after a spawn error', async () => {
    fs.existsSync.mockImplementation((p) => p === JSON_PATH)
    vscode.window.showErrorMessage.mockResolvedValueOnce(undefined)
    const fakeProc = await reachSpawn(vscode.Uri.file(JSON_PATH))

    fakeProc.emit('error', { message: 'permission denied' })
    await Promise.resolve()

    const outputChannel = vscode.window.createOutputChannel.mock.results.at(-1).value
    expect(outputChannel.show).toHaveBeenCalledTimes(1)
    expect(outputChannel.show).toHaveBeenCalledWith(true)
  })
})
