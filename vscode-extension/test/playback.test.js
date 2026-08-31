jest.mock('fs')
jest.mock('../ensure-playwright-config', () => ({ ensurePlaywrightConfig: jest.fn() }))
jest.mock('../commands/results-viewer', () => ({ clearInProgress: jest.fn() }))
jest.mock('../sf-cli', () => ({ listSalesforceCliOrgs: jest.fn() }))

const path = require('path')

const WORKSPACE = path.join('/ws')
const SPEC_PATH = path.join('/ws', 'test-plans', 'playwright', 'demo.spec.js')
const USERS_DIR = path.join('/ws', 'user-files')
const DATA_DIR = path.join('/ws', 'data-files')
const RECORDINGS_DIR = path.join('/ws', 'test-plans', 'playwright')
const RESULTS_DIR = path.join('/ws', 'playback-results')
const AUTH_DIR = path.join('/ws', 'auth-states')

let vscode
let fs
let ensurePlaywrightConfig
let clearInProgress
let listSalesforceCliOrgs
let register

const flush = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  jest.resetModules()
  vscode = require('vscode')
  fs = require('fs')
  ;({ ensurePlaywrightConfig } = require('../ensure-playwright-config'))
  ;({ clearInProgress } = require('../commands/results-viewer'))
  ;({ listSalesforceCliOrgs } = require('../sf-cli'))
  ;({ register } = require('../commands/playback'))

  vscode.workspace.workspaceFolders = [{ uri: { fsPath: WORKSPACE } }]
  vscode.window.activeTextEditor = { document: { uri: { fsPath: SPEC_PATH } } }
  listSalesforceCliOrgs.mockResolvedValue([])
  fs.existsSync.mockReturnValue(false)
  fs.readFileSync.mockReturnValue('')
  fs.readdirSync.mockReturnValue([])
})

function getHandler(extensionPath = '/ext') {
  register({ extensionPath })
  return vscode.commands.registerCommand.mock.calls.at(-1)[1]
}

async function openForm() {
  const handler = getHandler()
  const resultPromise = handler()
  await flush()
  const panel = vscode.window.createWebviewPanel.mock.results.at(-1).value
  const onMessage = panel.webview.onDidReceiveMessage.mock.calls.at(-1)[0]
  const onDispose = panel.onDidDispose.mock.calls.at(-1)[0]
  return { resultPromise, panel, onMessage, onDispose }
}

function fireUsersWatcherChange() {
  const usersWatcher = vscode.workspace.createFileSystemWatcher.mock.results[0].value
  usersWatcher.onDidChange.mock.calls[0][0]()
}

function fireDataWatcherCreate() {
  const dataWatcher = vscode.workspace.createFileSystemWatcher.mock.results[1].value
  dataWatcher.onDidCreate.mock.calls[0][0]()
}

async function finishRun({ onMessage, onDispose, resultPromise }, data) {
  onMessage({ type: 'run', data })
  onDispose()
  await resultPromise
  await flush()
}

async function completeTask(index = 0) {
  const exec = await vscode.tasks.executeTask.mock.results[index].value
  vscode.tasks.onDidEndTaskProcess.mock.calls[index][0]({ execution: exec })
}

describe('playbackScript command — guard clauses', () => {
  it('shows an info message and does nothing when a playback is already in progress', async () => {
    fs.existsSync.mockImplementation((p) => p === RECORDINGS_DIR)
    fs.readdirSync.mockReturnValue([])
    const form = await openForm()
    await finishRun(form, { params: {}, headed: true, org: null })
    // task never completes -> playbackInProgress stays true

    const handler = getHandler()
    await handler()

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Salesforce UI Script Recorder: A playback is already running. Please wait for it to finish before starting another.'
    )
    expect(listSalesforceCliOrgs).toHaveBeenCalledTimes(1)
  })

  it('shows an error when there is no active editor', async () => {
    vscode.window.activeTextEditor = undefined
    const handler = getHandler()

    await handler()

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: No file open.')
    expect(ensurePlaywrightConfig).not.toHaveBeenCalled()
  })

  it('shows an error when the active file is not a .spec.js file', async () => {
    vscode.window.activeTextEditor = { document: { uri: { fsPath: '/ws/notes.txt' } } }
    const handler = getHandler()

    await handler()

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: This command only works on .spec.js files.')
  })

  it('shows an error when no workspace folder is open', async () => {
    vscode.workspace.workspaceFolders = undefined
    const handler = getHandler()

    await handler()

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Please open a workspace folder first.')
  })
})

