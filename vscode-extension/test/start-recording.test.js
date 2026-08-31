jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn()
}))
jest.mock('child_process', () => ({ spawn: jest.fn() }))
jest.mock('../ensure-playwright-config', () => ({ ensurePlaywrightConfig: jest.fn(() => ({ created: false })) }))
jest.mock('../resolve-node', () => ({ resolveNodePath: jest.fn(() => '/usr/bin/node') }))
jest.mock('../sf-cli', () => ({ listSalesforceCliOrgs: jest.fn() }))

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { ensurePlaywrightConfig } = require('../ensure-playwright-config')
const { listSalesforceCliOrgs } = require('../sf-cli')
const { register } = require('../commands/start-recording')

const RECORDINGS_DIR = path.join('/ws', 'test-plans', 'playwright')
const AUTH_STATES_DIR = path.join('/ws', 'auth-states')
const CLI_ROOT = path.resolve(__dirname, '..', '..')
const CLI_PATH = path.resolve(CLI_ROOT, 'recorder-cli', 'bin', 'cli.js')

const MANUAL_CHOICE = { label: '$(globe) Enter a URL manually', mode: 'manual' }
const CLI_CHOICE = { label: '$(key) Log in with a Salesforce CLI org', mode: 'cli' }

afterEach(() => {
  jest.clearAllMocks()
  vscode.workspace.workspaceFolders = undefined
})

beforeEach(() => {
  fs.existsSync.mockReturnValue(true)
  fs.readdirSync.mockReturnValue([])
})

function setWorkspace() {
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
}

function getHandler(context = { extensionPath: '/ext' }) {
  const outputChannel = vscode.__factories.makeOutputChannel()
  register(context, outputChannel)
  const handler = vscode.commands.registerCommand.mock.calls.at(-1)[1]
  return { handler, outputChannel }
}

function mockManualLogin(urlInput) {
  vscode.window.showQuickPick.mockResolvedValueOnce(MANUAL_CHOICE)
  vscode.window.showInputBox.mockResolvedValueOnce(urlInput)
}

function orgItemsFor(orgs) {
  return orgs.map((o) => ({
    label: o.alias ? `${o.alias} ($(account) ${o.username})` : o.username,
    detail: o.instanceUrl,
    org: o
  }))
}

function mockCliOrgLogin({ orgs, pickedOrgIndex = 0, landingPath = '' }) {
  vscode.window.showQuickPick.mockResolvedValueOnce(CLI_CHOICE)
  listSalesforceCliOrgs.mockResolvedValueOnce(orgs)
  vscode.window.showQuickPick.mockResolvedValueOnce(orgItemsFor(orgs)[pickedOrgIndex])
  vscode.window.showInputBox.mockResolvedValueOnce(landingPath)
}

function makeFakeProc() {
  const listeners = {}
  return {
    stdout: { on: jest.fn((event, cb) => { listeners[`stdout:${event}`] = cb }) },
    stderr: { on: jest.fn((event, cb) => { listeners[`stderr:${event}`] = cb }) },
    on: jest.fn((event, cb) => { listeners[event] = cb }),
    kill: jest.fn(),
    emit(event, ...args) { return listeners[event](...args) },
    emitStdout(data) { listeners['stdout:data'](data) },
    emitStderr(data) { listeners['stderr:data'](data) }
  }
}

async function reachSpawn(setupLogin) {
  setWorkspace()
  const fakeProc = makeFakeProc()
  spawn.mockReturnValue(fakeProc)
  setupLogin()
  const { handler, outputChannel } = getHandler()
  await handler()
  return { fakeProc, outputChannel }
}

function getArgs() {
  return spawn.mock.calls[0][1]
}

function outputPathFrom(args) {
  return args[args.indexOf('--output') + 1]
}

