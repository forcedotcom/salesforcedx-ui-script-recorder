jest.mock('fs', () => ({
  existsSync: jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  copyFileSync: jest.fn()
}))

const fs = require('fs')
const path = require('path')
const { ensurePlaywrightConfig, upgradeConfigScreenshot, upgradeConfigLegacyNames } = require('../ensure-playwright-config')

describe('upgradeConfigScreenshot', () => {
  it('is a no-op when screenshot is already configured', () => {
    const text = "use: {\n  screenshot: 'off',\n}"

    expect(upgradeConfigScreenshot(text)).toEqual({ text, changed: false })
  })

  it('is a no-op when there is no use block', () => {
    const text = "export default defineConfig({ testDir: '.' })"

    expect(upgradeConfigScreenshot(text)).toEqual({ text, changed: false })
  })

  it('injects screenshot into the first use block, matching indentation', () => {
    const text = "export default defineConfig({\n  use: {\n    viewport: { width: 1280 },\n  },\n})"

    const { text: result, changed } = upgradeConfigScreenshot(text)

    expect(changed).toBe(true)
    expect(result).toContain("    screenshot: 'only-on-failure',\n    viewport")
  })
})

describe('upgradeConfigLegacyNames', () => {
  it('is a no-op when no legacy names are present', () => {
    const text = "const headless = process.env.SALESFORCE_UI_SCRIPT_RECORDER_HEADLESS === '1'"

    expect(upgradeConfigLegacyNames(text)).toEqual({ text, changed: false })
  })

  it('renames the pre-rename headless and auth-state env vars', () => {
    const text = [
      "const authStatePath = process.env.SF_UI_RECORDER_AUTH_STATE || ''",
      "const headless = process.env.SF_UI_RECORDER_HEADLESS === '1'",
    ].join('\n')

    const { text: result, changed } = upgradeConfigLegacyNames(text)

    expect(changed).toBe(true)
    expect(result).toContain('SALESFORCE_UI_SCRIPT_RECORDER_AUTH_STATE')
    expect(result).toContain('SALESFORCE_UI_SCRIPT_RECORDER_HEADLESS')
    expect(result).not.toContain('SF_UI_RECORDER_AUTH_STATE')
    expect(result).not.toContain('SF_UI_RECORDER_HEADLESS')
  })

  it('renames the pre-rename .sf-ui-recorder directory references', () => {
    const text = "outputDir: './.sf-ui-recorder/test-output',\nreporter: [['./.sf-ui-recorder/reporter.js']],"

    const { text: result, changed } = upgradeConfigLegacyNames(text)

    expect(changed).toBe(true)
    expect(result).toBe(
      "outputDir: './.salesforce-ui-script-recorder/test-output',\nreporter: [['./.salesforce-ui-script-recorder/reporter.js']],"
    )
  })
})

describe('ensurePlaywrightConfig', () => {
  const workspaceRoot = '/workspace'
  const extensionPath = '/ext'
  const configPath = path.join(workspaceRoot, 'playwright.config.js')
  const reporterSource = path.join(extensionPath, 'recorder-cli', 'src', 'reporter.js')
  const reporterDest = path.join(workspaceRoot, '.salesforce-ui-script-recorder', 'reporter.js')

  afterEach(() => jest.clearAllMocks())

  it('scaffolds a new config when none exists, and copies the reporter when present', () => {
    fs.existsSync.mockImplementation((p) => p === reporterSource)

    const result = ensurePlaywrightConfig(workspaceRoot, extensionPath)

    expect(result).toEqual({ created: true, upgraded: false, path: configPath })
    expect(fs.writeFileSync).toHaveBeenCalledWith(configPath, expect.stringContaining('defineConfig'), 'utf-8')
    expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(reporterDest), { recursive: true })
    expect(fs.copyFileSync).toHaveBeenCalledWith(reporterSource, reporterDest)
  })

  it('skips the reporter copy when the source does not exist', () => {
    fs.existsSync.mockReturnValue(false)

    ensurePlaywrightConfig(workspaceRoot, extensionPath)

    expect(fs.copyFileSync).not.toHaveBeenCalled()
    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })

  it('upgrades an existing config that is missing the screenshot setting', () => {
    fs.existsSync.mockImplementation((p) => p === configPath)
    fs.readFileSync.mockReturnValue('export default defineConfig({\n  use: {\n    viewport: {},\n  },\n})')

    const result = ensurePlaywrightConfig(workspaceRoot, extensionPath)

    expect(result).toEqual({ created: false, upgraded: true, path: configPath })
    expect(fs.writeFileSync).toHaveBeenCalledWith(configPath, expect.stringContaining('screenshot'), 'utf-8')
  })

  it('leaves an existing config untouched when it already configures screenshot', () => {
    fs.existsSync.mockImplementation((p) => p === configPath)
    fs.readFileSync.mockReturnValue("use: {\n  screenshot: 'off',\n}")

    const result = ensurePlaywrightConfig(workspaceRoot, extensionPath)

    expect(result).toEqual({ created: false, upgraded: false, path: configPath })
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it('upgrades a pre-rename config so the headless env var actually takes effect', () => {
    fs.existsSync.mockImplementation((p) => p === configPath)
    fs.readFileSync.mockReturnValue(
      "const headless = process.env.SF_UI_RECORDER_HEADLESS === '1'\n" +
      "use: {\n  headless,\n  screenshot: 'only-on-failure',\n}"
    )

    const result = ensurePlaywrightConfig(workspaceRoot, extensionPath)

    expect(result).toEqual({ created: false, upgraded: true, path: configPath })
    const written = fs.writeFileSync.mock.calls.find((c) => c[0] === configPath)[1]
    expect(written).toContain('SALESFORCE_UI_SCRIPT_RECORDER_HEADLESS')
    expect(written).not.toContain('SF_UI_RECORDER_HEADLESS')
  })

  it('swallows errors thrown while reading or upgrading an existing config', () => {
    fs.existsSync.mockImplementation((p) => p === configPath)
    fs.readFileSync.mockImplementation(() => { throw new Error('EACCES') })

    expect(() => ensurePlaywrightConfig(workspaceRoot, extensionPath)).not.toThrow()
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })
})