describe('playbackScript command — setup and parameter parsing', () => {
  it('calls ensurePlaywrightConfig with the workspace path and extension path', async () => {
    getHandler('/my-ext')()
    await flush()

    expect(ensurePlaywrightConfig).toHaveBeenCalledWith(WORKSPACE, '/my-ext')
  })

  it('splits credential params from data params and dedupes repeats', async () => {
    fs.readFileSync.mockImplementation((p) => {
      if (p === SPEC_PATH) return "config.get('username'); config.get('username'); config.get('amount');"
      return ''
    })
    const { panel } = await openForm()

    expect(panel.webview.html).toContain('id="param-username"')
    expect(panel.webview.html).toContain('id="param-amount"')
    expect(panel.webview.html).toContain('Custom Parameters')
    expect((panel.webview.html.match(/id="param-username"/g) || []).length).toBe(1)
    expect(panel.webview.html).toContain('id="run-btn" disabled')
  })

  it('renders a password input type for the password credential param', async () => {
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "config.get('password')" : ''))
    const { panel } = await openForm()

    expect(panel.webview.html).toContain('type="password" id="param-password"')
  })

  it('renders "No parameters required" when the spec has no config.get calls', async () => {
    const { panel } = await openForm()

    expect(panel.webview.html).toContain('No parameters required')
  })

  it('renders no user CSV dropdown options when none exist, and an option per file when they do', async () => {
    const { panel: emptyPanel } = await openForm()
    expect(emptyPanel.webview.html).not.toContain('data-value="users.csv"')

    // A fresh panel is required to observe the updated file list — the same
    // spec path would just reveal the existing (stale) panel instead.
    const otherSpec = path.join(WORKSPACE, 'test-plans', 'playwright', 'other.spec.js')
    vscode.window.activeTextEditor = { document: { uri: { fsPath: otherSpec } } }
    fs.existsSync.mockImplementation((p) => p === USERS_DIR)
    fs.readdirSync.mockImplementation((p) => (p === USERS_DIR ? ['users.csv'] : []))
    const { panel: existsPanel } = await openForm()
    expect(existsPanel.webview.html).toContain('data-value="users.csv"')
  })

  it('renders no data CSV dropdown options when none exist, and an option per file when they do', async () => {
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "config.get('amount')" : ''))
    const { panel: emptyPanel } = await openForm()
    expect(emptyPanel.webview.html).not.toContain('data-value="data.csv"')

    // A fresh panel is required to observe the updated file list — the same
    // spec path would just reveal the existing (stale) panel instead.
    const otherSpec = path.join(WORKSPACE, 'test-plans', 'playwright', 'other.spec.js')
    vscode.window.activeTextEditor = { document: { uri: { fsPath: otherSpec } } }
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH || p === otherSpec ? "config.get('amount')" : ''))
    fs.existsSync.mockImplementation((p) => p === DATA_DIR)
    fs.readdirSync.mockImplementation((p) => (p === DATA_DIR ? ['data.csv'] : []))
    const { panel: existsPanel } = await openForm()
    expect(existsPanel.webview.html).toContain('data-value="data.csv"')
  })
})

describe('playbackScript command — CLI org listing', () => {
  it('passes the resolved orgs to the form when listSalesforceCliOrgs succeeds', async () => {
    listSalesforceCliOrgs.mockResolvedValue([
      { username: 'user@org.com', alias: 'MyOrg', instanceUrl: 'https://org.my.salesforce.com' }
    ])
    const { panel } = await openForm()

    expect(panel.webview.html).toContain('MyOrg')
    expect(panel.webview.html).toContain('user@org.com')
  })

  it('falls back to an org username label when no alias is present', async () => {
    listSalesforceCliOrgs.mockResolvedValue([
      { username: 'plain@org.com', instanceUrl: 'https://org.my.salesforce.com' }
    ])
    const { panel } = await openForm()

    expect(panel.webview.html).toContain('plain@org.com')
  })

  it('records the error message and shows no orgs when listSalesforceCliOrgs rejects', async () => {
    listSalesforceCliOrgs.mockRejectedValue(new Error('sf CLI not found'))
    const { panel } = await openForm()

    expect(panel.webview.html).toContain('sf CLI not found')
  })
})

describe('showPlaybackForm — panel lifecycle', () => {
  it('reveals the existing panel instead of creating a new one for the same spec', async () => {
    const first = await openForm()
    getHandler()()
    await flush()

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)
    expect(first.panel.reveal).toHaveBeenCalledWith(vscode.ViewColumn.Active)
  })

  it('disposes the old panel and creates a new one for a different spec', async () => {
    const first = await openForm()
    vscode.window.activeTextEditor = { document: { uri: { fsPath: path.join(WORKSPACE, 'test-plans', 'playwright', 'other.spec.js') } } }
    fs.existsSync.mockImplementation((p) => p === path.join(WORKSPACE, 'test-plans', 'playwright', 'other.spec.js'))

    getHandler()()
    await flush()

    expect(first.panel.dispose).toHaveBeenCalled()
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2)
  })

  it('resolves without starting playback when the panel is disposed without a run/cancel message', async () => {
    const { resultPromise, onDispose } = await openForm()

    onDispose()
    const result = await resultPromise

    expect(result).toBeUndefined()
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled()
    const usersWatcher = vscode.workspace.createFileSystemWatcher.mock.results[0].value
    const dataWatcher = vscode.workspace.createFileSystemWatcher.mock.results[1].value
    expect(usersWatcher.dispose).toHaveBeenCalled()
    expect(dataWatcher.dispose).toHaveBeenCalled()
  })

  it('does not resolve twice when disposed after already resolving via cancel', async () => {
    const { resultPromise, onMessage, onDispose } = await openForm()

    onMessage({ type: 'cancel' })
    onDispose()

    await expect(resultPromise).resolves.toBeUndefined()
  })

  it('does nothing further when the form is cancelled', async () => {
    const { resultPromise, onMessage, onDispose } = await openForm()

    onMessage({ type: 'cancel' })
    onDispose()
    await resultPromise
    await flush()

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled()
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      'salesforce-ui-script-recorder.viewResults',
      expect.anything()
    )
  })
})