describe('pickLoginMode — cancellation at each step', () => {
  it('does nothing when the login-mode picker is cancelled', async () => {
    vscode.window.showQuickPick.mockResolvedValueOnce(undefined)
    const { handler } = getHandler()

    await handler()

    expect(spawn).not.toHaveBeenCalled()
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
  })

  it('does nothing when the manual URL prompt is cancelled', async () => {
    mockManualLogin(undefined)
    const { handler } = getHandler()

    await handler()

    expect(spawn).not.toHaveBeenCalled()
  })

  it('does nothing when listing CLI orgs fails with a message', async () => {
    vscode.window.showQuickPick.mockResolvedValueOnce(CLI_CHOICE)
    listSalesforceCliOrgs.mockRejectedValueOnce(new Error('sf not found'))
    const { handler } = getHandler()

    await handler()

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('sf not found')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('shows a default message when listing CLI orgs fails without one', async () => {
    vscode.window.showQuickPick.mockResolvedValueOnce(CLI_CHOICE)
    listSalesforceCliOrgs.mockRejectedValueOnce({})
    const { handler } = getHandler()

    await handler()

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Could not list Salesforce CLI orgs')
    )
  })

  it('shows an error when there are no connected orgs', async () => {
    vscode.window.showQuickPick.mockResolvedValueOnce(CLI_CHOICE)
    listSalesforceCliOrgs.mockResolvedValueOnce([])
    const { handler } = getHandler()

    await handler()

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No connected orgs found')
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does nothing when the org picker is cancelled', async () => {
    vscode.window.showQuickPick.mockResolvedValueOnce(CLI_CHOICE)
    listSalesforceCliOrgs.mockResolvedValueOnce([{ username: 'a@b.com', alias: null, instanceUrl: 'https://a' }])
    vscode.window.showQuickPick.mockResolvedValueOnce(undefined)
    const { handler } = getHandler()

    await handler()

    expect(spawn).not.toHaveBeenCalled()
  })

  it('does nothing when the landing-path prompt is cancelled', async () => {
    vscode.window.showQuickPick.mockResolvedValueOnce(CLI_CHOICE)
    listSalesforceCliOrgs.mockResolvedValueOnce([{ username: 'a@b.com', alias: null, instanceUrl: 'https://a' }])
    vscode.window.showQuickPick.mockResolvedValueOnce(orgItemsFor([{ username: 'a@b.com', alias: null, instanceUrl: 'https://a' }])[0])
    vscode.window.showInputBox.mockResolvedValueOnce(undefined)
    const { handler } = getHandler()

    await handler()

    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('pickLoginMode — manual URL normalization', () => {
  it('defaults to login.salesforce.com when the input is empty', async () => {
    await reachSpawn(() => mockManualLogin(''))

    expect(getArgs()).toEqual(expect.arrayContaining(['--url', 'https://login.salesforce.com']))
  })

  it('defaults to login.salesforce.com when the input is whitespace-only', async () => {
    await reachSpawn(() => mockManualLogin('   '))

    expect(getArgs()).toEqual(expect.arrayContaining(['--url', 'https://login.salesforce.com']))
  })

  it('prepends https:// when the input has no protocol', async () => {
    await reachSpawn(() => mockManualLogin('myorg.salesforce.com'))

    expect(getArgs()).toEqual(expect.arrayContaining(['--url', 'https://myorg.salesforce.com']))
  })

  it('leaves an input with an existing protocol unchanged', async () => {
    await reachSpawn(() => mockManualLogin('http://myorg.salesforce.com'))

    expect(getArgs()).toEqual(expect.arrayContaining(['--url', 'http://myorg.salesforce.com']))
  })

  describe('validateInput', () => {
    async function getValidateInput() {
      vscode.window.showQuickPick.mockResolvedValueOnce(MANUAL_CHOICE)
      vscode.window.showInputBox.mockResolvedValueOnce(undefined)
      const { handler } = getHandler()
      await handler()
      return vscode.window.showInputBox.mock.calls.at(-1)[0].validateInput
    }

    it('accepts an empty or whitespace-only value', async () => {
      const validateInput = await getValidateInput()

      expect(validateInput('')).toBeNull()
      expect(validateInput('   ')).toBeNull()
    })

    it('rejects a value that is not a valid URL even with https:// prepended', async () => {
      const validateInput = await getValidateInput()

      expect(validateInput('not a url')).toBe('Please enter a valid URL')
    })

    it('accepts a bare hostname that becomes valid once https:// is prepended', async () => {
      const validateInput = await getValidateInput()

      expect(validateInput('myorg.salesforce.com')).toBeNull()
    })

    it('accepts a value that already has a valid protocol', async () => {
      const validateInput = await getValidateInput()

      expect(validateInput('http://myorg.salesforce.com')).toBeNull()
    })
  })
})

describe('pickLoginMode — CLI org selection', () => {
  it('labels an org with its alias when present', async () => {
    await reachSpawn(() => mockCliOrgLogin({
      orgs: [{ username: 'a@b.com', alias: 'MyAlias', instanceUrl: 'https://a.my.salesforce.com' }]
    }))

    expect(vscode.window.showQuickPick.mock.calls[1][0]).toEqual([
      { label: 'MyAlias ($(account) a@b.com)', detail: 'https://a.my.salesforce.com', org: expect.anything() }
    ])
  })

  it('labels an org with just its username when there is no alias', async () => {
    await reachSpawn(() => mockCliOrgLogin({
      orgs: [{ username: 'a@b.com', alias: null, instanceUrl: 'https://a.my.salesforce.com' }]
    }))

    expect(vscode.window.showQuickPick.mock.calls[1][0]).toEqual([
      { label: 'a@b.com', detail: 'https://a.my.salesforce.com', org: expect.anything() }
    ])
  })

  it('passes --org and omits --url when no landing path is given', async () => {
    await reachSpawn(() => mockCliOrgLogin({
      orgs: [{ username: 'a@b.com', alias: null, instanceUrl: 'https://a' }],
      landingPath: ''
    }))

    const args = getArgs()
    expect(args).toEqual(expect.arrayContaining(['--org', 'a@b.com']))
    expect(args).not.toEqual(expect.arrayContaining(['--url']))
  })

  it('passes both --org and --url when a landing path is given', async () => {
    await reachSpawn(() => mockCliOrgLogin({
      orgs: [{ username: 'a@b.com', alias: null, instanceUrl: 'https://a' }],
      landingPath: '/lightning/o/Account/list'
    }))

    const args = getArgs()
    expect(args).toEqual(expect.arrayContaining(['--org', 'a@b.com', '--url', '/lightning/o/Account/list']))
  })
})

describe('register — workspace and config setup', () => {
  it('shows an error and does not spawn without a workspace folder', async () => {
    const fakeProc = makeFakeProc()
    spawn.mockReturnValue(fakeProc)
    mockManualLogin('')
    const { handler } = getHandler()

    await handler()

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Please open a workspace folder first.')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('creates the recordings directory when missing', async () => {
    fs.existsSync.mockImplementation((p) => p !== RECORDINGS_DIR)
    await reachSpawn(() => mockManualLogin(''))

    expect(fs.mkdirSync).toHaveBeenCalledWith(RECORDINGS_DIR, { recursive: true })
  })

  it('does not recreate the recordings directory when it already exists', async () => {
    await reachSpawn(() => mockManualLogin(''))

    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })

  it('logs when ensurePlaywrightConfig creates a new config file', async () => {
    ensurePlaywrightConfig.mockReturnValueOnce({ created: true })
    const { outputChannel } = await reachSpawn(() => mockManualLogin(''))

    expect(outputChannel.appendLine).toHaveBeenCalledWith('[Salesforce UI Script Recorder] Created playwright.config.js in workspace')
  })

  it('does not log when ensurePlaywrightConfig makes no changes', async () => {
    const { outputChannel } = await reachSpawn(() => mockManualLogin(''))

    expect(outputChannel.appendLine).not.toHaveBeenCalledWith(expect.stringContaining('Created playwright.config.js'))
  })

  it('spawns the resolved node path against the recorder CLI with the expected cwd', async () => {
    await reachSpawn(() => mockManualLogin(''))

    expect(spawn).toHaveBeenCalledWith('/usr/bin/node', expect.arrayContaining([CLI_PATH, 'record']), {
      cwd: CLI_ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  })

  it('writes the output path under the recordings directory with a timestamped filename', async () => {
    await reachSpawn(() => mockManualLogin(''))

    const outputPath = outputPathFrom(getArgs())
    expect(path.dirname(outputPath)).toBe(RECORDINGS_DIR)
    expect(path.basename(outputPath)).toMatch(/^recording_.+\.json$/)
  })
})

describe('register — saved-auth session picker (manual/url login only)', () => {
  it('passes --save-auth with the auth-states directory', async () => {
    await reachSpawn(() => mockManualLogin('myorg.salesforce.com'))

    expect(getArgs()).toEqual(expect.arrayContaining(['--save-auth', AUTH_STATES_DIR]))
  })

  it('does not prompt when there are no saved sessions for the hostname', async () => {
    fs.readdirSync.mockReturnValue([])
    await reachSpawn(() => mockManualLogin('myorg.salesforce.com'))

    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1)
  })

  it('does not prompt when exactly one saved session matches the hostname', async () => {
    fs.readdirSync.mockReturnValue(['myorg.salesforce.com---user1.json'])
    await reachSpawn(() => mockManualLogin('myorg.salesforce.com'))

    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1)
    expect(getArgs()).not.toEqual(expect.arrayContaining(['--load-auth']))
  })

  it('does not scan for saved sessions when the auth-states directory does not exist', async () => {
    fs.existsSync.mockImplementation((p) => p !== AUTH_STATES_DIR)
    await reachSpawn(() => mockManualLogin('myorg.salesforce.com'))

    expect(fs.readdirSync).not.toHaveBeenCalled()
  })

  it('prompts to choose among multiple saved sessions and returns without spawning if cancelled', async () => {
    setWorkspace()
    fs.readdirSync.mockReturnValue(['myorg.salesforce.com---user1.json', 'myorg.salesforce.com---user2.json'])
    mockManualLogin('myorg.salesforce.com')
    vscode.window.showQuickPick.mockResolvedValueOnce(undefined)
    const { handler } = getHandler()

    await handler()

    expect(spawn).not.toHaveBeenCalled()
  })

  it('adds --load-auth with the chosen session file', async () => {
    setWorkspace()
    fs.readdirSync.mockReturnValue(['myorg.salesforce.com---user1.json', 'myorg.salesforce.com---user2.json'])
    mockManualLogin('myorg.salesforce.com')
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: 'user2', description: 'myorg.salesforce.com---user2.json', file: 'myorg.salesforce.com---user2.json' })
    const fakeProc = makeFakeProc()
    spawn.mockReturnValue(fakeProc)
    const { handler } = getHandler()

    await handler()

    expect(getArgs()).toEqual(expect.arrayContaining(['--load-auth', path.join(AUTH_STATES_DIR, 'myorg.salesforce.com---user2.json')]))
  })

  it('does not add --load-auth when "New session" is chosen', async () => {
    setWorkspace()
    fs.readdirSync.mockReturnValue(['myorg.salesforce.com---user1.json', 'myorg.salesforce.com---user2.json'])
    mockManualLogin('myorg.salesforce.com')
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: '$(add) New session', description: 'Start fresh without loading saved auth', file: null })
    const fakeProc = makeFakeProc()
    spawn.mockReturnValue(fakeProc)
    const { handler } = getHandler()

    await handler()

    expect(getArgs()).not.toEqual(expect.arrayContaining(['--load-auth']))
  })
})

function captureProgress() {
  const captured = { progress: { report: jest.fn() }, token: { isCancellationRequested: false, onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })) } }
  vscode.window.withProgress.mockImplementationOnce((options, task) => task(captured.progress, captured.token))
  return captured
}

