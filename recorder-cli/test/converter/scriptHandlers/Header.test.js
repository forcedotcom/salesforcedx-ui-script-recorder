import { getImportsAndDeclarations } from '../../../src/converter/scriptHandlers/Header.js'

describe('getImportsAndDeclarations', () => {
  it('returns the shared preamble with the config helper and CLI org login hook', () => {
    const output = getImportsAndDeclarations()

    expect(output).toContain("import { test, expect } from '@playwright/test';")
    expect(output).toContain('const config = {')
    expect(output).toContain('SALESFORCE_UI_SCRIPT_RECORDER_')
    expect(output).toContain('async function loginViaSalesforceCliOrg(page)')
    expect(output).toContain('test.beforeEach(async ({ page }) => {')
  })
})