describe('showPlaybackForm — webview messages', () => {
  it('opens the spec file when it exists', async () => {
    fs.existsSync.mockImplementation((p) => p === SPEC_PATH)
    const { onMessage } = await openForm()

    onMessage({ type: 'openSpecFile' })
    await flush()

    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(SPEC_PATH)
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(expect.anything(), { preview: false, preserveFocus: false })
  })

  it('does not open the spec file when it no longer exists', async () => {
    const { onMessage } = await openForm()

    onMessage({ type: 'openSpecFile' })
    await flush()

    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
  })

  it('opens the results viewer history for this spec', async () => {
    const { onMessage } = await openForm()

    onMessage({ type: 'openHistory' })

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'salesforce-ui-script-recorder.viewResults',
      vscode.Uri.file(SPEC_PATH)
    )
  })

  it('opens an arbitrary workspace file when it exists', async () => {
    const target = path.join(WORKSPACE, 'data-files', 'data.csv')
    fs.existsSync.mockImplementation((p) => p === target)
    const { onMessage } = await openForm()

    onMessage({ type: 'openFile', data: path.join('data-files', 'data.csv') })
    await flush()

    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(target)
  })

  it('does not open an arbitrary workspace file when it does not exist', async () => {
    const { onMessage } = await openForm()

    onMessage({ type: 'openFile', data: path.join('data-files', 'missing.csv') })
    await flush()

    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
  })

  it('reveals a file section folder', async () => {
    const { onMessage } = await openForm()

    onMessage({ type: 'revealFolder', data: 'user-files' })

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('salesforce-ui-script-recorder.revealFileSection', 'user-files')
  })

  it('re-renders with the switched recording context when the target spec exists', async () => {
    fs.existsSync.mockImplementation((p) => p === RECORDINGS_DIR || p === path.join(RECORDINGS_DIR, 'other.spec.js'))
    fs.readFileSync.mockImplementation((p) => (p === path.join(RECORDINGS_DIR, 'other.spec.js') ? "config.get('other_param')" : ''))
    fs.readdirSync.mockImplementation((p) => (p === RECORDINGS_DIR ? ['other.spec.js'] : []))
    const { onMessage, panel } = await openForm()

    onMessage({ type: 'switchRecording', data: 'other' })

    expect(panel.webview.html).toContain('id="param-other_param"')
  })

  it('recomputes user/data CSV file lists and metadata when switching to a different recording', async () => {
    const otherSpec = path.join(RECORDINGS_DIR, 'other.spec.js')
    fs.existsSync.mockImplementation((p) => p === RECORDINGS_DIR || p === otherSpec || p === USERS_DIR || p === DATA_DIR)
    fs.readFileSync.mockImplementation((p) => {
      if (p === otherSpec) return "config.get('amount')"
      if (p === path.join(USERS_DIR, 'users.csv')) return 'username\nalice\n'
      if (p === path.join(DATA_DIR, 'data.csv')) return 'amount\n1\n'
      return ''
    })
    fs.readdirSync.mockImplementation((p) => {
      if (p === RECORDINGS_DIR) return ['other.spec.js']
      if (p === USERS_DIR) return ['users.csv']
      if (p === DATA_DIR) return ['data.csv']
      return []
    })
    const { onMessage, panel } = await openForm()

    onMessage({ type: 'switchRecording', data: 'other' })

    expect(panel.webview.html).toContain('data-value="users.csv"')
    expect(panel.webview.html).toContain('data-value="data.csv"')
  })

  it('treats an empty data CSV file as having no columns when switching recordings', async () => {
    const otherSpec = path.join(RECORDINGS_DIR, 'other.spec.js')
    fs.existsSync.mockImplementation((p) => p === RECORDINGS_DIR || p === otherSpec || p === DATA_DIR)
    fs.readFileSync.mockImplementation((p) => {
      if (p === otherSpec) return "config.get('amount')"
      if (p === path.join(DATA_DIR, 'data.csv')) return ''
      return ''
    })
    fs.readdirSync.mockImplementation((p) => {
      if (p === RECORDINGS_DIR) return ['other.spec.js']
      if (p === DATA_DIR) return ['data.csv']
      return []
    })
    const { onMessage, panel } = await openForm()

    onMessage({ type: 'switchRecording', data: 'other' })

    expect(panel.webview.html).toContain('data-columns="[]"')
  })

  it('ignores webview messages with an unrecognized type', async () => {
    const { onMessage, panel } = await openForm()
    const before = panel.webview.html

    onMessage({ type: 'unknownMessageType' })

    expect(panel.webview.html).toBe(before)
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled()
  })

  it('does nothing when switching to a recording whose spec file does not exist', async () => {
    const { onMessage, panel } = await openForm()
    const before = panel.webview.html

    onMessage({ type: 'switchRecording', data: 'missing' })

    expect(panel.webview.html).toBe(before)
  })

  it('tracks mode, data-selection, user-selection and org-selection state across a refresh', async () => {
    listSalesforceCliOrgs.mockResolvedValue([{ username: 'org@x.com', alias: 'X', instanceUrl: 'https://x.my.salesforce.com' }])
    fs.existsSync.mockImplementation((p) => p === DATA_DIR)
    fs.readFileSync.mockImplementation((p) => {
      if (p === SPEC_PATH) return "config.get('amount')"
      if (p === path.join(DATA_DIR, 'data.csv')) return 'amount\n1\n'
      return ''
    })
    fs.readdirSync.mockImplementation((p) => (p === DATA_DIR ? ['data.csv'] : []))
    const { onMessage, panel } = await openForm()

    onMessage({ type: 'modeChange', data: 'bulk' })
    onMessage({ type: 'dataSelectionChange', data: ['data.csv'] })
    onMessage({ type: 'userSelectionChange', data: 'users.csv' })
    onMessage({ type: 'orgSelectionChange', data: 'org@x.com' })
    fireUsersWatcherChange()

    expect(panel.webview.html).toContain('id="bulk-content" class="mode-content active"')
    expect(panel.webview.html).toContain('data-value="data.csv"')
    expect(panel.webview.html).toContain('org@x.com" selected')
  })

  it('clears the selected org when orgSelectionChange receives an empty value', async () => {
    listSalesforceCliOrgs.mockResolvedValue([{ username: 'org@x.com', alias: 'X', instanceUrl: 'https://x.my.salesforce.com' }])
    const { onMessage, panel } = await openForm()

    onMessage({ type: 'orgSelectionChange', data: 'org@x.com' })
    onMessage({ type: 'orgSelectionChange', data: '' })
    fireUsersWatcherChange()

    expect(panel.webview.html).not.toContain('selected>X')
  })

  it('generates a users CSV with the given filename and default credential columns', async () => {
    const { onMessage } = await openForm()

    onMessage({ type: 'generateUsersFile', data: { filename: 'creds.csv' } })
    await flush()

    expect(fs.mkdirSync).toHaveBeenCalledWith(USERS_DIR, { recursive: true })
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(USERS_DIR, 'creds.csv'),
      'username,password\nuser1@example.com,changeme123\n',
      'utf-8'
    )
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Created user-files/creds.csv')
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(expect.anything(), vscode.ViewColumn.Beside)
  })

  it('defaults the users CSV filename to users.csv when none is given', async () => {
    const { onMessage } = await openForm()

    onMessage({ type: 'generateUsersFile', data: {} })
    await flush()

    expect(fs.writeFileSync).toHaveBeenCalledWith(path.join(USERS_DIR, 'users.csv'), expect.anything(), 'utf-8')
  })

  it('uses the spec credential params as users CSV columns when present', async () => {
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "config.get('email')" : ''))
    const { onMessage } = await openForm()

    onMessage({ type: 'generateUsersFile', data: { filename: 'u.csv' } })
    await flush()

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(USERS_DIR, 'u.csv'),
      'email\nuser1@example.com\n',
      'utf-8'
    )
  })

  it('generates a data CSV using explicit columns from the wizard message', async () => {
    const { onMessage } = await openForm()

    onMessage({ type: 'generateDataFile', data: { filename: 'd.csv', columns: ['foo', 'bar'] } })
    await flush()

    expect(fs.mkdirSync).toHaveBeenCalledWith(DATA_DIR, { recursive: true })
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(DATA_DIR, 'd.csv'),
      'foo,bar\nsample_foo,sample_bar\n',
      'utf-8'
    )
  })

  it('defaults the data CSV filename and columns when neither is given, falling back to the spec data params', async () => {
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "config.get('amount')" : ''))
    const { onMessage } = await openForm()

    onMessage({ type: 'generateDataFile', data: {} })
    await flush()

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(DATA_DIR, 'data.csv'),
      'amount\nsample_amount\n',
      'utf-8'
    )
  })

  it('uses generic param1/param2 data columns when the spec has no data params and none are given', async () => {
    const { onMessage } = await openForm()

    onMessage({ type: 'generateDataFile', data: {} })
    await flush()

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(DATA_DIR, 'data.csv'),
      'param1,param2\nsample_param1,sample_param2\n',
      'utf-8'
    )
  })
})

