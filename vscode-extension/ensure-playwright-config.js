const fs = require('fs');
const path = require('path');

const PLAYWRIGHT_CONFIG_CONTENT = `import { defineConfig } from '@playwright/test'
import fs from 'fs'

const authStatePath = './auth-state.json'
const hasAuthState = fs.existsSync(authStatePath)

export default defineConfig({
  testDir: './recordings',
  timeout: 0,
  use: {
    headless: false,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 120000,
    ...(hasAuthState && { storageState: authStatePath }),
  },
})
`;

/**
 * Ensure a playwright.config.js exists in the target directory.
 * If it doesn't exist, scaffold one. If it already exists, leave it alone.
 *
 * @param {string} workspaceRoot - The root directory of the user's workspace
 */
function ensurePlaywrightConfig(workspaceRoot) {
  const configPath = path.join(workspaceRoot, 'playwright.config.js');

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, PLAYWRIGHT_CONFIG_CONTENT, 'utf-8');
    return { created: true, path: configPath };
  }

  return { created: false, path: configPath };
}

module.exports = { ensurePlaywrightConfig };
