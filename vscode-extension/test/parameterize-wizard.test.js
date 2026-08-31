const vscode = require('vscode')
const { runParameterizeWizard } = require('../parameterize-wizard')

afterEach(() => {
  jest.clearAllMocks()
})

describe('runParameterizeWizard', () => {
  it('returns null when the mode picker is cancelled', async () => {
    vscode.window.showQuickPick.mockResolvedValue(undefined)
    const step = { type: 'click' }

    const result = await runParameterizeWizard(step)

    expect(result).toBeNull()
    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ title: 'Parameterize: Step (click)' })
    )
  })

  it('returns { remove: true } when Remove Parameterization is chosen', async () => {
    vscode.window.showQuickPick.mockResolvedValue({ label: 'Remove Parameterization' })
    const step = { type: 'click' }

    const result = await runParameterizeWizard(step)

    expect(result).toEqual({ remove: true })
    expect(vscode.window.showInputBox).not.toHaveBeenCalled()
  })

  it('returns null when Config Variable is chosen but the name prompt is cancelled', async () => {
    vscode.window.showQuickPick.mockResolvedValue({ label: 'Config Variable' })
    vscode.window.showInputBox.mockResolvedValue(undefined)
    const step = { type: 'click' }

    const result = await runParameterizeWizard(step)

    expect(result).toBeNull()
  })

  it('returns parameterise info when Config Variable is chosen and a name is entered', async () => {
    vscode.window.showQuickPick.mockResolvedValue({ label: 'Config Variable' })
    vscode.window.showInputBox.mockResolvedValue('my_name')
    const step = { type: 'click' }

    const result = await runParameterizeWizard(step)

    expect(result).toEqual({ parameterise: true, paramName: 'my_name' })
  })

  it('suggests a param name derived from the step label', async () => {
    vscode.window.showQuickPick.mockResolvedValue({ label: 'Config Variable' })
    vscode.window.showInputBox.mockResolvedValue('anything')
    const step = { type: 'change', selectors: [['aria/Email Address']] }

    await runParameterizeWizard(step)

    expect(vscode.window.showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'email_address' })
    )
  })

  it('falls back to "param_value" when the inferred name is empty after cleaning', async () => {
    vscode.window.showQuickPick.mockResolvedValue({ label: 'Config Variable' })
    vscode.window.showInputBox.mockResolvedValue('anything')
    const step = { type: 'change', selectors: [['aria/!!!']] }

    await runParameterizeWizard(step)

    expect(vscode.window.showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'param_value' })
    )
  })

  describe('validateInput', () => {
    async function getValidateInput() {
      vscode.window.showQuickPick.mockResolvedValue({ label: 'Config Variable' })
      vscode.window.showInputBox.mockResolvedValue('anything')
      await runParameterizeWizard({ type: 'click' })
      return vscode.window.showInputBox.mock.calls.at(-1)[0].validateInput
    }

    it('rejects an empty or whitespace-only value', async () => {
      const validateInput = await getValidateInput()

      expect(validateInput('')).toBe('Parameter name is required')
      expect(validateInput('   ')).toBe('Parameter name is required')
    })

    it('rejects a value that is not a valid identifier', async () => {
      const validateInput = await getValidateInput()

      expect(validateInput('123abc')).toBe('Must be a valid identifier')
      expect(validateInput('foo bar')).toBe('Must be a valid identifier')
    })

    it('accepts a valid identifier', async () => {
      const validateInput = await getValidateInput()

      expect(validateInput('foo_bar1')).toBeNull()
    })
  })
})