describe('playbackScript command — single-mode run', () => {
  it('appends --headed to playwright args when headed is true', async () => {
    const form = await openForm()

    await finishRun(form, { params: {}, headed: true, org: null })

    const task = vscode.tasks.executeTask.mock.calls[0][0]
    expect(task.execution.commandLine).toBe('npx playwright test demo.spec.js --headed')
  })

  it('omits --headed from playwright args when headed is false', async () => {
    const form = await openForm()

    await finishRun(form, { params: {}, headed: false, org: null })

    const task = vscode.tasks.executeTask.mock.calls[0][0]
    expect(task.execution.commandLine).toBe('npx playwright test demo.spec.js')
  })

  it('sets the headless env var when headed is explicitly false', async () => {
    const form = await openForm()

    await finishRun(form, { params: {}, headed: false, org: null })

    const task = vscode.tasks.executeTask.mock.calls[0][0]
    expect(task.execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_HEADLESS).toBe('1')
  })

  it('omits the headless env var when headed is true', async () => {
    const form = await openForm()

    await finishRun(form, { params: {}, headed: true, org: null })

    const task = vscode.tasks.executeTask.mock.calls[0][0]
    expect(task.execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_HEADLESS).toBeUndefined()
  })

  it('sets the org env var when an org is selected', async () => {
    const form = await openForm()

    await finishRun(form, { params: {}, headed: true, org: 'org@x.com' })

    const task = vscode.tasks.executeTask.mock.calls[0][0]
    expect(task.execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_ORG).toBe('org@x.com')
  })

  it('omits the org env var when no org is selected', async () => {
    const form = await openForm()

    await finishRun(form, { params: {}, headed: true, org: null })

    const task = vscode.tasks.executeTask.mock.calls[0][0]
    expect(task.execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_ORG).toBeUndefined()
  })

  it('maps each param onto an uppercase env var and caches non-empty values', async () => {
    const form = await openForm()

    await finishRun(form, { params: { username: 'bob', password: '' }, headed: true, org: null })

    const task = vscode.tasks.executeTask.mock.calls[0][0]
    expect(task.execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_USERNAME).toBe('bob')
    expect(task.execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_PASSWORD).toBe('')
  })

  it('pre-fills cached param values on a subsequent playback of the same spec', async () => {
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "config.get('username')" : ''))
    const first = await openForm()
    await finishRun(first, { params: { username: 'cached-bob' }, headed: true, org: null })
    await completeTask()

    const second = await openForm()

    expect(second.panel.webview.html).toContain('value="cached-bob"')
  })

  it('does not cache empty param values', async () => {
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "config.get('username')" : ''))
    const first = await openForm()
    await finishRun(first, { params: { username: '' }, headed: true, org: null })
    await completeTask()

    const second = await openForm()

    expect(second.panel.webview.html).toContain('value=""')
  })

  it('executes viewResults with single-mode in-progress metadata', async () => {
    const form = await openForm()

    await finishRun(form, { params: {}, headed: true, org: null })

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('salesforce-ui-script-recorder.viewResults', {
      specUri: vscode.Uri.file(SPEC_PATH),
      inProgress: expect.objectContaining({ specName: 'demo', mode: 'single', sessions: 1 })
    })
  })

  it('runs against the switched recording spec when one was selected before running', async () => {
    const otherSpec = path.join(RECORDINGS_DIR, 'other.spec.js')
    fs.existsSync.mockImplementation((p) => p === RECORDINGS_DIR || p === otherSpec)
    fs.readdirSync.mockImplementation((p) => (p === RECORDINGS_DIR ? ['other.spec.js'] : []))
    const form = await openForm()
    form.onMessage({ type: 'switchRecording', data: 'other' })

    await finishRun(form, { params: {}, headed: false, org: null })

    const task = vscode.tasks.executeTask.mock.calls[0][0]
    expect(task.execution.commandLine).toBe('npx playwright test other.spec.js')
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'salesforce-ui-script-recorder.viewResults',
      expect.objectContaining({ specUri: vscode.Uri.file(otherSpec) })
    )
  })

  it('resolves an auth state file for the username and sets the env var', async () => {
    fs.existsSync.mockImplementation((p) => p === AUTH_DIR || p === path.join(AUTH_DIR, 'login.example.com---bob.json'))
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "page.goto('https://login.example.com/app')" : ''))
    const form = await openForm()

    await finishRun(form, { params: { username: 'bob' }, headed: true, org: null })

    const task = vscode.tasks.executeTask.mock.calls[0][0]
    expect(task.execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_AUTH_STATE).toBe(path.join(AUTH_DIR, 'login.example.com---bob.json'))
  })

  it('does not set an auth state env var when no username is provided', async () => {
    fs.existsSync.mockImplementation((p) => p === AUTH_DIR)
    const form = await openForm()

    await finishRun(form, { params: {}, headed: true, org: null })

    const task = vscode.tasks.executeTask.mock.calls[0][0]
    expect(task.execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_AUTH_STATE).toBeUndefined()
  })
})

