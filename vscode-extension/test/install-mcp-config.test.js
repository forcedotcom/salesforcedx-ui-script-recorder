jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn()
}))

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { register } = require('../commands/install-mcp-config')

function settingsPathFor(baseDir) {
  return path.join(baseDir, 'Code', 'User', 'globalStorage', 'salesforce.salesforcedx-einstein-gpt', 'settings', 'a4d_mcp_settings.json')
}

const SETTINGS_PATH = settingsPathFor(path.join('/home/user', '.config'))
const MCP_ENTRY = { type: 'stdio', command: 'node', args: [path.join('/ext', 'mcp-server', 'index.js')] }

let originalPlatform
let originalEnv

beforeEach(() => {
  originalPlatform = process.platform
  originalEnv = process.env
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  process.env = { HOME: '/home/user' }
  fs.existsSync.mockReturnValue(false)
})

afterEach(() => {
  jest.clearAllMocks()
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  process.env = originalEnv
})

function getHandler() {
  register({ extensionPath: '/ext' })
  return vscode.commands.registerCommand.mock.calls.at(-1)[1]
}

describe('installAgentforceMcpConfig command', () => {
  it('creates the settings directory', async () => {
    const handler = getHandler()

    await handler()

    expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(SETTINGS_PATH), { recursive: true })
  })

  it('creates a fresh settings file with the mcp entry when none exists', async () => {
    const handler = getHandler()

    await handler()

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      SETTINGS_PATH,
      JSON.stringify({ mcpServers: { 'salesforce-ui-script-recorder': MCP_ENTRY } }, null, 2),
      'utf-8'
    )
  })

  it('treats whitespace-only existing file content as an empty object', async () => {
    fs.existsSync.mockReturnValue(true)
    fs.readFileSync.mockReturnValue('   ')
    const handler = getHandler()

    await handler()

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      SETTINGS_PATH,
      JSON.stringify({ mcpServers: { 'salesforce-ui-script-recorder': MCP_ENTRY } }, null, 2),
      'utf-8'
    )
  })

  it('preserves unrelated top-level keys from the existing settings file', async () => {
    fs.existsSync.mockReturnValue(true)
    fs.readFileSync.mockReturnValue(JSON.stringify({ unrelated: 'keep-me' }))
    const handler = getHandler()

    await handler()

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      SETTINGS_PATH,
      JSON.stringify({ unrelated: 'keep-me', mcpServers: { 'salesforce-ui-script-recorder': MCP_ENTRY } }, null, 2),
      'utf-8'
    )
  })

  it('merges into existing mcpServers, preserving other server entries', async () => {
    fs.existsSync.mockReturnValue(true)
    fs.readFileSync.mockReturnValue(JSON.stringify({ mcpServers: { other: { type: 'stdio' } } }))
    const handler = getHandler()

    await handler()

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      SETTINGS_PATH,
      JSON.stringify({ mcpServers: { other: { type: 'stdio' }, 'salesforce-ui-script-recorder': MCP_ENTRY } }, null, 2),
      'utf-8'
    )
  })

  it('overwrites a pre-existing entry for this same server', async () => {
    fs.existsSync.mockReturnValue(true)
    fs.readFileSync.mockReturnValue(JSON.stringify({ mcpServers: { 'salesforce-ui-script-recorder': { type: 'stdio', command: 'old' } } }))
    const handler = getHandler()

    await handler()

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      SETTINGS_PATH,
      JSON.stringify({ mcpServers: { 'salesforce-ui-script-recorder': MCP_ENTRY } }, null, 2),
      'utf-8'
    )
  })

  it.each([
    ['a string', 'not-an-object'],
    ['null', null],
    ['an array', ['not-an-object']]
  ])('shows an error and does not write when mcpServers is %s', async (_label, badValue) => {
    fs.existsSync.mockReturnValue(true)
    fs.readFileSync.mockReturnValue(JSON.stringify({ mcpServers: badValue }))
    const handler = getHandler()

    await handler()

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Salesforce UI Script Recorder: Expected "mcpServers" to be an object in Agentforce MCP settings.'
    )
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it('shows an error when the existing settings file is not valid JSON', async () => {
    fs.existsSync.mockReturnValue(true)
    fs.readFileSync.mockReturnValue('{ not json')
    const handler = getHandler()

    await handler()

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Salesforce UI Script Recorder: Failed to install Agentforce MCP config:')
    )
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it('shows an error when creating the settings directory throws', async () => {
    fs.mkdirSync.mockImplementationOnce(() => { throw new Error('EACCES') })
    const handler = getHandler()

    await handler()

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Salesforce UI Script Recorder: Failed to install Agentforce MCP config:')
    )
  })

  it('opens the settings file when "Open File" is chosen from the success message', async () => {
    vscode.window.showInformationMessage.mockResolvedValueOnce('Open File')
    const handler = getHandler()

    await handler()
    await Promise.resolve()

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.open', vscode.Uri.file(SETTINGS_PATH))
  })

  it('does not open the settings file for any other choice', async () => {
    vscode.window.showInformationMessage.mockResolvedValueOnce(undefined)
    const handler = getHandler()

    await handler()
    await Promise.resolve()

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
  })
})

describe('installAgentforceMcpConfig command — platform-specific settings path', () => {
  function expectSettingsDir(baseDir) {
    expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(settingsPathFor(baseDir)), { recursive: true })
  }

  it('uses the macOS Application Support path when HOME is set', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    process.env = { HOME: '/Users/demo' }
    const handler = getHandler()

    await handler()

    expectSettingsDir(path.join('/Users/demo', 'Library', 'Application Support'))
  })

  it('falls back to an empty HOME on macOS when unset', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    process.env = {}
    const handler = getHandler()

    await handler()

    expectSettingsDir(path.join('', 'Library', 'Application Support'))
  })

  it('uses APPDATA directly on Windows when set', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env = { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' }
    const handler = getHandler()

    await handler()

    expectSettingsDir('C:\\Users\\demo\\AppData\\Roaming')
  })

  it('falls back to USERPROFILE/AppData/Roaming on Windows when APPDATA is unset', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env = { USERPROFILE: 'C:\\Users\\demo' }
    const handler = getHandler()

    await handler()

    expectSettingsDir(path.join('C:\\Users\\demo', 'AppData', 'Roaming'))
  })

  it('falls back to an empty USERPROFILE on Windows when both are unset', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env = {}
    const handler = getHandler()

    await handler()

    expectSettingsDir(path.join('', 'AppData', 'Roaming'))
  })

  it('uses XDG_CONFIG_HOME directly on Linux when set', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env = { XDG_CONFIG_HOME: '/custom/config' }
    const handler = getHandler()

    await handler()

    expectSettingsDir('/custom/config')
  })

  it('falls back to an empty HOME on Linux when both are unset', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env = {}
    const handler = getHandler()

    await handler()

    expectSettingsDir(path.join('', '.config'))
  })
})
