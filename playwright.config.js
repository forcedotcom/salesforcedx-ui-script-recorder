import { defineConfig } from '@playwright/test'
import fs from 'fs'

const authStatePath = './auth-state.json'
const hasAuthState = fs.existsSync(authStatePath)

export default defineConfig({
  testDir: './test-plans/playwright',
  timeout: 0,
  use: {
    headless: false,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 120000,
    ...(hasAuthState && { storageState: authStatePath }),
  },
})
