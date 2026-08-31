jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn()
}))

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { FileListTreeProvider } = require('../file-list-tree-provider')

afterEach(() => {
  jest.clearAllMocks()
  vscode.workspace.workspaceFolders = undefined
})

describe('FileListTreeProvider', () => {
  it('getTreeItem returns the element unchanged', () => {
    const provider = new FileListTreeProvider('auth-states')
    const element = { label: 'x' }

    expect(provider.getTreeItem(element)).toBe(element)
  })

  it('getParent always returns null', () => {
    const provider = new FileListTreeProvider('auth-states')

    expect(provider.getParent()).toBeNull()
  })

  it('fires onDidChangeTreeData when refreshed', () => {
    const provider = new FileListTreeProvider('auth-states')
    const listener = jest.fn()
    provider.onDidChangeTreeData(listener)

    provider.refresh()

    expect(listener).toHaveBeenCalled()
  })

  describe('getChildren', () => {
    it('returns an empty array when there is no workspace folder', () => {
      vscode.workspace.workspaceFolders = undefined
      const provider = new FileListTreeProvider('auth-states')

      expect(provider.getChildren()).toEqual([])
    })

    it('returns an empty array when the subdirectory does not exist', () => {
      vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
      fs.existsSync.mockReturnValue(false)
      const provider = new FileListTreeProvider('auth-states')

      expect(provider.getChildren()).toEqual([])
    })

    it('returns an empty array when readdirSync throws', () => {
      vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
      fs.existsSync.mockReturnValue(true)
      fs.readdirSync.mockImplementation(() => { throw new Error('EACCES') })
      const provider = new FileListTreeProvider('auth-states')

      expect(provider.getChildren()).toEqual([])
    })

    it('filters out non-file entries, sorts, and formats auth-state labels', () => {
      vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
      fs.existsSync.mockReturnValue(true)
      fs.readdirSync.mockReturnValue(['b---org2.json', 'a-dir', 'a---org1.json'])
      fs.statSync.mockImplementation((full) => ({ isFile: () => !full.endsWith('a-dir') }))
      const provider = new FileListTreeProvider('auth-states')

      const children = provider.getChildren()

      expect(children.map((c) => c.label)).toEqual(['org1 @ a', 'org2 @ b'])
      expect(children[0].resourceUri.fsPath).toBe(path.join('/ws', 'auth-states', 'a---org1.json'))
      expect(children[0].command).toEqual({
        command: 'vscode.open',
        title: 'Open',
        arguments: [vscode.Uri.file(path.join('/ws', 'auth-states', 'a---org1.json'))]
      })
      expect(children[0].iconPath).toEqual(new vscode.ThemeIcon('lock'))
    })

    it('uses the bare filename and a file icon for a non-auth-states subdirectory', () => {
      vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
      fs.existsSync.mockReturnValue(true)
      fs.readdirSync.mockReturnValue(['notes.txt'])
      fs.statSync.mockReturnValue({ isFile: () => true })
      const provider = new FileListTreeProvider('scratch')

      const children = provider.getChildren()

      expect(children).toHaveLength(1)
      expect(children[0].label).toBe('notes.txt')
      expect(children[0].iconPath).toEqual(new vscode.ThemeIcon('file'))
    })

    it('returns a filename unchanged when it has no "---" separator', () => {
      vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
      fs.existsSync.mockReturnValue(true)
      fs.readdirSync.mockReturnValue(['plainname.json'])
      fs.statSync.mockReturnValue({ isFile: () => true })
      const provider = new FileListTreeProvider('auth-states')

      const children = provider.getChildren()

      expect(children[0].label).toBe('plainname')
    })
  })

  describe('getFirstChild', () => {
    it('returns null when there are no children', () => {
      vscode.workspace.workspaceFolders = undefined
      const provider = new FileListTreeProvider('auth-states')

      expect(provider.getFirstChild()).toBeNull()
    })

    it('returns the first child when children exist', () => {
      vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
      fs.existsSync.mockReturnValue(true)
      fs.readdirSync.mockReturnValue(['only.json'])
      fs.statSync.mockReturnValue({ isFile: () => true })
      const provider = new FileListTreeProvider('auth-states')

      expect(provider.getFirstChild().label).toBe('only')
    })
  })
})
