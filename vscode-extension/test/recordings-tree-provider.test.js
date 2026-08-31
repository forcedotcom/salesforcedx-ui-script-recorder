jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn()
}))

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { RecordingsTreeProvider } = require('../recordings-tree-provider')

afterEach(() => {
  jest.clearAllMocks()
  vscode.workspace.workspaceFolders = undefined
})

function setWorkspace() {
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
}

describe('RecordingsTreeProvider basics', () => {
  it('getTreeItem returns the element unchanged', () => {
    const provider = new RecordingsTreeProvider()
    const element = { label: 'x' }

    expect(provider.getTreeItem(element)).toBe(element)
  })

  it('getParent returns the element\'s _parent, or null if unset', () => {
    const provider = new RecordingsTreeProvider()

    expect(provider.getParent({ _parent: 'p' })).toBe('p')
    expect(provider.getParent({})).toBeNull()
  })

  it('fires onDidChangeTreeData when refreshed', () => {
    const provider = new RecordingsTreeProvider()
    const listener = jest.fn()
    provider.onDidChangeTreeData(listener)

    provider.refresh()

    expect(listener).toHaveBeenCalled()
  })
})

describe('getChildren dispatch', () => {
  it('returns an empty array when there is no workspace folder', () => {
    vscode.workspace.workspaceFolders = undefined
    const provider = new RecordingsTreeProvider()

    expect(provider.getChildren()).toEqual([])
  })

  it('returns an empty array when the recordings directory does not exist', () => {
    setWorkspace()
    fs.existsSync.mockReturnValue(false)
    const provider = new RecordingsTreeProvider()

    expect(provider.getChildren()).toEqual([])
  })

  it('lists top-level recordings when called with no element', () => {
    setWorkspace()
    fs.existsSync.mockImplementation((p) => p === path.join('/ws', 'test-plans', 'playwright'))
    fs.readdirSync.mockReturnValue(['b.json', 'a.json', 'a.spec.js'])
    const provider = new RecordingsTreeProvider()

    const children = provider.getChildren()

    expect(children.map((c) => c.baseName)).toEqual(['b', 'a'])
  })

  it('delegates to result-folder listing for a resultFolder element', () => {
    setWorkspace()
    fs.existsSync.mockImplementation((p) => p === path.join('/ws', 'test-plans', 'playwright') || p === '/some/folder')
    fs.readdirSync.mockImplementation((dir) => (dir === '/some/folder' ? ['inner.txt'] : []))
    fs.statSync.mockReturnValue({ isDirectory: () => false })
    const provider = new RecordingsTreeProvider()

    const children = provider.getChildren({ _type: 'resultFolder', _folderPath: '/some/folder' })

    expect(children.map((c) => c.label)).toEqual(['inner.txt'])
  })

  it('delegates to recording-children listing for a recording element', () => {
    setWorkspace()
    fs.existsSync.mockImplementation((p) => (
      p === path.join('/ws', 'test-plans', 'playwright') ||
      p === path.join('/ws', 'test-plans', 'playwright', 'demo.json')
    ))
    const provider = new RecordingsTreeProvider()

    const children = provider.getChildren({ _type: 'recording', baseName: 'demo' })

    expect(children.map((c) => c.label)).toEqual(['demo.json'])
  })

  it('delegates to result-folders listing for a resultsGroup element', () => {
    setWorkspace()
    fs.existsSync.mockImplementation((p) => (
      p === path.join('/ws', 'test-plans', 'playwright') ||
      p === path.join('/ws', 'playback-results')
    ))
    fs.readdirSync.mockReturnValue(['demo---2026.json'])
    fs.statSync.mockReturnValue({ isDirectory: () => true })
    const provider = new RecordingsTreeProvider()

    const children = provider.getChildren({ _type: 'resultsGroup', _baseName: 'demo' })

    expect(children.map((c) => c.label)).toEqual(['2026.json'])
  })
})