describe('resolveAuthState', () => {
  async function runWithUsername(username) {
    const form = await openForm()
    await finishRun(form, { params: { username }, headed: true, org: null })
    return vscode.tasks.executeTask.mock.calls[0][0].execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_AUTH_STATE
  }

  it('returns undefined when the auth-states directory does not exist', async () => {
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "page.goto('https://login.example.com/app')" : ''))

    expect(await runWithUsername('bob')).toBeUndefined()
  })

  it('returns undefined when the spec has no page.goto call', async () => {
    fs.existsSync.mockImplementation((p) => p === AUTH_DIR)

    expect(await runWithUsername('bob')).toBeUndefined()
  })

  it('returns undefined when the goto URL fails to parse', async () => {
    fs.existsSync.mockImplementation((p) => p === AUTH_DIR)
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "page.goto('not a url')" : ''))

    expect(await runWithUsername('bob')).toBeUndefined()
  })

  it('sanitizes unsafe characters in the username before building the filename', async () => {
    const sanitized = path.join(AUTH_DIR, 'login.example.com---bob_at_x.json')
    fs.existsSync.mockImplementation((p) => p === AUTH_DIR || p === sanitized)
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "page.goto('https://login.example.com/app')" : ''))

    expect(await runWithUsername('bob:at/x')).toBe(sanitized)
  })

  it('falls back to any auth state file matching just the hostname', async () => {
    fs.existsSync.mockImplementation((p) => p === AUTH_DIR)
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "page.goto('https://login.example.com/app')" : ''))
    fs.readdirSync.mockImplementation((p) => (p === AUTH_DIR ? ['login.example.com---someone-else.json', 'other.host---x.json'] : []))

    expect(await runWithUsername('bob')).toBe(path.join(AUTH_DIR, 'login.example.com---someone-else.json'))
  })

  it('returns undefined when the fallback readdir finds no hostname match', async () => {
    fs.existsSync.mockImplementation((p) => p === AUTH_DIR)
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "page.goto('https://login.example.com/app')" : ''))
    fs.readdirSync.mockImplementation((p) => (p === AUTH_DIR ? ['other.host---x.json'] : []))

    expect(await runWithUsername('bob')).toBeUndefined()
  })

  it('returns undefined when the fallback readdir throws', async () => {
    fs.existsSync.mockImplementation((p) => p === AUTH_DIR)
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "page.goto('https://login.example.com/app')" : ''))
    fs.readdirSync.mockImplementation((p) => {
      if (p === AUTH_DIR) throw new Error('EACCES')
      return []
    })

    expect(await runWithUsername('bob')).toBeUndefined()
  })

  it('resolves the username from an email param when username is absent', async () => {
    const sanitized = path.join(AUTH_DIR, 'login.example.com---bob@example.com.json')
    fs.existsSync.mockImplementation((p) => p === AUTH_DIR || p === sanitized)
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "page.goto('https://login.example.com/app')" : ''))
    const form = await openForm()

    await finishRun(form, { params: { email: 'bob@example.com' }, headed: true, org: null })

    expect(vscode.tasks.executeTask.mock.calls[0][0].execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_AUTH_STATE).toBe(sanitized)
  })
})

