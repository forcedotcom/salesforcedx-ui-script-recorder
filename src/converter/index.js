/**
 * Local Playwright script converter.
 * Ported from user-flow-converter — converts JSON user flow to Playwright test code.
 */
import { getImportsAndDeclarations } from './scriptHandlers/Header.js'
import { getScriptBody } from './buildPlaywrightScript.js'
import { timeoutDuration } from './constants.js'

/**
 * Convert a JSON user flow object to a Playwright test script string.
 *
 * @param {object} data - The user flow JSON (title, steps, timeout, etc.)
 * @returns {Promise<string>} - Formatted Playwright test script
 */
export async function convertToPlaywright(data) {
  const script = []

  const importsAndDeclarations = getImportsAndDeclarations()
  script.push(importsAndDeclarations)

  const delay = `const delay = (ms) => {
      return new Promise((resolve) => setTimeout(resolve, ms));
};`
  script.push(delay)

  const scriptStart = `test('${data.title}', async ({ page }) => {`
  script.push(scriptStart)

  const testNoTimeOut = `test.setTimeout(0);`
  script.push(testNoTimeOut)

  const testGlobalTimeout = `page.setDefaultTimeout(${data.timeout || timeoutDuration});`
  script.push(testGlobalTimeout)

  const scriptActions = getScriptBody(data)
  script.push(scriptActions)

  const scriptEnd = `});`
  script.push(scriptEnd)

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
