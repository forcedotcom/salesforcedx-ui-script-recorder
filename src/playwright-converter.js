/**
 * Playwright Script Converter
 *
 * Sends the structured JSON user flow to the conversion endpoint
 * and returns a Playwright test script.
 */

const CONVERSION_ENDPOINT = 'https://user-flow-converter.sfproxy.core002.dev1-uswest2.aws.sfdc.cl/convert'

/**
 * Converts a JSON user flow into a Playwright script via the remote conversion service.
 *
 * @param {object} userFlow - The structured JSON user flow (from generateUserFlow)
 * @param {object} [options] - Optional metadata
 * @param {string} [options.cloud] - Cloud identifier
 * @param {string} [options.user] - Username
 * @param {string} [options.team] - Team name
 * @returns {Promise<string>} - The Playwright script as text
 */
export async function convertToPlaywright(userFlow, options = {}) {
  const body = {
    payload: userFlow,
    cloud: options.cloud || '',
    user: options.user || '',
    team: options.team || '',
    script_type: 'playwright'
  }

  const res = await fetch(CONVERSION_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    let errorMsg = `HTTP ${res.status}`
    try {
      const errorBody = await res.json()
      errorMsg = errorBody.message || errorMsg
    } catch (e) {
      // Response wasn't JSON
    }
    throw new Error(`Playwright conversion failed: ${errorMsg}`)
  }

  let code = await res.text()

  // The conversion service generates imports with @/ path aliases
  // (e.g. @/config/config, @/utils/random). Rewrite them to relative
  // paths that resolve from the recordings/ directory.
  code = code.replace(/(['"])@\/([^'"]+)\1/g, "$1../$2$1")

  return code
}
