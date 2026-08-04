export function getImportsAndDeclarations() {
  return `
import { test, expect } from '@playwright/test';

// --- Config provider (do not edit) ---
const config = {
      get(key) {
            const envKey = \`SF_UI_RECORDER_\${key.toUpperCase()}\`;
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
