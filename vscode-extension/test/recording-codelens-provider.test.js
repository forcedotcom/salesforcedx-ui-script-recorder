jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn()
}))

const vscode = require('vscode')
const fs = require('fs')
const { RecordingCodeLensProvider } = require('../recording-codelens-provider')

function makeDocument(fileName, text) {
  return { fileName, uri: vscode.Uri.file(fileName), getText: jest.fn(() => text) }
}

afterEach(() => {
  jest.clearAllMocks()
  vscode.workspace.workspaceFolders = undefined
  // clearAllMocks() only resets call history, not configured return values -
  // this mock's return value is overridden mid-suite, so reset it explicitly.
  vscode.workspace.getWorkspaceFolder.mockReturnValue(undefined)
})

describe('RecordingCodeLensProvider basics', () => {
  it('fires onDidChangeCodeLenses when refreshed', () => {
    const provider = new RecordingCodeLensProvider()
    const listener = jest.fn()
    provider.onDidChangeCodeLenses(listener)

    provider.refresh()

    expect(listener).toHaveBeenCalled()
  })
})

describe('provideCodeLenses / _provideJsonLenses (non-.spec.js documents)', () => {
  it('returns no lenses for invalid JSON', () => {
    const provider = new RecordingCodeLensProvider()
    const document = makeDocument('/ws/demo.json', '{ not json')

    expect(provider.provideCodeLenses(document)).toEqual([])
  })

  it('returns no lenses when the parsed JSON is falsy', () => {
    const provider = new RecordingCodeLensProvider()
    const document = makeDocument('/ws/demo.json', 'null')

    expect(provider.provideCodeLenses(document)).toEqual([])
  })

  it('returns no lenses when steps is not an array', () => {
    const provider = new RecordingCodeLensProvider()
    const document = makeDocument('/ws/demo.json', JSON.stringify({ steps: 'nope' }))

    expect(provider.provideCodeLenses(document)).toEqual([])
  })

  it('returns a single reconvert lens for a valid recording', () => {
    const provider = new RecordingCodeLensProvider()
    const document = makeDocument('/ws/demo.json', JSON.stringify({ steps: [] }))

    const lenses = provider.provideCodeLenses(document)

    expect(lenses).toHaveLength(1)
    expect(lenses[0].command).toEqual({
      title: '$(refresh) Re-convert to Playwright',
      command: 'salesforce-ui-script-recorder.reconvert',
      arguments: [document.uri]
    })
  })
})