describe('playbackScript command — bulk-mode run', () => {
  function mockCsv(filePath, content) {
    fs.readFileSync.mockImplementation((p) => (p === filePath ? content : ''))
  }

  it('spawns one task per session with cycling user rows and merged data rows', async () => {
    fs.existsSync.mockImplementation((p) => p === USERS_DIR || p === DATA_DIR)
    fs.readFileSync.mockImplementation((p) => {
      if (p === path.join(USERS_DIR, 'users.csv')) return 'username,password\nalice,pw1\n'
      if (p === path.join(DATA_DIR, 'data.csv')) return 'amount\n42\n'
      return ''
    })
    const form = await openForm()

    await finishRun(form, {
      mode: 'bulk',
      parallelCount: 2,
      usersFile: 'users.csv',
      dataFiles: ['data.csv'],
      headed: true,
      org: null
    })

    expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(2)
    const [task0] = vscode.tasks.executeTask.mock.calls[0]
    const [task1] = vscode.tasks.executeTask.mock.calls[1]
    expect(task0.execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_USERNAME).toBe('alice')
    expect(task1.execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_USERNAME).toBe('alice')
    expect(task0.execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_AMOUNT).toBe('42')
    expect(task0.execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_SESSION_INDEX).toBe('1')
    expect(task1.execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_SESSION_INDEX).toBe('2')
    expect(task0.execution.commandLine).toContain('--output')
    expect(task0.execution.commandLine).toContain('session-1')
    expect(task1.execution.commandLine).toContain('session-2')
  })

  it('shares the same batch id and timestamp env vars across all sessions', async () => {
    fs.existsSync.mockImplementation((p) => p === USERS_DIR)
    mockCsv(path.join(USERS_DIR, 'users.csv'), 'username\nalice\nbob\n')
    const form = await openForm()

    await finishRun(form, { mode: 'bulk', parallelCount: 2, usersFile: 'users.csv', dataFiles: [], headed: true, org: null })

    const env0 = vscode.tasks.executeTask.mock.calls[0][0].execution.options.env
    const env1 = vscode.tasks.executeTask.mock.calls[1][0].execution.options.env
    expect(env0.SALESFORCE_UI_SCRIPT_RECORDER_BATCH_ID).toBe(env1.SALESFORCE_UI_SCRIPT_RECORDER_BATCH_ID)
    expect(env0.SALESFORCE_UI_SCRIPT_RECORDER_BATCH_TIMESTAMP).toBe(env1.SALESFORCE_UI_SCRIPT_RECORDER_BATCH_TIMESTAMP)
  })

  it('merges multiple data files by row index', async () => {
    fs.existsSync.mockImplementation((p) => p === DATA_DIR)
    fs.readFileSync.mockImplementation((p) => {
      if (p === path.join(DATA_DIR, 'a.csv')) return 'foo\n1\n'
      if (p === path.join(DATA_DIR, 'b.csv')) return 'bar\n2\n'
      return ''
    })
    const form = await openForm()

    await finishRun(form, { mode: 'bulk', parallelCount: 1, usersFile: 'users.csv', dataFiles: ['a.csv', 'b.csv'], headed: true, org: null })

    const env = vscode.tasks.executeTask.mock.calls[0][0].execution.options.env
    expect(env.SALESFORCE_UI_SCRIPT_RECORDER_FOO).toBe('1')
    expect(env.SALESFORCE_UI_SCRIPT_RECORDER_BAR).toBe('2')
  })

  it('warns when the user file has fewer rows than requested sessions, pluralizing correctly', async () => {
    fs.existsSync.mockImplementation((p) => p === USERS_DIR)
    mockCsv(path.join(USERS_DIR, 'users.csv'), 'username\nalice\n')
    const form = await openForm()

    await finishRun(form, { mode: 'bulk', parallelCount: 3, usersFile: 'users.csv', dataFiles: [], headed: true, org: null })

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Salesforce UI Script Recorder: User file has 1 row but 3 sessions requested — credentials will cycle.'
    )
  })

  it('warns when the data files have fewer rows than requested sessions, pluralizing correctly', async () => {
    fs.existsSync.mockImplementation((p) => p === DATA_DIR)
    mockCsv(path.join(DATA_DIR, 'data.csv'), 'amount\n1\n2\n')
    const form = await openForm()

    await finishRun(form, { mode: 'bulk', parallelCount: 3, usersFile: 'users.csv', dataFiles: ['data.csv'], headed: true, org: null })

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Salesforce UI Script Recorder: Data files have 2 rows but 3 sessions requested — data will cycle.'
    )
  })

  it('warns with plural wording when the user file has 2+ rows fewer than requested sessions', async () => {
    fs.existsSync.mockImplementation((p) => p === USERS_DIR)
    mockCsv(path.join(USERS_DIR, 'users.csv'), 'username\nalice\nbob\n')
    const form = await openForm()

    await finishRun(form, { mode: 'bulk', parallelCount: 3, usersFile: 'users.csv', dataFiles: [], headed: true, org: null })

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Salesforce UI Script Recorder: User file has 2 rows but 3 sessions requested — credentials will cycle.'
    )
  })

  it('sets the headless env var per session when headed is false', async () => {
    const form = await openForm()

    await finishRun(form, { mode: 'bulk', parallelCount: 1, usersFile: 'users.csv', dataFiles: [], headed: false, org: null })

    expect(vscode.tasks.executeTask.mock.calls[0][0].execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_HEADLESS).toBe('1')
  })

  it('does not warn when there are enough rows for every session', async () => {
    fs.existsSync.mockImplementation((p) => p === USERS_DIR)
    mockCsv(path.join(USERS_DIR, 'users.csv'), 'username\nalice\nbob\n')
    const form = await openForm()

    await finishRun(form, { mode: 'bulk', parallelCount: 2, usersFile: 'users.csv', dataFiles: [], headed: true, org: null })

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
  })

  it('resolves a per-session auth state from that session\'s cycled username', async () => {
    const authFile = path.join(AUTH_DIR, 'login.example.com---alice.json')
    fs.existsSync.mockImplementation((p) => p === USERS_DIR || p === AUTH_DIR || p === authFile)
    fs.readFileSync.mockImplementation((p) => {
      if (p === SPEC_PATH) return "page.goto('https://login.example.com/app')"
      if (p === path.join(USERS_DIR, 'users.csv')) return 'username\nalice\n'
      return ''
    })
    const form = await openForm()

    await finishRun(form, { mode: 'bulk', parallelCount: 1, usersFile: 'users.csv', dataFiles: [], headed: true, org: null })

    expect(vscode.tasks.executeTask.mock.calls[0][0].execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_AUTH_STATE).toBe(authFile)
  })

  it('sets the org env var per session when an org is selected', async () => {
    const form = await openForm()

    await finishRun(form, { mode: 'bulk', parallelCount: 1, usersFile: 'users.csv', dataFiles: [], headed: true, org: 'org@x.com' })

    expect(vscode.tasks.executeTask.mock.calls[0][0].execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_ORG).toBe('org@x.com')
  })

  it('executes viewResults with bulk-mode in-progress metadata', async () => {
    const form = await openForm()

    await finishRun(form, { mode: 'bulk', parallelCount: 2, usersFile: 'users.csv', dataFiles: [], headed: true, org: null })

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('salesforce-ui-script-recorder.viewResults', {
      specUri: vscode.Uri.file(SPEC_PATH),
      inProgress: expect.objectContaining({ specName: 'demo', mode: 'bulk', sessions: 2, bulkFolder: expect.stringContaining('---BULK') })
    })
  })
})

