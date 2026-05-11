export function getImportsAndDeclarations() {
  return `
import { test } from '@playwright/test';
import config from './config/config';
import random from './utils/random';

const delay = (ms) => {
      return new Promise((resolve) => setTimeout(resolve, ms));
};

test.use({
      launchOptions: {
            args: ['--disable-notifications', '--deny-permission-prompts'],
      },
      permissions: [],
});

`
}
