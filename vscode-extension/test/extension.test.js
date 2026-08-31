jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn(),
  renameSync: jest.fn(),
  unlinkSync: jest.fn(),
  rmSync: jest.fn()
}))
jest.mock('../recording-codelens-provider', () => ({
  RecordingCodeLensProvider: jest.fn().mockImplementation(() => ({ refresh: jest.fn() }))
}))
jest.mock('../recordings-tree-provider', () => ({
  RecordingsTreeProvider: jest.fn().mockImplementation(() => ({ refresh: jest.fn(), findResultElement: jest.fn() }))
}))
jest.mock('../file-list-tree-provider', () => ({
  FileListTreeProvider: jest.fn().mockImplementation(() => ({ refresh: jest.fn(), getFirstChild: jest.fn() }))
}))
jest.mock('../commands/start-recording', () => ({ register: jest.fn() }))
jest.mock('../commands/playback', () => ({ register: jest.fn() }))
jest.mock('../commands/parameterize', () => ({ register: jest.fn() }))
jest.mock('../commands/reconvert', () => ({ register: jest.fn() }))
jest.mock('../commands/install-mcp-config', () => ({ register: jest.fn() }))
jest.mock('../commands/results-viewer', () => ({ register: jest.fn() }))
jest.mock('../trigger-watcher', () => ({ register: jest.fn() }))
jest.mock('../decorations', () => ({ register: jest.fn() }))

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { RecordingCodeLensProvider } = require('../recording-codelens-provider')
const { RecordingsTreeProvider } = require('../recordings-tree-provider')
const { FileListTreeProvider } = require('../file-list-tree-provider')
const startRecording = require('../commands/start-recording')
const playback = require('../commands/playback')
const parameterize = require('../commands/parameterize')
const reconvert = require('../commands/reconvert')
const installMcpConfig = require('../commands/install-mcp-config')
const resultsViewer = require('../commands/results-viewer')
const triggerWatcher = require('../trigger-watcher')
const decorations = require('../decorations')
const { activate, deactivate } = require('../extension')

afterEach(() => {
  jest.clearAllMocks()
  vscode.workspace.workspaceFolders = undefined
})

function activateExtension() {
  const context = { subscriptions: [], extensionPath: '/ext' }
  activate(context)
  return { context }
}

function getCommandHandler(name) {
  const call = vscode.commands.registerCommand.mock.calls.find(([n]) => n === name)
  return call[1]
}

function latestCodeLensProvider() {
  return RecordingCodeLensProvider.mock.results.at(-1).value
}

function latestRecordingsTree() {
  return RecordingsTreeProvider.mock.results.at(-1).value
}

function latestFileTrees() {
  const results = FileListTreeProvider.mock.results
  return { userFilesTree: results[0].value, dataFilesTree: results[1].value }
}

function watcherAt(index) {
  return vscode.workspace.createFileSystemWatcher.mock.results[index].value
}

function fire(watcher, event) {
  const handler = watcher[event].mock.calls[0][0]
  handler()
}

describe('activate — setup', () => {
  it('creates the output channel', () => {
    activateExtension()

    expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('Salesforce UI Script Recorder')
  })

  it('registers the codelens provider for both json and spec.js patterns using the same instance', () => {
    activateExtension()

    const provider = latestCodeLensProvider()
    expect(vscode.languages.registerCodeLensProvider).toHaveBeenCalledWith(
      { language: 'json', pattern: '**/test-plans/playwright/*.json' },
      provider
    )
    expect(vscode.languages.registerCodeLensProvider).toHaveBeenCalledWith(
      { language: 'javascript', pattern: '**/test-plans/playwright/*.spec.js' },
      provider
    )
  })

  it('creates the three sidebar tree views', () => {
    activateExtension()

    const recordingsTree = latestRecordingsTree()
    const { userFilesTree, dataFilesTree } = latestFileTrees()
    expect(vscode.window.createTreeView).toHaveBeenCalledWith('salesforceUiScriptRecorderRecordings', { treeDataProvider: recordingsTree, showCollapseAll: true })
    expect(vscode.window.createTreeView).toHaveBeenCalledWith('salesforceUiScriptRecorderUserFiles', { treeDataProvider: userFilesTree })
    expect(vscode.window.createTreeView).toHaveBeenCalledWith('salesforceUiScriptRecorderDataFiles', { treeDataProvider: dataFilesTree })
    expect(FileListTreeProvider).toHaveBeenCalledWith('user-files')
    expect(FileListTreeProvider).toHaveBeenCalledWith('data-files')
  })

  it('registers each command module and subscribes all four fs watchers', () => {
    const { context } = activateExtension()

    expect(startRecording.register).toHaveBeenCalledWith(context, expect.anything())
    expect(playback.register).toHaveBeenCalledWith(context)
    expect(parameterize.register).toHaveBeenCalledWith(context, latestCodeLensProvider())
    expect(reconvert.register).toHaveBeenCalledWith(context)
    expect(installMcpConfig.register).toHaveBeenCalledWith(context)
    expect(resultsViewer.register).toHaveBeenCalledWith(context)
    expect(triggerWatcher.register).toHaveBeenCalledWith(context, expect.anything())
    expect(decorations.register).toHaveBeenCalledWith(context)

    for (let i = 0; i < 4; i++) {
      expect(context.subscriptions).toContain(watcherAt(i))
    }
  })
})

