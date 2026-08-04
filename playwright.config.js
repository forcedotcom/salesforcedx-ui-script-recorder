import { defineConfig } from '@playwright/test'
import fs from 'fs'

const authStatePath = process.env.SF_UI_RECORDER_AUTH_STATE || ''
const hasAuthState = authStatePath && fs.existsSync(authStatePath)
const headless = process.env.SF_UI_RECORDER_HEADLESS === '1'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.js',
  timeout: 0,
  outputDir: './.sf-ui-recorder/test-output',
  reporter: [
    ['list'],
    ['./.sf-ui-recorder/reporter.js'],
  ],
  use: {
    headless,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 120000,
    screenshot: 'only-on-failure',
    ...(hasAuthState && { storageState: authStatePath }),
  },
})
