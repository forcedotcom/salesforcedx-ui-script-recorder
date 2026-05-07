import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './recordings',
  timeout: 0,
  use: {
    headless: false,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 120000,
  },
})
