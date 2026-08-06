/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

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