describe('getTopLevelRecordings (via getChildren with no element)', () => {
  beforeEach(() => {
    setWorkspace()
  })

  it('marks a recording collapsible and opens its spec when a spec file exists', () => {
    fs.existsSync.mockImplementation((p) => p === path.join('/ws', 'test-plans', 'playwright'))
    fs.readdirSync.mockReturnValue(['demo.json', 'demo.spec.js'])
    const provider = new RecordingsTreeProvider()

    const [item] = provider.getChildren()

    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed)
    expect(item.command.arguments[0].fsPath).toBe(path.join('/ws', 'test-plans', 'playwright', 'demo.spec.js'))
  })

  it('marks a recording non-collapsible and opens its json when no spec file exists', () => {
    fs.existsSync.mockImplementation((p) => p === path.join('/ws', 'test-plans', 'playwright'))
    fs.readdirSync.mockReturnValue(['demo.json'])
    const provider = new RecordingsTreeProvider()

    const [item] = provider.getChildren()

    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None)
    expect(item.command.arguments[0].fsPath).toBe(path.join('/ws', 'test-plans', 'playwright', 'demo.json'))
  })

  it('marks a recording contextValue as recordingWithResults when playback results exist for it', () => {
    fs.existsSync.mockImplementation((p) => (
      p === path.join('/ws', 'test-plans', 'playwright') || p === path.join('/ws', 'playback-results')
    ))
    fs.readdirSync.mockImplementation((dir) => (
      dir === path.join('/ws', 'test-plans', 'playwright') ? ['demo.json'] : ['demo---2026.json']
    ))
    fs.statSync.mockReturnValue({ isDirectory: () => true })
    const provider = new RecordingsTreeProvider()

    const [item] = provider.getChildren()

    expect(item.contextValue).toBe('recordingWithResults')
  })

  it('marks a recording contextValue as plain "recording" when there are no playback results', () => {
    fs.existsSync.mockImplementation((p) => p === path.join('/ws', 'test-plans', 'playwright'))
    fs.readdirSync.mockReturnValue(['demo.json'])
    const provider = new RecordingsTreeProvider()

    const [item] = provider.getChildren()

    expect(item.contextValue).toBe('recording')
  })

  it('sorts recordings in reverse alphabetical order', () => {
    fs.existsSync.mockImplementation((p) => p === path.join('/ws', 'test-plans', 'playwright'))
    fs.readdirSync.mockReturnValue(['alpha.json', 'zeta.json', 'mid.json'])
    const provider = new RecordingsTreeProvider()

    const children = provider.getChildren()

    expect(children.map((c) => c.baseName)).toEqual(['zeta', 'mid', 'alpha'])
  })

  it('ignores a playback-results entry whose spec name is empty when building the results set', () => {
    fs.existsSync.mockImplementation((p) => (
      p === path.join('/ws', 'test-plans', 'playwright') || p === path.join('/ws', 'playback-results')
    ))
    fs.readdirSync.mockImplementation((dir) => (
      dir === path.join('/ws', 'test-plans', 'playwright') ? ['demo.json'] : ['---orphan']
    ))
    const provider = new RecordingsTreeProvider()

    const [item] = provider.getChildren()

    expect(item.contextValue).toBe('recording')
  })
})

describe('getRecordingChildren (via getChildren with a recording element)', () => {
  beforeEach(() => setWorkspace())

  it('includes both json and spec entries when both exist', () => {
    fs.existsSync.mockImplementation((p) => (
      p === path.join('/ws', 'test-plans', 'playwright') ||
      p === path.join('/ws', 'test-plans', 'playwright', 'demo.json') ||
      p === path.join('/ws', 'test-plans', 'playwright', 'demo.spec.js')
    ))
    const provider = new RecordingsTreeProvider()

    const children = provider.getChildren({ _type: 'recording', baseName: 'demo' })

    expect(children.map((c) => c.label)).toEqual(['demo.json', 'demo.spec.js'])
    expect(children[0].contextValue).toBe('recordingFile')
  })

  it('includes neither file entry when neither exists, and skips the results group when there are no results', () => {
    fs.existsSync.mockImplementation((p) => p === path.join('/ws', 'test-plans', 'playwright'))
    const provider = new RecordingsTreeProvider()

    const children = provider.getChildren({ _type: 'recording', baseName: 'ghost' })

    expect(children).toEqual([])
  })

  it('appends a "Playback Results" group node when playback results exist', () => {
    fs.existsSync.mockImplementation((p) => (
      p === path.join('/ws', 'test-plans', 'playwright') || p === path.join('/ws', 'playback-results')
    ))
    fs.readdirSync.mockReturnValue(['demo---2026.json'])
    fs.statSync.mockReturnValue({ isDirectory: () => true })
    const provider = new RecordingsTreeProvider()

    const children = provider.getChildren({ _type: 'recording', baseName: 'demo' })

    expect(children).toHaveLength(1)
    expect(children[0].label).toBe('Playback Results')
    expect(children[0]._type).toBe('resultsGroup')
  })
})