describe('activate — watcher refresh wiring', () => {
  it('refreshes recordings/user-files/data-files trees on recordings watcher events', () => {
    activateExtension()
    const recordingsTree = latestRecordingsTree()
    const { userFilesTree, dataFilesTree } = latestFileTrees()
    const watcher = watcherAt(0)

    for (const event of ['onDidCreate', 'onDidDelete', 'onDidChange']) {
      fire(watcher, event)
    }

    expect(recordingsTree.refresh).toHaveBeenCalledTimes(3)
    expect(userFilesTree.refresh).toHaveBeenCalledTimes(3)
    expect(dataFilesTree.refresh).toHaveBeenCalledTimes(3)
  })

  it('refreshes the codelens provider and recordings tree on results watcher events', () => {
    activateExtension()
    const provider = latestCodeLensProvider()
    const recordingsTree = latestRecordingsTree()
    const watcher = watcherAt(1)

    fire(watcher, 'onDidCreate')
    fire(watcher, 'onDidDelete')

    expect(provider.refresh).toHaveBeenCalledTimes(2)
    expect(recordingsTree.refresh).toHaveBeenCalledTimes(2)
  })

  it('refreshes only the user-files tree on user-files watcher events', () => {
    activateExtension()
    const { userFilesTree, dataFilesTree } = latestFileTrees()
    const watcher = watcherAt(2)

    for (const event of ['onDidCreate', 'onDidDelete', 'onDidChange']) {
      fire(watcher, event)
    }

    expect(userFilesTree.refresh).toHaveBeenCalledTimes(3)
    expect(dataFilesTree.refresh).not.toHaveBeenCalled()
  })

  it('refreshes only the data-files tree on data-files watcher events', () => {
    activateExtension()
    const { userFilesTree, dataFilesTree } = latestFileTrees()
    const watcher = watcherAt(3)

    for (const event of ['onDidCreate', 'onDidDelete', 'onDidChange']) {
      fire(watcher, event)
    }

    expect(dataFilesTree.refresh).toHaveBeenCalledTimes(3)
    expect(userFilesTree.refresh).not.toHaveBeenCalled()
  })
})

describe('command: viewRecordingHistory', () => {
  it('executes viewResults with the baseName when present', () => {
    activateExtension()
    const handler = getCommandHandler('salesforce-ui-script-recorder.viewRecordingHistory')

    handler({ baseName: 'demo' })

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('salesforce-ui-script-recorder.viewResults', 'demo')
  })

  it('does nothing without a treeItem or baseName', () => {
    activateExtension()
    const handler = getCommandHandler('salesforce-ui-script-recorder.viewRecordingHistory')

    handler(undefined)
    handler({})

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
  })
})