describe('_provideSpecLenses (.spec.js documents), excluding the results lens', () => {
  // No workspace folder configured in this block, so _buildResultsLens short-circuits
  // to null immediately without touching fs — isolating these cases to the
  // parameterize-lens logic driven by the sibling .json file.
  const jsonPath = '/ws/test-plans/playwright/demo.json'
  const specPath = '/ws/test-plans/playwright/demo.spec.js'

  it('returns an empty array when the sibling json file does not exist', () => {
    fs.existsSync.mockReturnValue(false)
    const provider = new RecordingCodeLensProvider()
    const document = makeDocument(specPath, 'irrelevant')

    expect(provider.provideCodeLenses(document)).toEqual([])
  })

  it('returns an empty array when the sibling json file is not valid JSON', () => {
    fs.existsSync.mockImplementation((p) => p === jsonPath)
    fs.readFileSync.mockReturnValue('{ not json')
    const provider = new RecordingCodeLensProvider()
    const document = makeDocument(specPath, 'irrelevant')

    expect(provider.provideCodeLenses(document)).toEqual([])
  })

  it('returns an empty array when the parsed recording has no steps', () => {
    fs.existsSync.mockImplementation((p) => p === jsonPath)
    fs.readFileSync.mockReturnValue(JSON.stringify({ foo: 'bar' }))
    const provider = new RecordingCodeLensProvider()
    const document = makeDocument(specPath, 'irrelevant')

    expect(provider.provideCodeLenses(document)).toEqual([])
  })

  it('treats an aria/Password field as auto-parameterized, pushing no lens for it', () => {
    fs.existsSync.mockImplementation((p) => p === jsonPath)
    fs.readFileSync.mockReturnValue(JSON.stringify({
      steps: [{ type: 'change', selectors: [['aria/Password']] }]
    }))
    const provider = new RecordingCodeLensProvider()
    const document = makeDocument(specPath, "await page.fill('#pwd', 'secret')")

    expect(provider.provideCodeLenses(document)).toEqual([])
  })

  it('does not treat a non-username/password aria field as auto-parameterized', () => {
    fs.existsSync.mockImplementation((p) => p === jsonPath)
    fs.readFileSync.mockReturnValue(JSON.stringify({
      steps: [{ type: 'change', selectors: [['aria/Email']] }]
    }))
    const provider = new RecordingCodeLensProvider()
    const document = makeDocument(specPath, "await page.fill('#email', 'a@b.com')")

    const lenses = provider.provideCodeLenses(document)

    expect(lenses).toHaveLength(1)
    expect(lenses[0].command.title).toContain('$(add) Parameterize')
  })

  it('builds parameterize lenses in order, skipping auto-params and exhausted fill lines', () => {
    fs.existsSync.mockImplementation((p) => p === jsonPath)
    fs.readFileSync.mockReturnValue(JSON.stringify({
      steps: [
        { type: 'click' },
        { type: 'change', selectors: [['aria/Username field']] },
        { type: 'change', params: { parameterise: true, paramName: 'foo' } },
        { type: 'change', selectors: [['#plain']] }
      ]
    }))
    const specText = [
      "test('demo', async ({ page }) => {",
      "  await page.fill('#user', 'bob')",
      "  await page.click('#next')",
      "  await page.fill('#cfg', 'x')",
      "  await page.fill('#plain-field', 'y')",
      "  await page.fill('#extra', 'z')",
      '})'
    ].join('\n')
    const provider = new RecordingCodeLensProvider()
    const document = makeDocument(specPath, specText)

    const lenses = provider.provideCodeLenses(document)

    expect(lenses).toHaveLength(2)
    expect(lenses[0].command.title).toBe('$(symbol-parameter) Config: foo')
    expect(lenses[0].command.arguments).toEqual([vscode.Uri.file(jsonPath), 2])
    expect(lenses[1].command.title).toBe('$(add) Parameterize "plain"')
    expect(lenses[1].command.arguments).toEqual([vscode.Uri.file(jsonPath), 3])
  })
})

