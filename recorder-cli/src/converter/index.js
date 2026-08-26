/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * Local Playwright script converter.
 * Ported from user-flow-converter — converts JSON user flow to Playwright test code.
 */
import { getImportsAndDeclarations } from './scriptHandlers/Header.js'
import { getScriptBody } from './buildPlaywrightScript.js'
import { timeoutDuration } from './constants.js'
import { stripVerificationSteps } from './stripVerificationSteps.js'

/**
 * Convert a JSON user flow object to a Playwright test script string.
 *
 * @param {object} data - The user flow JSON (title, steps, timeout, etc.)
 * @returns {Promise<string>} - Formatted Playwright test script
 */
export async function convertToPlaywright(data) {
  // Strip Salesforce identity verification steps — they are not needed on
  // playback when the sfdc_lv2 device cookie is present via auth-states/
  const cleanedData = stripVerificationSteps(data)

  const script = []

  const importsAndDeclarations = getImportsAndDeclarations()
  script.push(importsAndDeclarations)

  const scriptStart = `test('${cleanedData.title}', async ({ page }) => {`
  script.push(scriptStart)

  script.push(`// --- Test setup ---`)

  const testNoTimeOut = `test.setTimeout(0);`
  script.push(testNoTimeOut)

  const testGlobalTimeout = `page.setDefaultTimeout(${cleanedData.timeout || timeoutDuration});`
  script.push(testGlobalTimeout)

  script.push(`// --- Recorded steps ---`)

  const scriptActions = getScriptBody(cleanedData)
  script.push(scriptActions)

  script.push(`// --- End of recorded steps ---`)

  const scriptEnd = `});`
  script.push(scriptEnd)

  script.push(`// --- Auth state persistence (do not edit) ---`)

  // After each test, persist Salesforce device-identity cookies (especially sfdc_lv2)
  // to auth-states/<hostname>---<username>.json. On subsequent runs, Playwright injects
  // these cookies via storageState so that Salesforce recognises the browser as a trusted
  // device and skips the MFA verification prompt — enabling unattended playback.
  const afterEachHook = `
test.afterEach(async ({ page, context }) => {
  const fs = await import('fs');
  const path = await import('path');
  const DEVICE_COOKIE_NAMES = ['sfdc_lv2', 'BrowserId', 'BrowserId_sec', 'CookieConsentPolicy', 'LSKey-c\$CookieConsentPolicy'];
  try {
    const cookies = await context.cookies();
    const deviceCookies = cookies.filter((c) => DEVICE_COOKIE_NAMES.includes(c.name));
    if (deviceCookies.some((c) => c.name === 'sfdc_lv2')) {
      const deviceState = { cookies: deviceCookies, origins: [] };
      const hostname = new URL(page.url()).hostname;
      const username = (process.env.SALESFORCE_UI_SCRIPT_RECORDER_USERNAME || process.env.SALESFORCE_UI_SCRIPT_RECORDER_EMAIL || 'default').replace(/[\\/\\\\:*?"<>|]/g, '_');
      const authDir = './auth-states';
      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(path.join(authDir, \`\${hostname}---\${username}.json\`), JSON.stringify(deviceState, null, 2));
    }
  } catch (e) {
    // Browser may already be closed — non-fatal
  }
});`
  script.push(afterEachHook)

  let output = script.join('\n')

  // Try to format with prettier if available
  try {
    const prettier = await import('prettier')
    output = await prettier.default.format(output, {
      semi: true,
      parser: 'babel',
      singleQuote: true,
      tabWidth: 6,
    })
  } catch (e) {
    // prettier not installed — return unformatted
  }

  return output
}
