/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

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
