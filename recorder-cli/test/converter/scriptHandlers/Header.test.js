import { getImportsAndDeclarations } from '../../../src/converter/scriptHandlers/Header.js'

describe('getImportsAndDeclarations', () => {
  it('returns the shared preamble with the config helper and CLI org login hook', () => {
    const output = getImportsAndDeclarations()

    expect(output).toContain("import { test, expect } from '@playwright/test';")
    expect(output).toContain('const config = {')
    expect(output).toContain('SALESFORCE_UI_SCRIPT_RECORDER_')
    expect(output).toContain('async function loginViaSalesforceCliOrg(page)')
    expect(output).toContain('function extractUrl(text)')
    expect(output).toContain('test.beforeEach(async ({ page }) => {')
  })
})

// The generated spec file is self-contained (no import of recorder-cli's own
// sf-cli.js), so extractUrl's logic is duplicated inline in the template
// above. Pull that function's source back out and run it directly to verify
// the actual runtime behavior, not just that the string is present.
describe('generated extractUrl', () => {
  function loadExtractUrl() {
    const output = getImportsAndDeclarations()
    const match = output.match(/function extractUrl\(text\) \{[\s\S]*?\n\}/)
    return new Function(`${match[0]}; return extractUrl;`)()
  }

  it('extracts the url from plain-text CLI output', () => {
    const extractUrl = loadExtractUrl()
    const stdout = 'Access org 00Dxx as user a@b.com with the following URL: https://x.my.salesforce.com/secur/frontdoor.jsp?sid=TOKEN\n'
    expect(extractUrl(stdout)).toBe('https://x.my.salesforce.com/secur/frontdoor.jsp?sid=TOKEN')
  })

  it('takes the last url when an unrelated docs link appears earlier in a warning banner', () => {
    const extractUrl = loadExtractUrl()
    const stdout =
      'For more info see https://developer.salesforce.com/docs/some-page.htm\n' +
      'Access org 00Dxx as user a@b.com with the following URL: https://x.my.salesforce.com/secur/frontdoor.jsp?sid=TOKEN\n'
    expect(extractUrl(stdout)).toBe('https://x.my.salesforce.com/secur/frontdoor.jsp?sid=TOKEN')
  })

  it('returns null when no url can be found', () => {
    const extractUrl = loadExtractUrl()
    expect(extractUrl('no links here')).toBeNull()
    expect(extractUrl('')).toBeNull()
  })
})