describe('getResultFoldersForSpec / getResultFolders (via a resultsGroup element)', () => {
  beforeEach(() => setWorkspace())

  it('returns an empty array when the results directory does not exist', () => {
    fs.existsSync.mockImplementation((p) => p === path.join('/ws', 'test-plans', 'playwright'))
    const provider = new RecordingsTreeProvider()

    expect(provider.getChildren({ _type: 'resultsGroup', _baseName: 'demo' })).toEqual([])
  })

  it('returns an empty array when readdirSync throws', () => {
    fs.existsSync.mockImplementation((p) => (
      p === path.join('/ws', 'test-plans', 'playwright') || p === path.join('/ws', 'playback-results')
    ))
    fs.readdirSync.mockImplementation(() => { throw new Error('EACCES') })
    const provider = new RecordingsTreeProvider()

    expect(provider.getChildren({ _type: 'resultsGroup', _baseName: 'demo' })).toEqual([])
  })

  it('filters to matching spec name and directory entries only, sorted newest first', () => {
    fs.existsSync.mockImplementation((p) => (
      p === path.join('/ws', 'test-plans', 'playwright') || p === path.join('/ws', 'playback-results')
    ))
    fs.readdirSync.mockReturnValue(['demo---2026-01', 'demo---2026-02', 'other---2026-03', 'demo---not-a-dir.txt'])
    fs.statSync.mockImplementation((full) => ({ isDirectory: () => !full.endsWith('.txt') }))
    const provider = new RecordingsTreeProvider()

    const children = provider.getChildren({ _type: 'resultsGroup', _baseName: 'demo' })

    expect(children.map((c) => c.tooltip)).toEqual(['demo---2026-02', 'demo---2026-01'])
  })

  it('labels a bulk folder with "(Bulk)" and a non-bulk folder with just its timestamp', () => {
    fs.existsSync.mockImplementation((p) => (
      p === path.join('/ws', 'test-plans', 'playwright') || p === path.join('/ws', 'playback-results')
    ))
    fs.readdirSync.mockReturnValue(['demo---2026-01---BULK', 'demo---2026-02'])
    fs.statSync.mockReturnValue({ isDirectory: () => true })
    const provider = new RecordingsTreeProvider()

    const children = provider.getChildren({ _type: 'resultsGroup', _baseName: 'demo' })

    const bulk = children.find((c) => c.tooltip === 'demo---2026-01---BULK')
    const plain = children.find((c) => c.tooltip === 'demo---2026-02')
    expect(bulk.label).toBe('2026-01 (Bulk)')
    expect(bulk.iconPath).toEqual(new vscode.ThemeIcon('folder-library'))
    expect(plain.label).toBe('2026-02')
    expect(plain.iconPath).toEqual(new vscode.ThemeIcon('folder'))
  })

  it('falls back to the full folder name as the timestamp when there is no "---" separator', () => {
    fs.existsSync.mockImplementation((p) => (
      p === path.join('/ws', 'test-plans', 'playwright') || p === path.join('/ws', 'playback-results')
    ))
    fs.readdirSync.mockReturnValue(['solofolder'])
    fs.statSync.mockReturnValue({ isDirectory: () => true })
    const provider = new RecordingsTreeProvider()

    const [item] = provider.getChildren({ _type: 'resultsGroup', _baseName: 'solofolder' })

    expect(item.label).toBe('solofolder')
  })
})

