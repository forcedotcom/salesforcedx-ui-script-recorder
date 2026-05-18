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
  // playback when the sfdc_lv2 device cookie is present via auth-state.json
  const cleanedData = stripVerificationSteps(data)

  const script = []

  const importsAndDeclarations = getImportsAndDeclarations()
  script.push(importsAndDeclarations)

  const scriptStart = `test('${cleanedData.title}', async ({ page }) => {`
  script.push(scriptStart)

  const testNoTimeOut = `test.setTimeout(0);`
  script.push(testNoTimeOut)

  const testGlobalTimeout = `page.setDefaultTimeout(${cleanedData.timeout || timeoutDuration});`
  script.push(testGlobalTimeout)

  const scriptActions = getScriptBody(cleanedData)
  script.push(scriptActions)

  const scriptEnd = `});`
  script.push(scriptEnd)

  // After each test, persist Salesforce device-identity cookies (especially sfdc_lv2)
  // to auth-state.json. On subsequent runs, Playwright injects these cookies via
  // storageState so that Salesforce recognises the browser as a trusted device and
  // skips the MFA verification prompt — enabling unattended playback.
  const afterEachHook = `
// Persist Salesforce device-identity cookies (especially sfdc_lv2) to auth-state.json.
// On subsequent runs, Playwright injects these cookies via storageState so that
// Salesforce recognises the browser as a trusted device and skips the MFA verification
// prompt — enabling unattended playback. Do not remove this block.
test.afterEach(async ({ context }) => {
  const fs = await import('fs');
  const DEVICE_COOKIE_NAMES = ['sfdc_lv2', 'BrowserId', 'BrowserId_sec', 'CookieConsentPolicy', 'LSKey-c\$CookieConsentPolicy'];
  try {
    const cookies = await context.cookies();
    const deviceCookies = cookies.filter((c) => DEVICE_COOKIE_NAMES.includes(c.name));
    if (deviceCookies.some((c) => c.name === 'sfdc_lv2')) {
      const deviceState = { cookies: deviceCookies, origins: [] };
      fs.writeFileSync('./auth-state.json', JSON.stringify(deviceState, null, 2));
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