describe('parseCsv edge cases (via bulk mode)', () => {
  it('returns no rows for a file with only a header line', async () => {
    fs.existsSync.mockImplementation((p) => p === USERS_DIR)
    fs.readFileSync.mockImplementation((p) => (p === path.join(USERS_DIR, 'users.csv') ? 'username\n' : ''))
    const form = await openForm()

    await finishRun(form, { mode: 'bulk', parallelCount: 1, usersFile: 'users.csv', dataFiles: [], headed: true, org: null })

    expect(vscode.tasks.executeTask.mock.calls[0][0].execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_USERNAME).toBeUndefined()
  })

  it('fills missing trailing values with an empty string', async () => {
    fs.existsSync.mockImplementation((p) => p === USERS_DIR)
    fs.readFileSync.mockImplementation((p) => (p === path.join(USERS_DIR, 'users.csv') ? 'username,password\nalice\n' : ''))
    const form = await openForm()

    await finishRun(form, { mode: 'bulk', parallelCount: 1, usersFile: 'users.csv', dataFiles: [], headed: true, org: null })

    expect(vscode.tasks.executeTask.mock.calls[0][0].execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_PASSWORD).toBe('')
  })

  it('ignores blank lines in the CSV', async () => {
    fs.existsSync.mockImplementation((p) => p === USERS_DIR)
    fs.readFileSync.mockImplementation((p) => (p === path.join(USERS_DIR, 'users.csv') ? 'username\n\nalice\n\n' : ''))
    const form = await openForm()

    await finishRun(form, { mode: 'bulk', parallelCount: 1, usersFile: 'users.csv', dataFiles: [], headed: true, org: null })

    expect(vscode.tasks.executeTask.mock.calls[0][0].execution.options.env.SALESFORCE_UI_SCRIPT_RECORDER_USERNAME).toBe('alice')
  })
})

describe('runPlaybackTask — task lifecycle', () => {
  it('sets the task presentation options and definition', async () => {
    const form = await openForm()

    await finishRun(form, { params: {}, headed: true, org: null })

    const task = vscode.tasks.executeTask.mock.calls[0][0]
    expect(task.definition).toEqual({ type: 'salesforce-ui-script-recorder', task: 'Playback' })
    expect(task.name).toBe('Salesforce UI Script Recorder: Playback')
    expect(task.presentationOptions).toEqual({
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.New,
      close: false
    })
  })

  it('resets playbackInProgress and clears the results-viewer in-progress state when the single task ends', async () => {
    const form = await openForm()
    await finishRun(form, { params: {}, headed: true, org: null })

    const taskExecution = await vscode.tasks.executeTask.mock.results[0].value
    const listener = vscode.tasks.onDidEndTaskProcess.mock.calls[0][0]
    listener({ execution: taskExecution })

    expect(clearInProgress).toHaveBeenCalledTimes(1)

    // playbackInProgress is now false again — a second run should proceed past the guard.
    // (Its form never receives a message, so it's left pending rather than awaited.)
    const handler = getHandler()
    handler()
    await flush()
    expect(listSalesforceCliOrgs).toHaveBeenCalledTimes(2)
  })

  it('ignores task-end events for a different task execution', async () => {
    const form = await openForm()
    await finishRun(form, { params: {}, headed: true, org: null })

    const listener = vscode.tasks.onDidEndTaskProcess.mock.calls[0][0]
    listener({ execution: { terminate: jest.fn() } })

    expect(clearInProgress).not.toHaveBeenCalled()
  })

  it('only resets playbackInProgress once every bulk session has ended', async () => {
    const form = await openForm()
    await finishRun(form, { mode: 'bulk', parallelCount: 2, usersFile: 'users.csv', dataFiles: [], headed: true, org: null })

    const exec0 = await vscode.tasks.executeTask.mock.results[0].value
    const exec1 = await vscode.tasks.executeTask.mock.results[1].value
    vscode.tasks.onDidEndTaskProcess.mock.calls[0][0]({ execution: exec0 })
    expect(clearInProgress).not.toHaveBeenCalled()

    vscode.tasks.onDidEndTaskProcess.mock.calls[1][0]({ execution: exec1 })
    expect(clearInProgress).toHaveBeenCalledTimes(1)
  })
})

