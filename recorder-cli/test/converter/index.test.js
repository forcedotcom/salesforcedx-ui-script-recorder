import { convertToPlaywright } from '../../src/converter/index.js'

describe('convertToPlaywright', () => {
  it('formats a full script with prettier and preserves the recorded steps', async () => {
    const data = {
      title: 'My Test',
      timeout: 5000,
      steps: [{ type: 'navigate', url: 'https://example.com' }]
    }

    const output = await convertToPlaywright(data)

    expect(output).toContain("test('My Test'")
    expect(output).toContain('page.setDefaultTimeout(5000)')
    expect(output).toContain("await page.goto('https://example.com')")
    expect(output).toContain('test.afterEach(async ({ page, context })')
    expect(output).toContain("import { test, expect } from '@playwright/test'")
  })

  it('falls back to the default timeout duration when the flow has none', async () => {
    const data = { title: 'No timeout', steps: [] }

    const output = await convertToPlaywright(data)

    expect(output).toContain('page.setDefaultTimeout(120000)')
  })

  it('strips verification steps before building the script', async () => {
    const exitEvent = { type: 'navigation', url: 'https://x.com/lightning/page' }
    const data = {
      title: 'Login',
      steps: [
        {
          type: 'click',
          selectors: [['#login-btn']],
          assertedEvents: [{ type: 'navigation', url: 'https://x.com/_ui/identity/verification' }]
        },
        { type: 'click', assertedEvents: [exitEvent] }
      ]
    }

    const output = await convertToPlaywright(data)

    expect(output).toContain("await page.waitForLoadState('domcontentloaded')")
    expect(output).not.toContain('identity/verification')
  })
})