describe('register — recording process: progress, output streaming, cancellation', () => {
  it('reports the org as the target when logging in via CLI org', async () => {
    await reachSpawn(() => mockCliOrgLogin({ orgs: [{ username: 'a@b.com', alias: null, instanceUrl: 'https://a' }] }))

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Salesforce UI Script Recorder', cancellable: true }),
      expect.any(Function)
    )
  })

  it('reports the org name as the progress message when logging in via CLI org', async () => {
    const captured = captureProgress()
    await reachSpawn(() => mockCliOrgLogin({ orgs: [{ username: 'a@b.com', alias: null, instanceUrl: 'https://a' }] }))

    expect(captured.progress.report).toHaveBeenCalledWith({
      message: expect.stringContaining('a@b.com (via Salesforce CLI)')
    })
  })

  it('reports the url as the progress message when logging in manually', async () => {
    const captured = captureProgress()
    await reachSpawn(() => mockManualLogin('myorg.salesforce.com'))

    expect(captured.progress.report).toHaveBeenCalledWith({
      message: expect.stringContaining('https://myorg.salesforce.com')
    })
  })

  it('streams stdout and stderr to the output channel', async () => {
    const { fakeProc, outputChannel } = await reachSpawn(() => mockManualLogin(''))

    fakeProc.emitStdout('hello ')
    fakeProc.emitStderr('world')

    expect(outputChannel.append).toHaveBeenCalledWith('hello ')
    expect(outputChannel.append).toHaveBeenCalledWith('world')
  })

  it('kills the process when the progress notification is cancelled', async () => {
    const captured = captureProgress()
    const { fakeProc } = await reachSpawn(() => mockManualLogin(''))

    const onCancel = captured.token.onCancellationRequested.mock.calls[0][0]
    onCancel()

    expect(fakeProc.kill).toHaveBeenCalled()
  })
})