describe('command: playRecording', () => {
  it('opens the spec file and triggers playback when a workspace folder exists', async () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    activateExtension()
    const handler = getCommandHandler('salesforce-ui-script-recorder.playRecording')

    await handler({ baseName: 'demo' })

    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(path.join('/ws', 'test-plans', 'playwright', 'demo.spec.js'))
    expect(vscode.window.showTextDocument).toHaveBeenCalled()
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('salesforce-ui-script-recorder.playbackScript')
  })

  it('does nothing without a workspace folder', async () => {
    vscode.workspace.workspaceFolders = undefined
    activateExtension()
    const handler = getCommandHandler('salesforce-ui-script-recorder.playRecording')

    await handler({ baseName: 'demo' })

    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
  })

  it('does nothing without a treeItem or baseName', async () => {
    activateExtension()
    const handler = getCommandHandler('salesforce-ui-script-recorder.playRecording')

    await handler(undefined)
    await handler({})

    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
  })
})

describe('command: renameRecording', () => {
  const RECORDINGS_DIR = path.join('/ws', 'test-plans', 'playwright')
  const RESULTS_DIR = path.join('/ws', 'playback-results')

  function getHandler() {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    activateExtension()
    return getCommandHandler('salesforce-ui-script-recorder.renameRecording')
  }

  it('does nothing without a treeItem or baseName', async () => {
    const handler = getHandler()

    await handler(undefined)
    await handler({})

    expect(vscode.window.showInputBox).not.toHaveBeenCalled()
  })

  it('does nothing without a workspace folder', async () => {
    vscode.workspace.workspaceFolders = undefined
    activateExtension()
    const handler = getCommandHandler('salesforce-ui-script-recorder.renameRecording')

    await handler({ baseName: 'demo' })

    expect(vscode.window.showInputBox).not.toHaveBeenCalled()
  })

  it('returns without renaming when the name prompt is cancelled or unchanged', async () => {
    const handler = getHandler()
    vscode.window.showInputBox.mockResolvedValueOnce(undefined)
    await handler({ baseName: 'demo' })
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()

    vscode.window.showInputBox.mockResolvedValueOnce('demo')
    await handler({ baseName: 'demo' })
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
  })

  it('returns without changes when the rename confirmation is declined', async () => {
    const handler = getHandler()
    fs.existsSync.mockReturnValue(false)
    vscode.window.showInputBox.mockResolvedValueOnce('renamed')
    vscode.window.showWarningMessage.mockResolvedValueOnce(undefined)

    await handler({ baseName: 'demo' })

    expect(fs.renameSync).not.toHaveBeenCalled()
  })

  it('renames matching json/spec files and result folders on confirmation', async () => {
    const handler = getHandler()
    fs.existsSync.mockImplementation((p) => p === path.join(RECORDINGS_DIR, 'demo.json') || p === path.join(RECORDINGS_DIR, 'demo.spec.js') || p === RESULTS_DIR)
    fs.readdirSync.mockReturnValue(['demo---2026-01', 'other---2026-02'])
    vscode.window.showInputBox.mockResolvedValueOnce('renamed')
    vscode.window.showWarningMessage.mockResolvedValueOnce('Rename')

    await handler({ baseName: 'demo' })

    expect(fs.renameSync).toHaveBeenCalledWith(path.join(RECORDINGS_DIR, 'demo.json'), path.join(RECORDINGS_DIR, 'renamed.json'))
    expect(fs.renameSync).toHaveBeenCalledWith(path.join(RECORDINGS_DIR, 'demo.spec.js'), path.join(RECORDINGS_DIR, 'renamed.spec.js'))
    expect(fs.renameSync).toHaveBeenCalledWith(path.join(RESULTS_DIR, 'demo---2026-01'), path.join(RESULTS_DIR, 'renamed---2026-01'))
    expect(fs.renameSync).not.toHaveBeenCalledWith(path.join(RESULTS_DIR, 'other---2026-02'), expect.anything())
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('Renamed to "renamed"'))
  })

  it('shows an error message when a rename operation throws', async () => {
    const handler = getHandler()
    fs.existsSync.mockImplementation((p) => p === path.join(RECORDINGS_DIR, 'demo.json'))
    vscode.window.showInputBox.mockResolvedValueOnce('renamed')
    vscode.window.showWarningMessage.mockResolvedValueOnce('Rename')
    fs.renameSync.mockImplementationOnce(() => { throw new Error('disk full') })

    await handler({ baseName: 'demo' })

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('disk full'))
  })

  it('confirmation message mentions only result folders when there are no matching files', async () => {
    const handler = getHandler()
    fs.existsSync.mockImplementation((p) => p === RESULTS_DIR)
    fs.readdirSync.mockReturnValue(['demo---2026-01'])
    vscode.window.showInputBox.mockResolvedValueOnce('renamed')
    vscode.window.showWarningMessage.mockResolvedValueOnce(undefined)

    await handler({ baseName: 'demo' })

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('1 playback result folder'),
      { modal: true },
      'Rename'
    )
  })

  it('does not scan for result folders when the results directory does not exist', async () => {
    const handler = getHandler()
    fs.existsSync.mockReturnValue(false)
    vscode.window.showInputBox.mockResolvedValueOnce('renamed')
    vscode.window.showWarningMessage.mockResolvedValueOnce(undefined)

    await handler({ baseName: 'demo' })

    expect(fs.readdirSync).not.toHaveBeenCalled()
  })

  it('pluralizes the confirmation message when multiple result folders match', async () => {
    const handler = getHandler()
    fs.existsSync.mockImplementation((p) => p === RESULTS_DIR)
    fs.readdirSync.mockReturnValue(['demo---2026-01', 'demo---2026-02'])
    vscode.window.showInputBox.mockResolvedValueOnce('renamed')
    vscode.window.showWarningMessage.mockResolvedValueOnce(undefined)

    await handler({ baseName: 'demo' })

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('2 playback result folders'),
      { modal: true },
      'Rename'
    )
  })

  describe('validateInput', () => {
    async function getValidateInput() {
      const handler = getHandler()
      await handler({ baseName: 'demo' })
      return vscode.window.showInputBox.mock.calls.at(-1)[0].validateInput
    }

    it('rejects an empty or whitespace-only name', async () => {
      const validateInput = await getValidateInput()

      expect(validateInput('')).toBe('Name cannot be empty')
      expect(validateInput('   ')).toBe('Name cannot be empty')
    })

    it('accepts the unchanged name without further checks', async () => {
      const validateInput = await getValidateInput()

      expect(validateInput('demo')).toBeNull()
      expect(fs.existsSync).not.toHaveBeenCalled()
    })

    it('rejects a name with invalid path characters', async () => {
      const validateInput = await getValidateInput()

      expect(validateInput('bad/name')).toBe('Name contains invalid characters')
    })

    it('rejects a name that collides with an existing recording', async () => {
      const validateInput = await getValidateInput()
      fs.existsSync.mockReturnValue(true)

      expect(validateInput('taken')).toBe('A recording with this name already exists')
    })

    it('accepts a valid, available name', async () => {
      const validateInput = await getValidateInput()
      fs.existsSync.mockReturnValue(false)

      expect(validateInput('freshname')).toBeNull()
    })
  })
})