describe('specHasResults', () => {
  async function renderWithResultsDir() {
    const form = await openForm()
    form.onMessage({ type: 'modeChange', data: 'single' })
    fireUsersWatcherChange()
    return form.panel.webview.html
  }

  it('shows no history button when the results dir does not exist', async () => {
    const html = await renderWithResultsDir()
    expect(html).not.toContain('View History')
  })

  it('shows no history button when no entries match this spec name', async () => {
    fs.existsSync.mockImplementation((p) => p === RESULTS_DIR)
    fs.readdirSync.mockImplementation((p) => (p === RESULTS_DIR ? ['other---2026-01-01T00-00-00'] : []))
    const html = await renderWithResultsDir()
    expect(html).not.toContain('View History')
  })

  it('shows the history button when a matching results.json exists', async () => {
    const runDir = path.join(RESULTS_DIR, 'demo---2026-01-01T00-00-00')
    fs.existsSync.mockImplementation((p) => p === RESULTS_DIR || p === runDir || p === path.join(runDir, 'results.json'))
    fs.readdirSync.mockImplementation((p) => (p === RESULTS_DIR ? ['demo---2026-01-01T00-00-00'] : []))
    fs.statSync.mockImplementation(() => ({ isDirectory: () => true }))
    const html = await renderWithResultsDir()
    expect(html).toContain('View History')
  })

  it('shows no history button when a matching directory has neither results.json nor a BULK suffix', async () => {
    const runDir = path.join(RESULTS_DIR, 'demo---2026-01-01T00-00-00')
    fs.existsSync.mockImplementation((p) => p === RESULTS_DIR || p === runDir)
    fs.readdirSync.mockImplementation((p) => (p === RESULTS_DIR ? ['demo---2026-01-01T00-00-00'] : []))
    fs.statSync.mockImplementation(() => ({ isDirectory: () => true }))
    const html = await renderWithResultsDir()
    expect(html).not.toContain('View History')
  })

  it('shows no history button when the matching entry is not a directory', async () => {
    const runDir = path.join(RESULTS_DIR, 'demo---2026-01-01T00-00-00')
    fs.existsSync.mockImplementation((p) => p === RESULTS_DIR || p === runDir)
    fs.readdirSync.mockImplementation((p) => (p === RESULTS_DIR ? ['demo---2026-01-01T00-00-00'] : []))
    fs.statSync.mockImplementation(() => ({ isDirectory: () => false }))
    const html = await renderWithResultsDir()
    expect(html).not.toContain('View History')
  })

  it('shows the history button when a BULK folder has a session with results.json', async () => {
    const bulkDir = path.join(RESULTS_DIR, 'demo---2026-01-01T00-00-00---BULK')
    const sessionResults = path.join(bulkDir, 'session-1', 'results.json')
    fs.existsSync.mockImplementation((p) => p === RESULTS_DIR || p === bulkDir || p === sessionResults)
    fs.readdirSync.mockImplementation((p) => {
      if (p === RESULTS_DIR) return ['demo---2026-01-01T00-00-00---BULK']
      if (p === bulkDir) return ['session-1']
      return []
    })
    fs.statSync.mockImplementation(() => ({ isDirectory: () => true }))
    const html = await renderWithResultsDir()
    expect(html).toContain('View History')
  })

  it('shows no history button when a BULK folder has no session with results.json', async () => {
    const bulkDir = path.join(RESULTS_DIR, 'demo---2026-01-01T00-00-00---BULK')
    fs.existsSync.mockImplementation((p) => p === RESULTS_DIR || p === bulkDir)
    fs.readdirSync.mockImplementation((p) => {
      if (p === RESULTS_DIR) return ['demo---2026-01-01T00-00-00---BULK']
      if (p === bulkDir) return ['session-1']
      return []
    })
    fs.statSync.mockImplementation(() => ({ isDirectory: () => true }))
    const html = await renderWithResultsDir()
    expect(html).not.toContain('View History')
  })

  it('treats a statSync failure on a matching entry as no results', async () => {
    fs.existsSync.mockImplementation((p) => p === RESULTS_DIR)
    fs.readdirSync.mockImplementation((p) => (p === RESULTS_DIR ? ['demo---2026-01-01T00-00-00'] : []))
    fs.statSync.mockImplementation(() => { throw new Error('ENOENT') })
    const html = await renderWithResultsDir()
    expect(html).not.toContain('View History')
  })

  it('treats a readdirSync failure on the results dir as no results', async () => {
    fs.existsSync.mockImplementation((p) => p === RESULTS_DIR)
    fs.readdirSync.mockImplementation((p) => {
      if (p === RESULTS_DIR) throw new Error('EACCES')
      return []
    })
    const html = await renderWithResultsDir()
    expect(html).not.toContain('View History')
  })
})

describe('getWebviewHtml — remaining rendering branches', () => {
  it('marks the current recording as selected in the recording dropdown', async () => {
    fs.existsSync.mockImplementation((p) => p === RECORDINGS_DIR)
    fs.readdirSync.mockImplementation((p) => (p === RECORDINGS_DIR ? ['demo.spec.js', 'other.spec.js'] : []))
    const { panel } = await openForm()

    expect(panel.webview.html).toContain('value="demo" selected')
    expect(panel.webview.html).toContain('value="other">other')
  })

  it('marks a selected user CSV file option and hides a selected data CSV option in bulk mode', async () => {
    fs.existsSync.mockImplementation((p) => p === USERS_DIR || p === DATA_DIR)
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "config.get('amount')" : ''))
    fs.readdirSync.mockImplementation((p) => {
      if (p === USERS_DIR) return ['users.csv']
      if (p === DATA_DIR) return ['data.csv']
      return []
    })
    const { onMessage, panel } = await openForm()

    onMessage({ type: 'userSelectionChange', data: 'users.csv' })
    onMessage({ type: 'dataSelectionChange', data: ['data.csv'] })
    fireUsersWatcherChange()

    expect(panel.webview.html).toContain('multi-select-option selected')
    expect(panel.webview.html).toContain('multi-select-option hidden')
  })

  it('renders singular "1 user account loaded" when the selected user file has exactly one row', async () => {
    fs.existsSync.mockImplementation((p) => p === USERS_DIR)
    fs.readFileSync.mockImplementation((p) => (p === path.join(USERS_DIR, 'users.csv') ? 'username\nalice\n' : ''))
    fs.readdirSync.mockImplementation((p) => (p === USERS_DIR ? ['users.csv'] : []))
    const { onMessage, panel } = await openForm()

    onMessage({ type: 'userSelectionChange', data: 'users.csv' })
    fireUsersWatcherChange()

    expect(panel.webview.html).toContain('1 user account loaded')
  })

  it('renders the run button enabled when the spec has no params', async () => {
    const { panel } = await openForm()
    expect(panel.webview.html).not.toContain('id="run-btn" disabled')
  })

  it('re-renders via the data-files watcher onDidCreate handler too', async () => {
    fs.existsSync.mockImplementation((p) => p === DATA_DIR)
    fs.readFileSync.mockImplementation((p) => (p === SPEC_PATH ? "config.get('amount')" : ''))
    const { panel } = await openForm()
    fs.readdirSync.mockImplementation((p) => (p === DATA_DIR ? ['fresh.csv'] : []))

    fireDataWatcherCreate()

    expect(panel.webview.html).toContain('data-value="fresh.csv"')
  })

  it('does not refresh the panel from watcher events after the form has already resolved', async () => {
    const form = await openForm()
    await finishRun(form, { params: {}, headed: true, org: null })
    const htmlBeforeWatcherFire = form.panel.webview.html

    fs.readdirSync.mockReturnValue(['should-not-appear.csv'])
    fireUsersWatcherChange()

    expect(form.panel.webview.html).toBe(htmlBeforeWatcherFire)
  })
})