describe('register — recording process: successful close', () => {
  it.each([
    ['an array recording', JSON.stringify([{}, {}, {}]), 3],
    ['a { steps } recording', JSON.stringify({ steps: [{}, {}] }), 2],
    ['a { events } recording', JSON.stringify({ events: [{}] }), 1],
    ['unparsable content', '{ not json', 0]
  ])('reports the event count for %s', async (_label, fileContents, expectedCount) => {
    const { fakeProc } = await reachSpawn(() => mockManualLogin(''))
    fs.readFileSync.mockReturnValue(fileContents)

    await fakeProc.emit('close', 0)

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      `Salesforce UI Script Recorder: Recording successfully saved with ${expectedCount} events.`
    )
  })

  it('treats a null close code the same as a successful exit', async () => {
    const { fakeProc } = await reachSpawn(() => mockManualLogin(''))
    fs.readFileSync.mockReturnValue(JSON.stringify({ steps: [] }))

    await fakeProc.emit('close', null)

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('successfully saved'))
  })

  it('opens the generated spec file when one was produced', async () => {
    const { fakeProc } = await reachSpawn(() => mockManualLogin(''))
    fs.readFileSync.mockReturnValue(JSON.stringify({ steps: [] }))
    const outputPath = outputPathFrom(getArgs())
    const specPath = outputPath.replace(/\.json$/, '.spec.js')
    fs.existsSync.mockImplementation((p) => p === specPath)

    await fakeProc.emit('close', 0)

    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(specPath)
    expect(vscode.window.showTextDocument).toHaveBeenCalled()
  })

  it('does not open a spec document when none was produced', async () => {
    const { fakeProc } = await reachSpawn(() => mockManualLogin(''))
    fs.readFileSync.mockReturnValue(JSON.stringify({ steps: [] }))
    fs.existsSync.mockReturnValue(false)

    await fakeProc.emit('close', 0)

    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
  })
})