describe('listResultFolderContents (via a resultFolder element)', () => {
  beforeEach(() => setWorkspace())

  it('returns an empty array when the folder does not exist', () => {
    fs.existsSync.mockImplementation((p) => p === path.join('/ws', 'test-plans', 'playwright'))
    const provider = new RecordingsTreeProvider()

    expect(provider.getChildren({ _type: 'resultFolder', _folderPath: '/gone' })).toEqual([])
  })

  it('returns an empty array when readdirSync throws', () => {
    fs.existsSync.mockImplementation((p) => p === path.join('/ws', 'test-plans', 'playwright') || p === '/results')
    fs.readdirSync.mockImplementation(() => { throw new Error('EACCES') })
    const provider = new RecordingsTreeProvider()

    expect(provider.getChildren({ _type: 'resultFolder', _folderPath: '/results' })).toEqual([])
  })

  it('lists both subdirectories and files, sorted, with distinct icons and contextValues', () => {
    fs.existsSync.mockImplementation((p) => p === path.join('/ws', 'test-plans', 'playwright') || p === '/results')
    fs.readdirSync.mockReturnValue(['screenshot.png', 'session-1'])
    fs.statSync.mockImplementation((full) => ({ isDirectory: () => full.endsWith('session-1') }))
    const provider = new RecordingsTreeProvider()

    const children = provider.getChildren({ _type: 'resultFolder', _folderPath: '/results' })

    const dir = children.find((c) => c.label === 'session-1')
    const file = children.find((c) => c.label === 'screenshot.png')
    expect(dir._type).toBe('resultFolder')
    expect(dir.contextValue).toBe('resultFolder')
    expect(file.contextValue).toBe('resultFile')
    expect(file.resourceUri.fsPath).toBe(path.join('/results', 'screenshot.png'))
  })
})

describe('findResultElement', () => {
  beforeEach(() => setWorkspace())

  it('returns null when there is no workspace folder', () => {
    vscode.workspace.workspaceFolders = undefined
    const provider = new RecordingsTreeProvider()

    expect(provider.findResultElement('demo---2026')).toBeNull()
  })

  it('returns null when the playback-results directory does not exist', () => {
    fs.existsSync.mockReturnValue(false)
    const provider = new RecordingsTreeProvider()

    expect(provider.findResultElement('demo---2026')).toBeNull()
  })

  it('returns null when the top folder does not exist inside playback-results', () => {
    fs.existsSync.mockImplementation((p) => p === path.join('/ws', 'playback-results'))
    const provider = new RecordingsTreeProvider()

    expect(provider.findResultElement('demo---2026')).toBeNull()
  })

  it('builds a recording -> resultsGroup -> resultFolder chain for a bulk top folder with no sub-path', () => {
    fs.existsSync.mockImplementation((p) => (
      p === path.join('/ws', 'playback-results') ||
      p === path.join('/ws', 'playback-results', 'demo---2026---BULK')
    ))
    const provider = new RecordingsTreeProvider()

    const item = provider.findResultElement('demo---2026---BULK')

    expect(item.label).toBe('2026 (Bulk)')
    expect(item._type).toBe('resultFolder')
    expect(item._parent.label).toBe('Playback Results')
    expect(item._parent._parent.label).toBe('demo')
    expect(item._parent._parent._type).toBe('recording')
  })

  it('appends a sub-folder element when a sub-path is given and it exists', () => {
    fs.existsSync.mockImplementation((p) => (
      p === path.join('/ws', 'playback-results') ||
      p === path.join('/ws', 'playback-results', 'demo---2026---BULK') ||
      p === path.join('/ws', 'playback-results', 'demo---2026---BULK', 'session-1')
    ))
    const provider = new RecordingsTreeProvider()

    const item = provider.findResultElement('demo---2026---BULK/session-1')

    expect(item.label).toBe('session-1')
    expect(item._parent.label).toBe('2026 (Bulk)')
  })

  it('returns the top result folder unchanged when the requested sub-folder does not exist', () => {
    fs.existsSync.mockImplementation((p) => (
      p === path.join('/ws', 'playback-results') ||
      p === path.join('/ws', 'playback-results', 'demo---2026---BULK')
    ))
    const provider = new RecordingsTreeProvider()

    const item = provider.findResultElement('demo---2026---BULK/missing-session')

    expect(item.label).toBe('2026 (Bulk)')
  })

  it('falls back to the full top-folder name as the label when it has no "---" separator', () => {
    fs.existsSync.mockImplementation((p) => (
      p === path.join('/ws', 'playback-results') ||
      p === path.join('/ws', 'playback-results', 'soloFolder')
    ))
    const provider = new RecordingsTreeProvider()

    const item = provider.findResultElement('soloFolder')

    expect(item.label).toBe('soloFolder')
  })
})
