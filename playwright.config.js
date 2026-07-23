import { defineConfig } from '@playwright/test'
import fs from 'fs'

const authStatePath = './auth-state.json'
const hasAuthState = fs.existsSync(authStatePath)

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.js',
  timeout: 0,
  reporter: [
    ['list'],
    ['./.sf-ui-recorder/reporter.js'],
  ],
  use: {
    headless: false,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 120000,
    screenshot: 'only-on-failure',
    ...(hasAuthState && { storageState: authStatePath }),
  },
})