describe('command: deleteRecording', () => {
  const RECORDINGS_DIR = path.join('/ws', 'test-plans', 'playwright')
  const RESULTS_DIR = path.join('/ws', 'playback-results')

  function getHandler() {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    activateExtension()
    return getCommandHandler('salesforce-ui-script-recorder.deleteRecording')
  }

  it('does nothing without a treeItem or baseName', async () => {
    const handler = getHandler()

    await handler(undefined)
    await handler({})

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
  })

  it('does nothing without a workspace folder', async () => {
    vscode.workspace.workspaceFolders = undefined
    activateExtension()
    const handler = getCommandHandler('salesforce-ui-script-recorder.deleteRecording')

    await handler({ baseName: 'demo' })

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
  })

  it('does nothing when the delete confirmation is declined', async () => {
    const handler = getHandler()
    fs.existsSync.mockReturnValue(true)
    vscode.window.showWarningMessage.mockResolvedValueOnce(undefined)

    await handler({ baseName: 'demo' })

    expect(fs.unlinkSync).not.toHaveBeenCalled()
  })

  it('deletes matching files and result folders on confirmation', async () => {
    const handler = getHandler()
    fs.existsSync.mockImplementation((p) => p === path.join(RECORDINGS_DIR, 'demo.json') || p === path.join(RECORDINGS_DIR, 'demo.spec.js') || p === RESULTS_DIR)
    fs.readdirSync.mockReturnValue(['demo---2026-01', 'other---2026-02'])
    vscode.window.showWarningMessage.mockResolvedValueOnce('Delete')

    await handler({ baseName: 'demo' })

    expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(RECORDINGS_DIR, 'demo.json'))
    expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(RECORDINGS_DIR, 'demo.spec.js'))
    expect(fs.rmSync).toHaveBeenCalledWith(path.join(RESULTS_DIR, 'demo---2026-01'), { recursive: true, force: true })
    expect(fs.rmSync).not.toHaveBeenCalledWith(path.join(RESULTS_DIR, 'other---2026-02'), expect.anything())
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('Deleted "demo"'))
  })

  it('shows an error message when a delete operation throws', async () => {
    const handler = getHandler()
    fs.existsSync.mockImplementation((p) => p === path.join(RECORDINGS_DIR, 'demo.json'))
    vscode.window.showWarningMessage.mockResolvedValueOnce('Delete')
    fs.unlinkSync.mockImplementationOnce(() => { throw new Error('in use') })

    await handler({ baseName: 'demo' })

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('in use'))
  })

  it('confirmation message mentions only files when there are no matching result folders', async () => {
    const handler = getHandler()
    fs.existsSync.mockImplementation((p) => p === path.join(RECORDINGS_DIR, 'demo.json'))
    vscode.window.showWarningMessage.mockResolvedValueOnce(undefined)

    await handler({ baseName: 'demo' })

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('1 recording file'),
      { modal: true },
      'Delete'
    )
  })

  it('does not scan for result folders when the results directory does not exist', async () => {
    const handler = getHandler()
    fs.existsSync.mockReturnValue(false)
    vscode.window.showWarningMessage.mockResolvedValueOnce(undefined)

    await handler({ baseName: 'demo' })

    expect(fs.readdirSync).not.toHaveBeenCalled()
  })

  it('pluralizes the confirmation message when multiple result folders match', async () => {
    const handler = getHandler()
    fs.existsSync.mockImplementation((p) => p === RESULTS_DIR)
    fs.readdirSync.mockReturnValue(['demo---2026-01', 'demo---2026-02'])
    vscode.window.showWarningMessage.mockResolvedValueOnce(undefined)

    await handler({ baseName: 'demo' })

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('2 playback result folders'),
      { modal: true },
      'Delete'
    )
  })
})

