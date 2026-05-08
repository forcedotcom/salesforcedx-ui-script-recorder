export function getImportsAndDeclarations() {
  return `
import { test } from '@playwright/test';
import config from '../config/config';

test.use({
      launchOptions: {
            args: ['--disable-notifications', '--deny-permission-prompts'],
      },
      permissions: [],
});

`
}