describe('_buildResultsLens (via a .spec.js document with no sibling json)', () => {
  // The sibling .json file never exists in this block, so _provideSpecLenses
  // returns immediately after computing the results lens - isolating these
  // cases to _buildResultsLens's own branches.
  const specPath = '/ws/test-plans/playwright/demo.spec.js'
  const resultsDir = '/ws/playback-results'

  function provideLenses(fileName = specPath) {
    const provider = new RecordingCodeLensProvider()
    return provider.provideCodeLenses(makeDocument(fileName, 'irrelevant'))
  }

  it('returns no lens when there is no workspace folder at all', () => {
    vscode.workspace.workspaceFolders = undefined
    vscode.workspace.getWorkspaceFolder.mockReturnValue(undefined)

    expect(provideLenses()).toEqual([])
  })

  it('falls back to the first workspace folder when getWorkspaceFolder returns nothing', () => {
    vscode.workspace.getWorkspaceFolder.mockReturnValue(undefined)
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    fs.existsSync.mockImplementation((p) => p === resultsDir)
    fs.readdirSync.mockReturnValue([])

    expect(provideLenses()).toEqual([])
    expect(fs.existsSync).toHaveBeenCalledWith(resultsDir)
  })

  it('uses the getWorkspaceFolder result directly, ignoring workspaceFolders', () => {
    vscode.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/from-gwf' } })
    vscode.workspace.workspaceFolders = undefined
    fs.existsSync.mockReturnValue(false)

    expect(provideLenses()).toEqual([])
    expect(fs.existsSync).toHaveBeenCalledWith('/from-gwf/playback-results'.replace(/\//g, require('path').sep))
  })

  it('returns no lens when the playback-results directory does not exist', () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    fs.existsSync.mockReturnValue(false)

    expect(provideLenses()).toEqual([])
  })

  it('returns no lens when readdirSync throws', () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    fs.existsSync.mockImplementation((p) => p === resultsDir)
    fs.readdirSync.mockImplementation(() => { throw new Error('EACCES') })

    expect(provideLenses()).toEqual([])
  })

  it('returns no lens when no result entries match the spec name', () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    fs.existsSync.mockImplementation((p) => p === resultsDir)
    fs.readdirSync.mockReturnValue(['other---2026'])

    expect(provideLenses()).toEqual([])
    expect(fs.statSync).not.toHaveBeenCalled()
  })

  it('treats a matching entry as having no results when statSync throws', () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    fs.existsSync.mockImplementation((p) => p === resultsDir)
    fs.readdirSync.mockReturnValue(['demo---2026'])
    fs.statSync.mockImplementation(() => { throw new Error('boom') })

    expect(provideLenses()).toEqual([])
  })

  it('treats a matching entry as having no results when it is not a directory', () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    fs.existsSync.mockImplementation((p) => p === resultsDir)
    fs.readdirSync.mockReturnValue(['demo---2026'])
    fs.statSync.mockReturnValue({ isDirectory: () => false })

    expect(provideLenses()).toEqual([])
  })

  it('returns no lens for a matching non-bulk entry with neither results.json nor a BULK suffix', () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    fs.existsSync.mockImplementation((p) => p === resultsDir)
    fs.readdirSync.mockReturnValue(['demo---2026'])
    fs.statSync.mockReturnValue({ isDirectory: () => true })

    expect(provideLenses()).toEqual([])
  })

  it('returns a lens when a matching non-bulk entry has results.json directly', () => {
    const entryPath = require('path').join(resultsDir, 'demo---2026')
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    fs.existsSync.mockImplementation((p) => p === resultsDir || p === require('path').join(entryPath, 'results.json'))
    fs.readdirSync.mockReturnValue(['demo---2026'])
    fs.statSync.mockReturnValue({ isDirectory: () => true })

    const lenses = provideLenses()

    expect(lenses).toHaveLength(1)
    expect(lenses[0].command).toEqual({
      title: '$(graph) View Playback Results',
      command: 'salesforce-ui-script-recorder.viewResults',
      arguments: [vscode.Uri.file(specPath)]
    })
  })

  it('returns a lens when a matching bulk entry has a session subfolder with results.json', () => {
    const path = require('path')
    const entryPath = path.join(resultsDir, 'demo---2026---BULK')
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    fs.existsSync.mockImplementation((p) => (
      p === resultsDir ||
      p === path.join(entryPath, 'session-2', 'results.json')
    ))
    fs.readdirSync.mockImplementation((dir) => (dir === resultsDir ? ['demo---2026---BULK'] : ['session-1', 'session-2']))
    fs.statSync.mockReturnValue({ isDirectory: () => true })

    expect(provideLenses()).toHaveLength(1)
  })

  it('returns no lens when a matching bulk entry has no session subfolder with results.json', () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    fs.existsSync.mockImplementation((p) => p === resultsDir)
    fs.readdirSync.mockImplementation((dir) => (dir === resultsDir ? ['demo---2026---BULK'] : ['session-1']))
    fs.statSync.mockReturnValue({ isDirectory: () => true })

    expect(provideLenses()).toEqual([])
  })
})

describe('results lens combined with parameterize lenses', () => {
  it('prepends the results lens before parameterize lenses when both apply', () => {
    const path = require('path')
    const specPath = '/ws/test-plans/playwright/demo.spec.js'
    const jsonPath = '/ws/test-plans/playwright/demo.json'
    const resultsDir = '/ws/playback-results'
    const entryPath = path.join(resultsDir, 'demo---2026')

    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }]
    fs.existsSync.mockImplementation((p) => (
      p === resultsDir ||
      p === path.join(entryPath, 'results.json') ||
      p === jsonPath
    ))
    fs.readdirSync.mockReturnValue(['demo---2026'])
    fs.statSync.mockReturnValue({ isDirectory: () => true })
    fs.readFileSync.mockReturnValue(JSON.stringify({ steps: [{ type: 'change', selectors: [['#plain']] }] }))

    const provider = new RecordingCodeLensProvider()
    const document = makeDocument(specPath, "await page.fill('#plain', 'x')")

    const lenses = provider.provideCodeLenses(document)

    expect(lenses).toHaveLength(2)
    expect(lenses[0].command.command).toBe('salesforce-ui-script-recorder.viewResults')
    expect(lenses[1].command.command).toBe('salesforce-ui-script-recorder.parameterizeStep')
  })
})

// findStepPositions (recording-codelens-provider.js:182-236) is dead code: it is
// defined but never called anywhere in this file (or exported - module.exports
// only exposes RecordingCodeLensProvider), and nothing else in the extension
// imports it. There is no reachable path to exercise it.