describe('register — recording process: failed close', () => {
  it.each([
    [-2, 'Process was interrupted (SIGINT). The recording browser may have been closed manually.'],
    [1, 'The recording script encountered an error. Check the output panel for details.'],
    [127, 'Command not found. Node.js may not be installed correctly.'],
    [42, 'An unexpected error occurred.']
  ])('shows the description for exit code %i', async (code, description) => {
    const { fakeProc, outputChannel } = await reachSpawn(() => mockManualLogin(''))

    await fakeProc.emit('close', code)

    expect(outputChannel.appendLine).toHaveBeenCalledWith(`\n[Exit code ${code}]: ${description}`)
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      `Salesforce UI Script Recorder: Recording stopped — ${description}`,
      'Show Output'
    )
  })

  it('re-shows the output channel when "Show Output" is chosen', async () => {
    vscode.window.showErrorMessage.mockResolvedValueOnce('Show Output')
    const { fakeProc, outputChannel } = await reachSpawn(() => mockManualLogin(''))

    await fakeProc.emit('close', 1)
    await Promise.resolve()

    expect(outputChannel.show).toHaveBeenCalledWith()
  })

  it('does not re-show the output channel for a different choice', async () => {
    vscode.window.showErrorMessage.mockResolvedValueOnce(undefined)
    const { fakeProc, outputChannel } = await reachSpawn(() => mockManualLogin(''))
    outputChannel.show.mockClear()

    await fakeProc.emit('close', 1)
    await Promise.resolve()

    expect(outputChannel.show).not.toHaveBeenCalled()
  })
})

describe('register — recording process: spawn error', () => {
  it('shows a Node-not-found hint for ENOENT errors', async () => {
    const { fakeProc, outputChannel } = await reachSpawn(() => mockManualLogin(''))

    fakeProc.emit('error', { code: 'ENOENT', message: 'spawn ENOENT' })

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Salesforce UI Script Recorder: Could not find Node.js at "/usr/bin/node". Ensure Node is installed and available on your PATH.',
      'Show Output'
    )
    expect(outputChannel.appendLine).toHaveBeenCalledWith('[Error] Code: ENOENT')
  })

  it('shows a generic failure hint for non-ENOENT errors and defaults the logged code to "unknown"', async () => {
    const { fakeProc, outputChannel } = await reachSpawn(() => mockManualLogin(''))

    fakeProc.emit('error', { message: 'permission denied' })

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Salesforce UI Script Recorder: Failed to start recording process: permission denied',
      'Show Output'
    )
    expect(outputChannel.appendLine).toHaveBeenCalledWith('[Error] Code: unknown')
  })

  it('re-shows the output channel when "Show Output" is chosen after a spawn error', async () => {
    vscode.window.showErrorMessage.mockResolvedValueOnce('Show Output')
    const { fakeProc, outputChannel } = await reachSpawn(() => mockManualLogin(''))

    fakeProc.emit('error', { message: 'permission denied' })
    await Promise.resolve()

    expect(outputChannel.show).toHaveBeenCalledWith()
  })

  it('does not re-show the output channel for a different choice after a spawn error', async () => {
    vscode.window.showErrorMessage.mockResolvedValueOnce(undefined)
    const { fakeProc, outputChannel } = await reachSpawn(() => mockManualLogin(''))
    outputChannel.show.mockClear()

    fakeProc.emit('error', { message: 'permission denied' })
    await Promise.resolve()

    expect(outputChannel.show).not.toHaveBeenCalled()
  })
})
