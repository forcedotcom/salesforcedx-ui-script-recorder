jest.mock('../parameterize-wizard', () => ({ runParameterizeWizard: jest.fn() }))

const vscode = require('vscode')
const { runParameterizeWizard } = require('../parameterize-wizard')
const { register } = require('../commands/parameterize')

const documentUri = vscode.Uri.file('/ws/test-plans/playwright/demo.json')

afterEach(() => {
  jest.clearAllMocks()
})

function setDocumentText(text) {
  vscode.workspace.openTextDocument.mockResolvedValue(
    vscode.__factories.makeTextDocument({ getText: jest.fn(() => text) })
  )
}

function getHandler(codeLensProvider = { refresh: jest.fn() }) {
  register({}, codeLensProvider)
  const handler = vscode.commands.registerCommand.mock.calls.at(-1)[1]
  return { handler, codeLensProvider }
}

describe('parameterizeStep command', () => {
  it('shows an error and stops when the document is not valid JSON', async () => {
    setDocumentText('{ not json')
    const { handler } = getHandler()

    await handler(documentUri, 0)

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Could not parse recording JSON.')
    expect(runParameterizeWizard).not.toHaveBeenCalled()
  })

  it('shows an error and stops when the step at stepIndex does not exist', async () => {
    setDocumentText(JSON.stringify({ steps: [] }))
    const { handler } = getHandler()

    await handler(documentUri, 0)

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Step not found.')
    expect(runParameterizeWizard).not.toHaveBeenCalled()
  })

  it('makes no changes when the wizard is cancelled', async () => {
    setDocumentText(JSON.stringify({ steps: [{ type: 'click' }] }))
    runParameterizeWizard.mockResolvedValue(null)
    const { handler } = getHandler()

    await handler(documentUri, 0)

    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled()
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
  })

  it('applies a config-variable parameterization and reconverts', async () => {
    setDocumentText(JSON.stringify({ steps: [{ type: 'click' }] }))
    runParameterizeWizard.mockResolvedValue({ parameterise: true, paramName: 'my_param' })
    const { handler, codeLensProvider } = getHandler()

    await handler(documentUri, 0)

    const editArg = vscode.workspace.applyEdit.mock.calls[0][0]
    const updated = JSON.parse(editArg.edits[0].newText)
    expect(updated.steps[0].params).toEqual({ parameterise: true, paramName: 'my_param' })
    expect(editArg.edits[0].uri).toBe(documentUri)
    expect(codeLensProvider.refresh).toHaveBeenCalled()
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Step parameterized — Config: my_param')
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('salesforce-ui-script-recorder.reconvert', documentUri)
  })

  it('shows the generic "Parameterized" status when the wizard result has no paramName', async () => {
    setDocumentText(JSON.stringify({ steps: [{ type: 'click' }] }))
    runParameterizeWizard.mockResolvedValue({ parameterise: true })
    const { handler } = getHandler()

    await handler(documentUri, 0)

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Step parameterized — Parameterized')
  })

  it('removes parameterization and shows the removal message', async () => {
    setDocumentText(JSON.stringify({ steps: [{ type: 'click', params: { parameterise: true, paramName: 'old' } }] }))
    runParameterizeWizard.mockResolvedValue({ remove: true })
    const { handler } = getHandler()

    await handler(documentUri, 0)

    const editArg = vscode.workspace.applyEdit.mock.calls[0][0]
    const updated = JSON.parse(editArg.edits[0].newText)
    expect(updated.steps[0].params).toBeUndefined()
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Salesforce UI Script Recorder: Parameterization removed.')
  })
})
