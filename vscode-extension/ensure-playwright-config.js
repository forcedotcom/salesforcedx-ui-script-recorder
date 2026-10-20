/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

const fs = require('fs');
const path = require('path');

const PLAYWRIGHT_CONFIG_CONTENT = `import { defineConfig } from '@playwright/test'
import fs from 'fs'

const authStatePath = process.env.SALESFORCE_UI_SCRIPT_RECORDER_AUTH_STATE || ''
const hasAuthState = authStatePath && fs.existsSync(authStatePath)
const headless = process.env.SALESFORCE_UI_SCRIPT_RECORDER_HEADLESS === '1'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.js',
  timeout: 0,
  outputDir: './.salesforce-ui-script-recorder/test-output',
  reporter: [
    ['list'],
    ['./.salesforce-ui-script-recorder/reporter.js'],
  ],
  use: {
    headless,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 120000,
    screenshot: 'only-on-failure',
    ...(hasAuthState && { storageState: authStatePath }),
  },
})
`;

// Env var / directory names used before the "naming consistency" rename.
// Configs scaffolded prior to that rename still reference these, and since
// the old env var names are never set by the extension anymore, `headless`
// in those configs permanently evaluates to false regardless of the
// record/playback UI's headed/headless toggle.
const LEGACY_NAME_REPLACEMENTS = [
  [/SF_UI_RECORDER_AUTH_STATE/g, 'SALESFORCE_UI_SCRIPT_RECORDER_AUTH_STATE'],
  [/SF_UI_RECORDER_HEADLESS/g, 'SALESFORCE_UI_SCRIPT_RECORDER_HEADLESS'],
  [/\.sf-ui-recorder\b/g, '.salesforce-ui-script-recorder'],
];

/**
 * Rename pre-rename env var / directory references to their current names.
 * No-op if none of the legacy names are present.
 *
 * @param {string} configText - Current contents of playwright.config.js
 * @returns {{ text: string, changed: boolean }}
 */
function upgradeConfigLegacyNames(configText) {
  let text = configText;
  let changed = false;
  for (const [pattern, replacement] of LEGACY_NAME_REPLACEMENTS) {
    const next = text.replace(pattern, replacement);
    if (next !== text) changed = true;
    text = next;
  }
  return { text, changed };
}

/**
 * Ensure an existing playwright.config.js captures screenshots on failure.
 *
 * The reporter copies image attachments into each run folder, but only if
 * Playwright is actually told to capture them. Configs scaffolded before the
 * screenshot feature existed (or hand-authored ones) lack `screenshot:` in
 * their `use:` block, so failures never produce a screenshot. This injects
 * `screenshot: 'only-on-failure',` into the first `use: {` block when no
 * `screenshot:` key is already present. It's a no-op if the setting exists
 * (any value) or no `use: {` block is found.
 *
 * @param {string} configText - Current contents of playwright.config.js
 * @returns {{ text: string, changed: boolean }}
 */
function upgradeConfigScreenshot(configText) {
  // Already configured (any value) — respect the user's choice, do nothing.
  if (/\bscreenshot\s*:/.test(configText)) {
    return { text: configText, changed: false };
  }

  // Insert right after the opening line of the first `use: {` block, matching
  // that line's indentation + one step so the new key lines up with siblings.
  const useBlock = /^([ \t]*)use\s*:\s*\{[ \t]*\r?\n/m;
  const match = useBlock.exec(configText);
  if (!match) {
    return { text: configText, changed: false };
  }

  const baseIndent = match[1];
  const childIndent = baseIndent + '  ';
  const insertAt = match.index + match[0].length;
  const injected = `${childIndent}screenshot: 'only-on-failure',\n`;
  const text = configText.slice(0, insertAt) + injected + configText.slice(insertAt);
  return { text, changed: true };
}

/**
 * Ensure a playwright.config.js and the results reporter exist in the target directory.
 * If they don't exist, scaffold them. If they already exist, leave the config alone
 * (aside from ensuring failure screenshots are enabled and renaming any pre-rename env
 * var / directory references) but always update the reporter (it ships with the extension).
 *
 * @param {string} workspaceRoot - The root directory of the user's workspace
 * @param {string} extensionPath - The extension's install directory
 */
function ensurePlaywrightConfig(workspaceRoot, extensionPath) {
  const configPath = path.join(workspaceRoot, 'playwright.config.js');
  let configCreated = false;
  let configUpgraded = false;

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, PLAYWRIGHT_CONFIG_CONTENT, 'utf-8');
    configCreated = true;
  } else {
    // Config predates (or omits) the failure-screenshot setting, or still references
    // pre-rename env var / directory names — upgrade it in place.
    try {
      const current = fs.readFileSync(configPath, 'utf-8');
      const legacyNames = upgradeConfigLegacyNames(current);
      const screenshot = upgradeConfigScreenshot(legacyNames.text);
      if (legacyNames.changed || screenshot.changed) {
        fs.writeFileSync(configPath, screenshot.text, 'utf-8');
        configUpgraded = true;
      }
    } catch {
      // Non-fatal: if we can't read/parse/write the config, leave it untouched.
    }
  }

  // Always sync the reporter from the extension into .salesforce-ui-script-recorder/
  const reporterSource = path.join(extensionPath, 'recorder-cli', 'src', 'reporter.js');
  const reporterDest = path.join(workspaceRoot, '.salesforce-ui-script-recorder', 'reporter.js');
  if (fs.existsSync(reporterSource)) {
    fs.mkdirSync(path.dirname(reporterDest), { recursive: true });
    fs.copyFileSync(reporterSource, reporterDest);
  }

  return { created: configCreated, upgraded: configUpgraded, path: configPath };
}

module.exports = { ensurePlaywrightConfig, upgradeConfigScreenshot, upgradeConfigLegacyNames };
