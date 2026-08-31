jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn()
}))

const vscode = require('vscode')
const fs = require('fs')
const { register } = require('../decorations')

function makeEditor(fileName, text) {
  return {
    document: { fileName, getText: jest.fn(() => text) },
    setDecorations: jest.fn()
  }
}

function registerAndCapture() {
  const context = { subscriptions: [] }
  register(context)
  const onDidChangeActiveTextEditor = vscode.window.onDidChangeActiveTextEditor.mock.calls.at(-1)[0]
  const onDidChangeTextDocument = vscode.workspace.onDidChangeTextDocument.mock.calls.at(-1)[0]
  return { context, onDidChangeActiveTextEditor, onDidChangeTextDocument }
}

afterEach(() => {
  jest.clearAllMocks()
  vscode.window.activeTextEditor = undefined
})

describe('register', () => {
  it('subscribes exactly two disposables', () => {
    const { context } = registerAndCapture()

    expect(context.subscriptions).toHaveLength(2)
  })

  it('does nothing at startup when there is no active editor', () => {
    vscode.window.activeTextEditor = undefined

    expect(() => registerAndCapture()).not.toThrow()
  })

  it('decorates the active editor immediately when one is already open at startup', () => {
    const editor = makeEditor('/ws/test-plans/playwright/recording.json', JSON.stringify({ steps: [] }))
    vscode.window.activeTextEditor = editor

    registerAndCapture()

    expect(editor.setDecorations).toHaveBeenCalled()
  })

  it('does nothing on the active-editor-changed event when the new editor is undefined', () => {
    const { onDidChangeActiveTextEditor } = registerAndCapture()

    expect(() => onDidChangeActiveTextEditor(undefined)).not.toThrow()
  })

  it('ignores a file name that matches neither the spec nor the json pattern', () => {
    const editor = makeEditor('/ws/README.md', 'irrelevant')
    const { onDidChangeActiveTextEditor } = registerAndCapture()

    onDidChangeActiveTextEditor(editor)

    expect(editor.setDecorations).not.toHaveBeenCalled()
  })

  it('re-decorates on document change only when the changed document belongs to the active editor', () => {
    const editor = makeEditor('/ws/test-plans/playwright/recording.json', JSON.stringify({ steps: [] }))
    vscode.window.activeTextEditor = editor
    const { onDidChangeTextDocument } = registerAndCapture()
    editor.setDecorations.mockClear()

    onDidChangeTextDocument({ document: { other: true } })
    expect(editor.setDecorations).not.toHaveBeenCalled()

    onDidChangeTextDocument({ document: editor.document })
    expect(editor.setDecorations).toHaveBeenCalled()
  })

  it('does nothing on document change when there is no active editor at all', () => {
    vscode.window.activeTextEditor = undefined
    const { onDidChangeTextDocument } = registerAndCapture()

    expect(() => onDidChangeTextDocument({ document: {} })).not.toThrow()
  })
})

describe('updateJsonDecorations (via a matching .json editor)', () => {
  it('does nothing when the document is not valid JSON', () => {
    const editor = makeEditor('/ws/recording.json', '{ not json')
    const { onDidChangeActiveTextEditor } = registerAndCapture()

    onDidChangeActiveTextEditor(editor)

    expect(editor.setDecorations).not.toHaveBeenCalled()
  })

  it('does nothing when the parsed JSON has no steps array', () => {
    const editor = makeEditor('/ws/recording.json', JSON.stringify({ foo: 'bar' }))
    const { onDidChangeActiveTextEditor } = registerAndCapture()

    onDidChangeActiveTextEditor(editor)

    expect(editor.setDecorations).not.toHaveBeenCalled()
  })

  it('decorates only the parameterized step, walking brace depth across lines', () => {
    const text = [
      '{',
      '  "steps": [',
      '    {',
      '      "params": { "parameterise": true }',
      '    },',
      '    {',
      '      "type": "click"',
      '    }',
      '  ]',
      '}'
    ].join('\n')
    const editor = makeEditor('/ws/recording.json', text)
    const { onDidChangeActiveTextEditor } = registerAndCapture()

    onDidChangeActiveTextEditor(editor)

    const [, decorations] = editor.setDecorations.mock.calls.at(-1)
    expect(decorations).toEqual([{ range: new vscode.Range(2, 0, 2, 0) }])
  })

  it('decorates a step whose opening brace shares the "steps": [ line', () => {
    const text = [
      '{',
      '  "steps": [{',
      '    "params": { "parameterise": true }',
      '  }]',
      '}'
    ].join('\n')
    const editor = makeEditor('/ws/recording.json', text)
    const { onDidChangeActiveTextEditor } = registerAndCapture()

    onDidChangeActiveTextEditor(editor)

    const [, decorations] = editor.setDecorations.mock.calls.at(-1)
    expect(decorations).toEqual([{ range: new vscode.Range(1, 0, 1, 0) }])
  })
})

describe('updateSpecDecorations (via a matching .spec.js editor)', () => {
  afterEach(() => {
    fs.existsSync.mockReset()
    fs.readFileSync.mockReset()
  })

  it('does nothing when the sibling .json file does not exist', () => {
    fs.existsSync.mockReturnValue(false)
    const editor = makeEditor('/ws/recording.spec.js', 'irrelevant')
    const { onDidChangeActiveTextEditor } = registerAndCapture()

    onDidChangeActiveTextEditor(editor)

    expect(editor.setDecorations).not.toHaveBeenCalled()
  })

  it('does nothing when the sibling .json file is not valid JSON', () => {
    fs.existsSync.mockReturnValue(true)
    fs.readFileSync.mockReturnValue('{ not json')
    const editor = makeEditor('/ws/recording.spec.js', 'irrelevant')
    const { onDidChangeActiveTextEditor } = registerAndCapture()

    onDidChangeActiveTextEditor(editor)

    expect(editor.setDecorations).not.toHaveBeenCalled()
  })

  it('does nothing when the parsed JSON has no steps array', () => {
    fs.existsSync.mockReturnValue(true)
    fs.readFileSync.mockReturnValue(JSON.stringify({ foo: 'bar' }))
    const editor = makeEditor('/ws/recording.spec.js', 'irrelevant')
    const { onDidChangeActiveTextEditor } = registerAndCapture()

    onDidChangeActiveTextEditor(editor)

    expect(editor.setDecorations).not.toHaveBeenCalled()
  })

  it('decorates page.fill lines for parameterized change steps, skipping non-fill lines and exhausted steps', () => {
    fs.existsSync.mockReturnValue(true)
    fs.readFileSync.mockReturnValue(JSON.stringify({
      steps: [
        { type: 'click' },
        { type: 'change', params: { parameterise: true } },
        { type: 'change' }
      ]
    }))
    const specText = [
      "test('recording', async ({ page }) => {",
      "  await page.fill('#a', 'x')",
      "  await page.click('#b')",
      "  await page.fill('#c', 'y')",
      "  await page.fill('#d', 'z')",
      '})'
    ].join('\n')
    const editor = makeEditor('/ws/recording.spec.js', specText)
    const { onDidChangeActiveTextEditor } = registerAndCapture()

    onDidChangeActiveTextEditor(editor)

    const [, decorations] = editor.setDecorations.mock.calls.at(-1)
    expect(decorations).toEqual([{ range: new vscode.Range(1, 0, 1, 0) }])
  })
})
