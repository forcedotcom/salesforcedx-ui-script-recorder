/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

export function getImportsAndDeclarations() {
  return `
import { test, expect } from '@playwright/test';

// --- Config provider (do not edit) ---
const config = {
      get(key) {
            const envKey = \`SALESFORCE_UI_SCRIPT_RECORDER_\${key.toUpperCase()}\`;
            const value = process.env[envKey];
            if (!value) {
                  throw new Error(\`Missing config "\${key}". Set environment variable \${envKey} before running the test.\`);
            }
            return value;
      }
};

// --- Delay utility (do not edit) ---
const delay = (ms) => {
      return new Promise((resolve) => setTimeout(resolve, ms));
};

// --- Browser configuration (do not edit) ---
test.use({
      launchOptions: {
            args: ['--disable-notifications', '--deny-permission-prompts'],
      },
      permissions: [],
});

`
}
