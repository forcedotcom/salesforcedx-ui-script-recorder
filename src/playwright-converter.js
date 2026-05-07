/**
 * Playwright Script Converter
 *
 * Converts a JSON user flow to a Playwright test script locally.
 * Ported from user-flow-converter service — no external endpoint needed.
 */
import { convertToPlaywright as convert } from './converter/index.js'

/**
 * Converts a JSON user flow into a Playwright script.
 *
 * @param {object} userFlow - The structured JSON user flow (from generateUserFlow)
 * @param {object} [options] - Optional metadata (unused currently, kept for API compat)
 * @returns {Promise<string>} - The Playwright script as text
 */
export async function convertToPlaywright(userFlow, options = {}) {
  return await convert(userFlow)
}
