class Position {
  constructor(line, character) {
    this.line = line
    this.character = character
  }
}

class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'object' && a !== null) {
      this.start = a
      this.end = b
    } else {
      this.start = new Position(a, b)
      this.end = new Position(c, d)
    }
  }
}

class Uri {
  constructor(fsPath) {
    this.scheme = 'file'
    this.fsPath = fsPath
    this.path = fsPath
  }

  toString() {
    return `file://${this.fsPath}`
  }

  static file(fsPath) {
    return new Uri(fsPath)
  }
}

class EventEmitter {
  constructor() {
    this._listeners = []
    this.event = (listener) => {
      this._listeners.push(listener)
      return { dispose: jest.fn() }
    }
  }

  fire(arg) {
    this._listeners.forEach((listener) => listener(arg))
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label
    this.collapsibleState = collapsibleState
  }
}

class ThemeIcon {
  constructor(id) {
    this.id = id
  }
}

class CodeLens {
  constructor(range, command) {
    this.range = range
    this.command = command
  }
}

class WorkspaceEdit {
  constructor() {
    this.edits = []
  }

  replace(uri, range, newText) {
    this.edits.push({ uri, range, newText })
  }
}

class RelativePattern {
  constructor(base, pattern) {
    this.base = base
    this.pattern = pattern
  }
}

class ShellExecution {
  constructor(commandLine, options) {
    this.commandLine = commandLine
    this.options = options
  }
}

class Task {
  constructor(definition, scope, name, source, execution, problemMatchers) {
    this.definition = definition
    this.scope = scope
    this.name = name
    this.source = source
    this.execution = execution
    this.problemMatchers = problemMatchers
  }
}

function makeOutputChannel() {
  return {
    appendLine: jest.fn(),
    append: jest.fn(),
    clear: jest.fn(),
    show: jest.fn(),
    dispose: jest.fn()
  }
}

function makeFsWatcher() {
  return {
    onDidCreate: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    onDidDelete: jest.fn(() => ({ dispose: jest.fn() })),
    dispose: jest.fn()
  }
}

function makeTextDocument(overrides = {}) {
  return {
    getText: jest.fn(() => ''),
    fileName: '',
    uri: Uri.file(''),
    positionAt: jest.fn((offset) => new Position(0, offset)),
    save: jest.fn().mockResolvedValue(true),
    ...overrides
  }
}

function makeWebviewPanel() {
  return {
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: jest.fn((uri) => uri),
      postMessage: jest.fn(),
      onDidReceiveMessage: jest.fn(() => ({ dispose: jest.fn() }))
    },
    viewColumn: 1,
    reveal: jest.fn(),
    dispose: jest.fn(),
    onDidDispose: jest.fn(() => ({ dispose: jest.fn() }))
  }
}

function makeTerminal(options = {}) {
  return {
    name: options.name,
    show: jest.fn(),
    sendText: jest.fn(),
    dispose: jest.fn()
  }
}

function makeTreeView() {
  return {
    reveal: jest.fn(),
    dispose: jest.fn()
  }
}

const window = {
  activeTextEditor: undefined,
  terminals: [],
  createOutputChannel: jest.fn(() => makeOutputChannel()),
  createTextEditorDecorationType: jest.fn(() => ({ dispose: jest.fn() })),
  createTreeView: jest.fn(() => makeTreeView()),
  createTerminal: jest.fn((options) => makeTerminal(options)),
  createWebviewPanel: jest.fn(() => makeWebviewPanel()),
  onDidChangeActiveTextEditor: jest.fn(() => ({ dispose: jest.fn() })),
  showErrorMessage: jest.fn().mockResolvedValue(undefined),
  showInformationMessage: jest.fn().mockResolvedValue(undefined),
  showWarningMessage: jest.fn().mockResolvedValue(undefined),
  showInputBox: jest.fn().mockResolvedValue(undefined),
  showQuickPick: jest.fn().mockResolvedValue(undefined),
  showSaveDialog: jest.fn().mockResolvedValue(undefined),
  showTextDocument: jest.fn().mockResolvedValue(undefined),
  withProgress: jest.fn((options, task) => {
    const progress = { report: jest.fn() }
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() }))
    }
    return task(progress, token)
  })
}

const workspace = {
  workspaceFolders: undefined,
  getWorkspaceFolder: jest.fn(),
  createFileSystemWatcher: jest.fn(() => makeFsWatcher()),
  openTextDocument: jest.fn(() => Promise.resolve(makeTextDocument())),
  onDidChangeTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
  applyEdit: jest.fn().mockResolvedValue(true)
}

const commands = {
  registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
  executeCommand: jest.fn().mockResolvedValue(undefined)
}

const languages = {
  registerCodeLensProvider: jest.fn(() => ({ dispose: jest.fn() }))
}

const tasks = {
  executeTask: jest.fn().mockResolvedValue({ terminate: jest.fn() }),
  onDidEndTaskProcess: jest.fn(() => ({ dispose: jest.fn() }))
}

module.exports = {
  window,
  workspace,
  commands,
  languages,
  tasks,
  Uri,
  Range,
  Position,
  EventEmitter,
  TreeItem,
  ThemeIcon,
  CodeLens,
  WorkspaceEdit,
  RelativePattern,
  ShellExecution,
  Task,
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  TaskScope: { Global: 1, Workspace: 2 },
  TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
  TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
  __factories: { makeOutputChannel, makeFsWatcher, makeTextDocument, makeWebviewPanel, makeTerminal, makeTreeView }
}