describe('command: revealResultFolder', () => {
  it('does nothing without a resultFolderName', async () => {
    activateExtension()
    const handler = getCommandHandler('salesforce-ui-script-recorder.revealResultFolder')

    await handler(undefined)

    expect(latestRecordingsTree().findResultElement).not.toHaveBeenCalled()
  })

  it('reveals the found element', async () => {
    activateExtension()
    const recordingsTree = latestRecordingsTree()
    recordingsTree.findResultElement.mockReturnValue({ label: 'demo' })
    const recordingsTreeView = vscode.window.createTreeView.mock.results[0].value
    const handler = getCommandHandler('salesforce-ui-script-recorder.revealResultFolder')

    await handler('demo---2026')

    expect(recordingsTreeView.reveal).toHaveBeenCalledWith({ label: 'demo' }, { expand: true, focus: true })
  })

  it('falls back to focusing the view when reveal throws', async () => {
    activateExtension()
    const recordingsTree = latestRecordingsTree()
    recordingsTree.findResultElement.mockReturnValue({ label: 'demo' })
    const recordingsTreeView = vscode.window.createTreeView.mock.results[0].value
    recordingsTreeView.reveal.mockImplementationOnce(() => { throw new Error('not visible') })
    const handler = getCommandHandler('salesforce-ui-script-recorder.revealResultFolder')

    await handler('demo---2026')

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('salesforceUiScriptRecorderRecordings.focus')
  })

  it('focuses the view directly when no matching element is found', async () => {
    activateExtension()
    latestRecordingsTree().findResultElement.mockReturnValue(null)
    const handler = getCommandHandler('salesforce-ui-script-recorder.revealResultFolder')

    await handler('missing')

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('salesforceUiScriptRecorderRecordings.focus')
  })
})

describe('command: infoUserFiles / infoDataFiles', () => {
  it('shows the user-files info message', () => {
    activateExtension()

    getCommandHandler('salesforce-ui-script-recorder.infoUserFiles')()

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('User Files contain credential CSVs'))
  })

  it('shows the data-files info message', () => {
    activateExtension()

    getCommandHandler('salesforce-ui-script-recorder.infoDataFiles')()

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('Data Files contain CSVs'))
  })
})

