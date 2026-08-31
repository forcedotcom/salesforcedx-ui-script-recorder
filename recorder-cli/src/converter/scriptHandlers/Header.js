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
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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

// --- Salesforce CLI org login (do not edit) ---
// When SALESFORCE_UI_SCRIPT_RECORDER_ORG is set, this logs the browser
// into that org via the Salesforce CLI's already-authenticated session
// (no username/password/MFA needed) before the recorded steps run. The
// CLI issues a fresh, short-lived login URL on every run, so nothing is
// stored — if the env var is unset, this is a no-op and the recorded
// steps below (with any saved auth-state / credential fills) run as-is.
async function loginViaSalesforceCliOrg(page) {
      const org = process.env.SALESFORCE_UI_SCRIPT_RECORDER_ORG;
      if (!org) return;

      let stdout;
      try {
            ({ stdout } = await execFileAsync('sf', ['org', 'open', '-o', org, '--url-only', '--json']));
      } catch (err) {
            if (err.code === 'ENOENT') {
                  throw new Error('Salesforce CLI ("sf") not found on PATH. Install it and run "sf org login web" to authenticate, then try again.');
            }
            throw err;
      }

      const start = stdout.indexOf('{');
      const end = stdout.lastIndexOf('}');
      const parsed = start !== -1 && end !== -1 ? JSON.parse(stdout.slice(start, end + 1)) : null;
      const url = parsed?.result?.url;
      if (!url) {
            throw new Error(\`"sf org open -o \${org} --url-only" did not return a URL. Run "sf org login web -o \${org}" and try again.\`);
      }
      await page.goto(url);
}

test.beforeEach(async ({ page }) => {
      await loginViaSalesforceCliOrg(page);
});

`
}