describe('command: revealUserFilesInExplorer / revealDataFilesInExplorer', () => {
  it('creates the user-files folder when missing and reveals it', () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    fs.existsSync.mockReturnValue(false)
    activateExtension()

    getCommandHandler('salesforce-ui-script-recorder.revealUserFilesInExplorer')()

    const folderPath = path.join('/ws', 'user-files')
    expect(fs.mkdirSync).toHaveBeenCalledWith(folderPath, { recursive: true })
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('revealInExplorer', vscode.Uri.file(folderPath))
  })

  it('does not recreate the user-files folder when it already exists', () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    fs.existsSync.mockReturnValue(true)
    activateExtension()

    getCommandHandler('salesforce-ui-script-recorder.revealUserFilesInExplorer')()

    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })

  it('does nothing without a workspace folder (user-files)', () => {
    vscode.workspace.workspaceFolders = undefined
    activateExtension()

    getCommandHandler('salesforce-ui-script-recorder.revealUserFilesInExplorer')()

    expect(fs.mkdirSync).not.toHaveBeenCalled()
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('revealInExplorer', expect.anything())
  })

  it('creates the data-files folder when missing and reveals it', () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    fs.existsSync.mockReturnValue(false)
    activateExtension()

    getCommandHandler('salesforce-ui-script-recorder.revealDataFilesInExplorer')()

    const folderPath = path.join('/ws', 'data-files')
    expect(fs.mkdirSync).toHaveBeenCalledWith(folderPath, { recursive: true })
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('revealInExplorer', vscode.Uri.file(folderPath))
  })

  it('does not recreate the data-files folder when it already exists', () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    fs.existsSync.mockReturnValue(true)
    activateExtension()

    getCommandHandler('salesforce-ui-script-recorder.revealDataFilesInExplorer')()

    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })

  it('does nothing without a workspace folder (data-files)', () => {
    vscode.workspace.workspaceFolders = undefined
    activateExtension()

    getCommandHandler('salesforce-ui-script-recorder.revealDataFilesInExplorer')()

    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })
})

describe('command: revealFileSection', () => {
  it('reveals the first user-files child when one exists', async () => {
    activateExtension()
    const { userFilesTree } = latestFileTrees()
    userFilesTree.getFirstChild.mockReturnValue({ label: 'first' })
    const userFilesTreeView = vscode.window.createTreeView.mock.results[1].value
    const handler = getCommandHandler('salesforce-ui-script-recorder.revealFileSection')

    await handler('user-files')

    expect(userFilesTreeView.reveal).toHaveBeenCalledWith({ label: 'first' }, { select: true, focus: true })
  })

  it('focuses the user-files view when there are no children', async () => {
    activateExtension()
    latestFileTrees().userFilesTree.getFirstChild.mockReturnValue(null)
    const handler = getCommandHandler('salesforce-ui-script-recorder.revealFileSection')

    await handler('user-files')

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('salesforceUiScriptRecorderUserFiles.focus')
  })

  it('reveals the first data-files child when one exists', async () => {
    activateExtension()
    const { dataFilesTree } = latestFileTrees()
    dataFilesTree.getFirstChild.mockReturnValue({ label: 'first' })
    const dataFilesTreeView = vscode.window.createTreeView.mock.results[2].value
    const handler = getCommandHandler('salesforce-ui-script-recorder.revealFileSection')

    await handler('data-files')

    expect(dataFilesTreeView.reveal).toHaveBeenCalledWith({ label: 'first' }, { select: true, focus: true })
  })

  it('focuses the data-files view when there are no children', async () => {
    activateExtension()
    latestFileTrees().dataFilesTree.getFirstChild.mockReturnValue(null)
    const handler = getCommandHandler('salesforce-ui-script-recorder.revealFileSection')

    await handler('data-files')

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('salesforceUiScriptRecorderDataFiles.focus')
  })

  it('does nothing for an unrecognized folder', async () => {
    activateExtension()
    const handler = getCommandHandler('salesforce-ui-script-recorder.revealFileSection')

    await handler('something-else')

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
  })
})

describe('deactivate', () => {
  it('is a no-op', () => {
    expect(deactivate()).toBeUndefined()
  })
})
